import { getDb } from "./db";
import { jobPostings, users, jobSearches } from "../db/schema";
import { eq, desc, and, or, isNull, notLike } from "drizzle-orm";

export interface RecommendedJob {
  id: string;
  jobTitle: string;
  description: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  locationCity: string | null;
  locationRemote: boolean | null;
  employmentType: string | null;
  experienceLevel: string | null;
  applicationsCount: number | null;
  publishedAt: Date | null;
  companyName: string | null;
  companyIndustry: string | null;
  matchScore: number;
  hasProfile: boolean;
  matchReasons: string[]; // e.g. ["skill:react", "title:developer", "location:remote"]
}

// ─── Profile Signal Types ───
interface ProfileSignals {
  skillKeywords: string[];        // from skills array (weight: 5)
  titleKeywords: string[];        // from work experience job titles + headline (weight: 4)
  experienceSkills: string[];     // from work experience skillsUsed fields (weight: 3)
  bioKeywords: string[];          // from bio/headline text (weight: 2)
  educationKeywords: string[];    // from education courses (weight: 1)
  searchKeywords: string[];       // from recent search history (weight: 3)
  location: string | null;
  experienceYears: number | null;
  hasProfile: boolean;
}

// ─── Keyword extraction helpers ───

/** Split text into meaningful tokens (2+ chars), removing stopwords */
function extractTokens(text: string): string[] {
  if (!text) return [];
  const stopwords = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has',
    'her', 'was', 'one', 'our', 'out', 'with', 'they', 'been', 'have',
    'from', 'this', 'that', 'will', 'your', 'what', 'when', 'make', 'like',
    'time', 'very', 'more', 'also', 'than', 'them', 'some', 'each', 'just',
    'about', 'would', 'there', 'their', 'which', 'could', 'other', 'into',
    'then', 'only', 'these', 'work', 'working', 'using', 'used', 'etc',
    'experience', 'years', 'looking', 'role', 'company', 'team', 'join',
    'strong', 'good', 'well', 'based', 'including', 'must', 'should',
    'able', 'open', 'plus', 'such', 'need', 'help',
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9#+.]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !stopwords.has(t));
}

/** Parse JSON array safely, with comma-fallback */
function parseJsonArray(val: any): string[] {
  if (!val) return [];
  try {
    const parsed = typeof val === 'string' ? JSON.parse(val) : val;
    return Array.isArray(parsed) ? parsed.map(s => String(s).trim()).filter(Boolean) : [];
  } catch {
    return typeof val === 'string' ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
  }
}

// ─── Build Profile Signals ───
function buildProfileSignals(
  employee: {
    skills: any;
    experienceYears: number | null | undefined;
    location: string | null | undefined;
    headline?: string | null;
    bio?: string | null;
    workExperience?: any;
    education?: any;
  },
  searchHistory: string[]
): ProfileSignals {
  // 1. Skills (highest priority)
  const skills = parseJsonArray(employee.skills).map(s => s.toLowerCase());

  // 2. Work experience job titles + skills used
  const workExp = parseJsonArray(employee.workExperience);
  const titleKeywords: string[] = [];
  const experienceSkills: string[] = [];

  for (const exp of workExp) {
    if (exp.jobTitle) {
      titleKeywords.push(...extractTokens(exp.jobTitle));
    }
    if (exp.skillsUsed) {
      const expSkills = exp.skillsUsed.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
      experienceSkills.push(...expSkills);
    }
    if (exp.description) {
      // Extract only technical terms from descriptions, not entire text
      const tokens = extractTokens(exp.description);
      experienceSkills.push(...tokens.filter(t => t.length >= 3));
    }
  }

  // 3. Headline keywords
  const headlineTokens = extractTokens(employee.headline || '');
  titleKeywords.push(...headlineTokens);

  // 4. Bio keywords
  const bioKeywords = extractTokens(employee.bio || '').filter(t => t.length >= 3);

  // 5. Education keywords
  const edu = parseJsonArray(employee.education);
  const educationKeywords: string[] = [];
  for (const e of edu) {
    if (e.course || e.degree) {
      educationKeywords.push(...extractTokens(e.course || e.degree || ''));
    }
  }

  // 6. Search history
  const searchKeywords = searchHistory
    .map(s => s.toLowerCase().trim())
    .filter(s => s.length > 2);

  const hasProfile = skills.length > 0 ||
    titleKeywords.length > 0 ||
    (employee.experienceYears !== null && employee.experienceYears !== undefined) ||
    Boolean(employee.location && employee.location.trim().length > 0) ||
    bioKeywords.length > 0;

  return {
    skillKeywords: [...new Set(skills)],
    titleKeywords: [...new Set(titleKeywords)],
    experienceSkills: [...new Set(experienceSkills)],
    bioKeywords: [...new Set(bioKeywords)],
    educationKeywords: [...new Set(educationKeywords)],
    searchKeywords: [...new Set(searchKeywords)],
    location: employee.location?.trim() || null,
    experienceYears: employee.experienceYears ?? null,
    hasProfile,
  };
}

