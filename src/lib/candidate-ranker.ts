export interface JobCriteria {
  id: string;
  jobTitle: string;
  description: string;
  requirements?: string[] | string | null;
  experienceLevel?: string | null;
  locationCity?: string | null;
  locationRemote?: boolean | null;
  employmentType?: string | null;
}

export interface CandidateProfile {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  skills?: string[] | string | null;
  experienceYears?: number | null;
  location?: string | null;
  bio?: string | null;
  verifiedStatus?: string | null;
  resumeUrl?: string | null;
  applicationId?: string | null;
  applicationStatus?: string | null;
  appliedAt?: Date | null;
  coverLetter?: string | null;
}

export interface CandidateRankingResult {
  candidateId: string;
  applicationId?: string | null;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  location?: string | null;
  experienceYears?: number | null;
  verifiedStatus?: string | null;
  resumeUrl?: string | null;
  applicationStatus?: string | null;
  appliedAt?: Date | null;
  
  // Overall Fit
  overallScore: number; // 0 - 100
  tier: 'top' | 'strong' | 'moderate' | 'low';
  tierLabel: string;
  rankBadge: string;
  
  // Sub-score Pillars
  skillScore: number; // Max 40
  experienceScore: number; // Max 25
  domainScore: number; // Max 15
  locationScore: number; // Max 10
  profileScore: number; // Max 10

  // Key AI Insights
  matchingSkills: string[];
  missingSkills: string[];
  candidateSkills: string[];
  aiSummary: string;
}