// ─── Helper to check word boundaries ───
function isTokenMatch(text: string, token: string): boolean {
  if (token.length <= 2) {
    // For very short tokens (e.g. "go", "c", "it"), strictly require word boundaries
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  }
  // For longer tokens, we still want to avoid "sale" matching "salesforce", but "sale" can match "sales"
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\b|\\b${escaped}s\\b|\\b${escaped}es\\b`, 'i');
  return regex.test(text);
}

// ─── Score a single job against profile ───
function scoreJob(
  job: {
    jobTitle: string;
    description: string;
    requirements?: string[] | string | null;
    locationCity: string | null;
    locationRemote: boolean | null;
    experienceLevel: string | null;
    employmentType: string | null;
    publishedAt: Date | null;
  },
  signals: ProfileSignals
): { score: number; reasons: string[] } {
  const jobTitleLower = job.jobTitle.toLowerCase();
  const jobDescLower = (job.description || '').replace(/<[^>]*>/g, '').toLowerCase();
  const jobFullText = `${jobTitleLower} ${jobDescLower}`;

  // Parse job requirements
  const jobReqs = parseJsonArray(job.requirements).map(r => r.toLowerCase());

  const reasons: string[] = [];
  let totalScore = 0;

  // ─── PILLAR 1: Skill Match (Max 40 pts) ───
  let skillMatches = 0;
  let titleSkillMatches = 0;
  const matchedSkillSet = new Set<string>();

  for (const skill of signals.skillKeywords) {
    const skillLower = skill.toLowerCase();
    
    // Custom logic for skills (e.g. react -> reactjs)
    const escaped = skillLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exactRegex = new RegExp(`\\b${escaped}\\b`, 'i');
    const variationsRegex = new RegExp(`\\b${escaped}\\b|\\b${escaped}s\\b|\\b${escaped}es\\b|\\b${escaped}js\\b|\\b${escaped}\\.js\\b`, 'i');
    
    // Check if the skill is actually in the JOB TITLE (super strong signal)
    if (variationsRegex.test(jobTitleLower)) {
      titleSkillMatches++;
    }

    const matched =
      variationsRegex.test(jobFullText) ||
      jobReqs.some(r => exactRegex.test(r) || isTokenMatch(r, skillLower));

    if (matched && !matchedSkillSet.has(skillLower)) {
      skillMatches++;
      matchedSkillSet.add(skillLower);
      reasons.push(`skill:${skill}`);
    }
  }

  // Score: at least 1 skill match = strong signal
  if (signals.skillKeywords.length > 0) {
    const denom = Math.min(3, signals.skillKeywords.length);
    let ratio = Math.min(skillMatches / denom, 1.0);
    totalScore += Math.round(ratio * 40);
    
    // Massive bonus if the skill appears directly in the job title
    if (titleSkillMatches > 0) {
      totalScore += 25; 
      reasons.push('title-skill-match');
    }
  }

  // ─── PILLAR 2: Title/Role Relevance (Max 20 pts) ───
  let titleMatches = 0;

  for (const token of signals.titleKeywords) {
    if (isTokenMatch(jobTitleLower, token)) {
      titleMatches++;
      if (!reasons.some(r => r.startsWith('title:'))) {
        reasons.push(`title:${token}`);
      }
    }
  }

  if (signals.titleKeywords.length > 0) {
    const denom = Math.min(3, signals.titleKeywords.length);
    const ratio = Math.min(titleMatches / Math.max(denom, 1), 1.0);
    totalScore += Math.round(ratio * 20);
  }

  // ─── PILLAR 3: Experience Skills Match (Max 10 pts) ───
  let expSkillMatches = 0;
  for (const skill of signals.experienceSkills) {
    if (isTokenMatch(jobFullText, skill) && !matchedSkillSet.has(skill)) {
      expSkillMatches++;
      matchedSkillSet.add(skill);
    }
  }
  if (signals.experienceSkills.length > 0) {
    const ratio = Math.min(expSkillMatches / Math.min(4, signals.experienceSkills.length), 1.0);
    totalScore += Math.round(ratio * 10);
  }

  // ─── PILLAR 4: Experience Level Fit (Max 10 pts) ───
  const candYears = signals.experienceYears;
  const jobExpLevel = (job.experienceLevel || '').toLowerCase();

  if (candYears !== null) {
    if (jobExpLevel.includes('entry') || jobExpLevel.includes('intern') || jobExpLevel.includes('junior')) {
      totalScore += candYears <= 2 ? 10 : candYears <= 4 ? 7 : 5;
    } else if (jobExpLevel.includes('mid')) {
      totalScore += (candYears >= 2 && candYears <= 5) ? 10 : candYears > 5 ? 8 : 4;
    } else if (jobExpLevel.includes('senior')) {
      totalScore += candYears >= 5 ? 10 : candYears >= 3 ? 7 : 3;
    } else if (jobExpLevel.includes('lead') || jobExpLevel.includes('manager') || jobExpLevel.includes('director')) {
      totalScore += candYears >= 7 ? 10 : candYears >= 5 ? 7 : 2;
    } else {
      totalScore += Math.min(Math.round(candYears * 1.5 + 3), 10);
    }
    if (totalScore > 0) reasons.push(`experience:${candYears}yr`);
  }

  // ─── PILLAR 5: Location Match (Max 10 pts) ───
  if (job.locationRemote === true) {
    totalScore += 10;
    reasons.push('location:remote');
  } else if (job.locationCity && signals.location) {
    const candLoc = signals.location.toLowerCase();
    const jobLoc = job.locationCity.toLowerCase();
    if (isTokenMatch(candLoc, jobLoc) || isTokenMatch(jobLoc, candLoc)) {
      totalScore += 10;
      reasons.push(`location:${job.locationCity}`);
    } else {
      totalScore += 2;
    }
  } else {
    totalScore += 4;
  }

  // ─── PILLAR 6: Search Intent Boost (Max 10 pts) ───
  let searchMatches = 0;
  for (const keyword of signals.searchKeywords) {
    if (isTokenMatch(jobFullText, keyword)) {
      searchMatches++;
      if (searchMatches <= 2) reasons.push(`search:${keyword}`);
    }
  }
  if (signals.searchKeywords.length > 0) {
    const ratio = Math.min(searchMatches / signals.searchKeywords.length, 1.0);
    totalScore += Math.round(ratio * 10);
  }

  // ─── BONUS: Bio/Education minor boost (Max 5 pts combined) ───
  let bioMatches = 0;
  for (const token of signals.bioKeywords) {
    if (isTokenMatch(jobFullText, token) && !matchedSkillSet.has(token)) {
      bioMatches++;
    }
  }
  if (signals.bioKeywords.length > 0) {
    totalScore += Math.min(Math.round((bioMatches / Math.max(signals.bioKeywords.length, 1)) * 3), 3);
  }

  let eduMatches = 0;
  for (const token of signals.educationKeywords) {
    if (isTokenMatch(jobFullText, token)) eduMatches++;
  }
  if (signals.educationKeywords.length > 0) {
    totalScore += Math.min(Math.round((eduMatches / Math.max(signals.educationKeywords.length, 1)) * 2), 2);
  }

  const finalScore = Math.min(Math.max(totalScore, 0), 100);
  return { score: finalScore, reasons };
}

// ─── Main Export ───
export async function getRecommendedJobs(employeeId: string): Promise<RecommendedJob[]> {
  const db = getDb();

  // 1. Fetch FULL Employee Profile (all fields that matter)
  const employeeRecords = await db
    .select({
      skills: users.skills,
      experienceYears: users.experienceYears,
      location: users.location,
      headline: users.headline,
      bio: users.bio,
      workExperience: users.workExperience,
      education: users.education,
    })
    .from(users)
    .where(eq(users.id, employeeId))
    .limit(1);

  if (!employeeRecords || employeeRecords.length === 0) {
    return [];
  }
  const employee = employeeRecords[0];

  // 2. Fetch Employee Search History (Last 15 searches)
  const recentSearches = await db
    .select({ searchQuery: jobSearches.searchQuery })
    .from(jobSearches)
    .where(eq(jobSearches.employeeId, employeeId))
    .orderBy(desc(jobSearches.searchedAt))
    .limit(15);

  const searchHistory = recentSearches
    .map(s => s.searchQuery.trim())
    .filter(s => s.length > 2);

  // 3. Build profile signals
  const signals = buildProfileSignals(employee, searchHistory);

  // 4. Fetch all active/published jobs
  const jobs = await db
    .select({
      id: jobPostings.id,
      jobTitle: jobPostings.jobTitle,
      description: jobPostings.description,
      requirements: jobPostings.requirements,
      salaryMin: jobPostings.salaryMin,
      salaryMax: jobPostings.salaryMax,
      salaryCurrency: jobPostings.salaryCurrency,
      locationCity: jobPostings.locationCity,
      locationRemote: jobPostings.locationRemote,
      employmentType: jobPostings.employmentType,
      experienceLevel: jobPostings.experienceLevel,
      applicationsCount: jobPostings.applicationsCount,
      publishedAt: jobPostings.publishedAt,
      companyName: users.companyName,
      companyIndustry: users.companyIndustry,
    })
    .from(jobPostings)
    .leftJoin(users, eq(jobPostings.employerId, users.id))
    .where(
      and(
        eq(jobPostings.status, 'published'),
        notLike(jobPostings.id, 'external_%'),
        or(eq(jobPostings.isDeleted, false), isNull(jobPostings.isDeleted))
      )
    )
    .all();

  // 5. Score each job
  const scoredJobs: RecommendedJob[] = jobs.map(job => {
    if (!signals.hasProfile && signals.searchKeywords.length === 0) {
      // No profile, no search history → show all jobs without match score
      return {
        id: job.id,
        jobTitle: job.jobTitle,
        description: job.description,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        salaryCurrency: job.salaryCurrency,
        locationCity: job.locationCity,
        locationRemote: job.locationRemote,
        employmentType: job.employmentType,
        experienceLevel: job.experienceLevel,
        applicationsCount: job.applicationsCount,
        publishedAt: job.publishedAt,
        companyName: job.companyName,
        companyIndustry: job.companyIndustry,
        matchScore: 0,
        hasProfile: false,
        matchReasons: [],
      };
    }

    const { score, reasons } = scoreJob(
      {
        jobTitle: job.jobTitle,
        description: job.description,
        requirements: job.requirements as any,
        locationCity: job.locationCity,
        locationRemote: job.locationRemote,
        experienceLevel: job.experienceLevel,
        employmentType: job.employmentType,
        publishedAt: job.publishedAt,
      },
      signals
    );

    return {
      id: job.id,
      jobTitle: job.jobTitle,
      description: job.description,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      salaryCurrency: job.salaryCurrency,
      locationCity: job.locationCity,
      locationRemote: job.locationRemote,
      employmentType: job.employmentType,
      experienceLevel: job.experienceLevel,
      applicationsCount: job.applicationsCount,
      publishedAt: job.publishedAt,
      companyName: job.companyName,
      companyIndustry: job.companyIndustry,
      matchScore: score,
      hasProfile: true,
      matchReasons: reasons,
    };
  });

  // 6. Sort: profile users → by score desc; no-profile → by date desc
  if (signals.hasProfile || signals.searchKeywords.length > 0) {
    scoredJobs.sort((a, b) => {
      // Primary: match score
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      // Secondary: newer jobs first
      const dateA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const dateB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return dateB - dateA;
    });
  } else {
    scoredJobs.sort((a, b) => {
      const dateA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const dateB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return dateB - dateA;
    });
  }

  return scoredJobs;
}