export async function rankCandidateForJob(candidate: CandidateProfile, job: JobCriteria, apiKey?: string): Promise<CandidateRankingResult> {
  // 1. Parse Job Requirements
  let jobReqs: string[] = [];
  if (job.requirements) {
    try {
      jobReqs = typeof job.requirements === 'string' ? JSON.parse(job.requirements) : job.requirements;
    } catch {
      jobReqs = typeof job.requirements === 'string' ? job.requirements.split(',').map(s => s.trim()) : [];
    }
  }
  if (!Array.isArray(jobReqs)) jobReqs = [];
  const normalizedJobReqs = jobReqs.map(r => String(r).toLowerCase().trim()).filter(Boolean);

  // 2. Parse Candidate Skills
  let candSkills: string[] = [];
  if (candidate.skills) {
    try {
      candSkills = typeof candidate.skills === 'string' ? JSON.parse(candidate.skills) : candidate.skills;
    } catch {
      candSkills = typeof candidate.skills === 'string' ? candidate.skills.split(',').map(s => s.trim()) : [];
    }
  }
  if (!Array.isArray(candSkills)) candSkills = [];
  const rawCandSkills = candSkills.map(s => String(s).trim()).filter(Boolean);
  const normalizedCandSkills = rawCandSkills.map(s => s.toLowerCase());

  const jobFullText = `${job.jobTitle} ${job.description}`.toLowerCase();
  const candBioText = `${candidate.bio || ''} ${candidate.coverLetter || ''}`.toLowerCase();

  // --- PILLAR 1: Skill Alignment (Max 40 pts) ---
  const matchingSkills: string[] = [];
  const missingSkills: string[] = [];

  for (const rawReq of jobReqs) {
    const reqLower = rawReq.toLowerCase().trim();
    if (!reqLower) continue;

    const matchedSkill = rawCandSkills.find(s => {
      const sLower = s.toLowerCase();
      return sLower === reqLower || sLower.includes(reqLower) || reqLower.includes(sLower);
    });

    if (matchedSkill || candBioText.includes(reqLower)) {
      if (!matchingSkills.includes(rawReq)) matchingSkills.push(rawReq);
    } else {
      if (!missingSkills.includes(rawReq)) missingSkills.push(rawReq);
    }
  }

  // Also check if candidate has extra relevant skills mentioned in job text
  for (const candSkill of rawCandSkills) {
    const sLower = candSkill.toLowerCase();
    if (jobFullText.includes(sLower) && !matchingSkills.some(m => m.toLowerCase() === sLower)) {
      matchingSkills.push(candSkill);
    }
  }

  let skillScore = 0;
  if (normalizedJobReqs.length > 0) {
    const matchRatio = Math.min(matchingSkills.length / Math.max(normalizedJobReqs.length, 1), 1.0);
    skillScore = Math.round(matchRatio * 40);
  } else if (normalizedCandSkills.length > 0) {
    // If job didn't specify formal requirements, calculate overlap with job description
    const overlapCount = normalizedCandSkills.filter(s => jobFullText.includes(s) || jobFullText.includes(s.replace(/s$/, ''))).length;
    // Don't penalize candidates who have many skills when applying for specialized jobs
    const expectedSkillsForJob = Math.min(3, normalizedCandSkills.length);
    const ratio = Math.min(overlapCount / Math.max(expectedSkillsForJob, 1), 1.0);
    skillScore = Math.round(ratio * 40);
  }

  // --- PILLAR 2: Experience Level Fit (Max 25 pts) ---
  let experienceScore = 0;
  const candYears = candidate.experienceYears !== null && candidate.experienceYears !== undefined ? Number(candidate.experienceYears) : null;
  const jobExpLevel = (job.experienceLevel || '').toLowerCase();

  if (candYears !== null) {
    if (jobExpLevel.includes('entry') || jobExpLevel.includes('intern') || jobExpLevel.includes('junior')) {
      if (candYears <= 2) experienceScore = 25;
      else if (candYears <= 4) experienceScore = 20;
      else experienceScore = 15; // Slightly overqualified
    } else if (jobExpLevel.includes('mid')) {
      if (candYears >= 2 && candYears <= 5) experienceScore = 25;
      else if (candYears > 5) experienceScore = 22;
      else experienceScore = 12;
    } else if (jobExpLevel.includes('senior')) {
      if (candYears >= 5) experienceScore = 25;
      else if (candYears >= 3) experienceScore = 18;
      else experienceScore = 8;
    } else if (jobExpLevel.includes('lead') || jobExpLevel.includes('manager') || jobExpLevel.includes('director')) {
      if (candYears >= 7) experienceScore = 25;
      else if (candYears >= 5) experienceScore = 18;
      else experienceScore = 6;
    } else {
      // Default scaling if job doesn't specify level
      experienceScore = Math.min(candYears * 4 + 10, 25);
    }
  }

  // --- PILLAR 3: Domain & Title Relevance (Max 15 pts) ---
  let domainScore = 0;
  const titleTokens = job.jobTitle.toLowerCase().split(/[\s/,-]+/).filter(t => t.length > 2);
  let domainMatches = 0;

  for (const token of titleTokens) {
    if (normalizedCandSkills.some(s => s.includes(token)) || candBioText.includes(token)) {
      domainMatches++;
    }
  }
  if (titleTokens.length > 0) {
    domainScore = Math.min(Math.round((domainMatches / titleTokens.length) * 15), 15);
  } else {
    domainScore = 10;
  }

  // --- PILLAR 4: Location & Work Mode Fit (Max 10 pts) ---
  let locationScore = 0;
  if (job.locationRemote === true) {
    locationScore = 10; // 100% remote matches all locations
  } else if (job.locationCity && candidate.location) {
    const candLoc = candidate.location.toLowerCase();
    const jobLoc = job.locationCity.toLowerCase();
    if (candLoc.includes(jobLoc) || jobLoc.includes(candLoc)) {
      locationScore = 10;
    } else {
      locationScore = 3;
    }
  } else {
    locationScore = 5;
  }

  // --- PILLAR 5: Profile Completeness & Credentials (Max 10 pts) ---
  let profileScore = 0;
  if (rawCandSkills.length >= 3) profileScore += 3;
  if (candYears !== null) profileScore += 2;
  if (candidate.bio && candidate.bio.length > 30) profileScore += 2;
  if (candidate.resumeUrl) profileScore += 2;
  if (candidate.verifiedStatus === 'verified') profileScore += 1;

  // Total Score
  let overallScore = Math.min(Math.max(skillScore + experienceScore + domainScore + locationScore + profileScore, 0), 100);

  // Determine Tier & Badges
  let tier: 'top' | 'strong' | 'moderate' | 'low' = 'low';
  let tierLabel = 'Low Compatibility';
  let rankBadge = '⚠️ Needs Review';

  if (overallScore >= 85) {
    tier = 'top';
    tierLabel = 'Top Recommendation';
    rankBadge = '🌟 Top Match';
  } else if (overallScore >= 70) {
    tier = 'strong';
    tierLabel = 'Strong Fit';
    rankBadge = '⚡ Strong Match';
  } else if (overallScore >= 50) {
    tier = 'moderate';
    tierLabel = 'Moderate Fit';
    rankBadge = '⚖️ Partial Match';
  }

  // Generate Natural Language AI Recruiter Insight Summary
  let aiSummary = '';
  const yearsText = candYears !== null ? `${candYears} yr${candYears !== 1 ? 's' : ''} exp` : 'unspecified experience';
  
  if (tier === 'top') {
    aiSummary = `Exceptional candidate alignment for ${job.jobTitle}. Possesses ${matchingSkills.length} key competencies with ${yearsText}. Recommended for priority interview scheduling.`;
  } else if (tier === 'strong') {
    aiSummary = `Strong profile with solid core background (${matchingSkills.slice(0, 3).join(', ')}). Meets essential requirements for ${job.jobTitle}.`;
  } else if (tier === 'moderate') {
    const missingStr = missingSkills.length > 0 ? ` Missing competencies: ${missingSkills.slice(0, 2).join(', ')}.` : '';
    aiSummary = `Partial alignment with job requirements (${matchingSkills.length} matched skills, ${yearsText}).${missingStr}`;
  } else {
  }

  // Override with Gemini AI if API key is provided
  if (apiKey) {
    try {
      const prompt = `You are an expert technical recruiter. Evaluate the following candidate for the given job.
Job Title: ${job.jobTitle}
Job Description: ${job.description}
Candidate Skills: ${rawCandSkills.join(', ')}
Candidate Experience: ${candYears !== null ? candYears + ' years' : 'Not specified'}
Candidate Bio: ${candidate.bio || 'Not specified'}

Return ONLY a JSON object with this exact structure, no markdown, no other text:
{
  "score": <number between 0 and 100 representing overall fit>,
  "summary": "<a concise 2-sentence summary of why they are or aren't a good fit>"
}`;
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { response_mime_type: "application/json" }
        })
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const parsed = JSON.parse(text);
          if (typeof parsed.score === 'number') {
            overallScore = parsed.score;
            // Re-evaluate tier based on AI score
            if (overallScore >= 85) {
              tier = 'top'; tierLabel = 'Top Recommendation'; rankBadge = '🌟 Top Match';
            } else if (overallScore >= 70) {
              tier = 'strong'; tierLabel = 'Strong Fit'; rankBadge = '⚡ Strong Match';
            } else if (overallScore >= 50) {
              tier = 'moderate'; tierLabel = 'Moderate Fit'; rankBadge = '⚖️ Partial Match';
            } else {
              tier = 'low'; tierLabel = 'Low Compatibility'; rankBadge = '⚠️ Needs Review';
            }
          }
          if (typeof parsed.summary === 'string') {
            aiSummary = parsed.summary;
          }
        }
      } else {
         console.error("Gemini API error:", await response.text());
      }
    } catch (err) {
      console.error("Gemini API call failed, falling back to heuristics:", err);
    }
  }

  return {
    candidateId: candidate.id,
    applicationId: candidate.applicationId,
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    email: candidate.email,
    phone: candidate.phone,
    location: candidate.location,
    experienceYears: candYears,
    verifiedStatus: candidate.verifiedStatus,
    resumeUrl: candidate.resumeUrl,
    applicationStatus: candidate.applicationStatus,
    appliedAt: candidate.appliedAt,

    overallScore,
    tier,
    tierLabel,
    rankBadge,

    skillScore,
    experienceScore,
    domainScore,
    locationScore,
    profileScore,

    matchingSkills,
    missingSkills,
    candidateSkills: rawCandSkills,
    aiSummary,
  };
}

export async function rankCandidatesList(candidates: CandidateProfile[], job: JobCriteria, apiKey?: string): Promise<CandidateRankingResult[]> {
  const results = await Promise.all(candidates.map(c => rankCandidateForJob(c, job, apiKey)));
  // Sort descending by overall AI match score
  results.sort((a, b) => b.overallScore - a.overallScore);
  return results;
}
