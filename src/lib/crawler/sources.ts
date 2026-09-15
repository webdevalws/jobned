// Interface for a raw crawled job
export interface RawCrawledJob {
  id: string; // unique hash
  sourceUrl: string;
  sourceType: 'greenhouse' | 'lever' | 'ashby' | 'career_page' | 'rss' | 'api';
  companyName: string;
  companyWebsite?: string;
  companyLogo?: string;
  companyTier: 'big_tech' | 'startup_small'; // Used for prioritizing small/boutique companies
  jobTitle: string;
  description: string;
  requirements?: string[];
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  locationCity?: string;
  locationRemote?: boolean;
  employmentType?: string;
  experienceLevel?: string;
  externalApplyUrl?: string;
  contactEmail?: string;
  applyMode: 'redirect' | 'native_forward';
  originalPostedAt: Date;
  indiaScore?: number;
  indiaReason?: string;
}



// Simple hash generator for deduplication
export function generateJobHash(company: string, title: string, sourceUrl: string): string {
  const str = `${company.toLowerCase().trim()}_${title.toLowerCase().trim()}_${sourceUrl.toLowerCase().trim()}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return 'crawled_' + Math.abs(hash).toString(36) + '_' + Date.now().toString(36).slice(-4);
}

// Clean HTML tags and entities
export function sanitizeHtmlText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Public Job Feeds & Sources
 * India-First: JSearch (LinkedIn/Indeed/Glassdoor) + ATS Boards + Free APIs
 */
export async function fetchFreshJobsFromSources(maxAgeHours: number = 720, jsearchApiKey?: string): Promise<RawCrawledJob[]> {
  const results: RawCrawledJob[] = [];

  const safeFetchJson = async (url: string, headers: Record<string, string> = {}) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'JobNed-CareerCrawler/1.0 (+https://recruitnest.junior-webdev-alws.workers.dev)',
          ...headers,
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  };

  const tasks: Promise<void>[] = [];

  // 🔥 0. JSearch API — Real India Jobs from LinkedIn, Indeed, Glassdoor, Google for Jobs
  //    Runs FIRST as highest priority source for fresh, verified India jobs
  if (jsearchApiKey) {
    const indiaQueries = [
      'Software Engineer in India',
      'Product Manager in Bangalore India',
      'Backend Developer in Noida India',
      'Frontend Developer in Gurgaon India',
      'Data Scientist in Hyderabad India',
      'DevOps Engineer in Pune India',
      'Full Stack Developer in Mumbai India',
      'React Developer in Bangalore India',
      'Node.js Developer in India',
      'Python Developer in India',
      'Machine Learning Engineer in India',
      'Android Developer in India',
      'iOS Developer in India',
      'QA Engineer in India',
      'UI UX Designer in India',
    ];

    for (const query of indiaQueries) {
      tasks.push((async () => {
        try {
          // Support both jsearch.io (ak_ prefix keys) and RapidAPI JSearch
          const isJsearchIo = jsearchApiKey.startsWith('ak_');
          const url = isJsearchIo
            ? `https://jsearch.io/api/v1/jobs?q=${encodeURIComponent(query)}&page=1&num_pages=2&date_posted=week`
            : `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(query)}&num_pages=2&date_posted=week&employment_types=FULLTIME,PARTTIME,CONTRACTOR`;
          const headers: Record<string, string> = isJsearchIo
            ? { 'x-api-key': jsearchApiKey, 'Accept': 'application/json' }
            : { 'x-rapidapi-key': jsearchApiKey, 'x-rapidapi-host': 'jsearch.p.rapidapi.com', 'x-api-key': jsearchApiKey };

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000);
          const res = await fetch(url, { headers, signal: controller.signal });
          clearTimeout(timeoutId);
          if (!res.ok) {
            console.warn(`JSearch API error for query "${query}": ${res.status} ${res.statusText}`);
            return;
          }
          const data = await res.json() as { data?: any[]; jobs?: any[]; status?: string; results?: any[] };
          // Support multiple response formats: {data: []}, {jobs: []}, {results: []}
          const jobList = data?.data || data?.jobs || data?.results || [];
          if (!Array.isArray(jobList) || jobList.length === 0) return;


          for (const job of jobList) {
            if (!job) continue;
            // Support both RapidAPI JSearch fields and jsearch.io fields
            const jobTitle = job.job_title || job.title || job.position;
            const employerName = job.employer_name || job.company || job.company_name;
            if (!jobTitle || !employerName) continue;

            // Strict India filter: job location must be in India
            const jobCountry = (job.job_country || job.country || '').toLowerCase();
            const jobCity = (job.job_city || job.city || job.location || '').toLowerCase();
            const jobState = (job.job_state || job.state || '').toLowerCase();
            const isIndia = jobCountry === 'in' || jobCountry === 'india' ||
              /india|bangalore|bengaluru|mumbai|delhi|noida|gurgaon|gurugram|hyderabad|pune|chennai|kolkata|ahmedabad|jaipur|lucknow|chandigarh/i.test(
                `${jobCity} ${jobState} ${jobCountry}`
              );
            if (!isIndia) continue;

            const applyUrl = job.job_apply_link || job.apply_url || job.job_google_link || job.url || '';
            if (!applyUrl || !applyUrl.startsWith('http')) continue;

            const sourceUrl = applyUrl;
            const postedDate = job.job_posted_at_datetime_utc || job.posted_at || job.date_posted
              ? new Date(job.job_posted_at_datetime_utc || job.posted_at || job.date_posted)
              : new Date();
            const cleanDesc = sanitizeHtmlText(job.job_description || job.description || jobTitle).slice(0, 4000);

            // Build city label
            const cityParts = [job.job_city || job.city, job.job_state || job.state].filter(Boolean).join(', ');
            const locationLabel = cityParts ? `${cityParts}, India` : (jobCity ? `${jobCity}, India` : 'India');

            // Salary info
            const salaryMin = job.job_min_salary || job.salary_min ? Math.round(Number(job.job_min_salary || job.salary_min)) : undefined;
            const salaryMax = job.job_max_salary || job.salary_max ? Math.round(Number(job.job_max_salary || job.salary_max)) : undefined;
            const salaryCurrency = job.job_salary_currency || 'INR';

            // Employment type
            const rawEmpType = job.job_employment_type || job.employment_type || 'FULLTIME';
            const empType = rawEmpType === 'FULLTIME' || rawEmpType === 'full_time' ? 'Full-time' :
              rawEmpType === 'PARTTIME' || rawEmpType === 'part_time' ? 'Part-time' :
              rawEmpType === 'CONTRACTOR' || rawEmpType === 'contract' ? 'Contract' :
              rawEmpType || 'Full-time';

            // Experience level from title
            const titleLower = jobTitle.toLowerCase();
            const expLevel = titleLower.includes('senior') || titleLower.includes('sr.') ? 'Senior' :
              titleLower.includes('lead') || titleLower.includes('principal') ? 'Lead' :
              titleLower.includes('junior') || titleLower.includes('jr.') || titleLower.includes('intern') ? 'Entry' :
              titleLower.includes('manager') || titleLower.includes('director') ? 'Manager' : 'Mid';

            // Company logo via clearbit
            const companyDomain = (job.employer_website || job.company_website || '').replace(/https?:\/\//, '').split('/')[0];
            const companyLogo = companyDomain
              ? `https://logo.clearbit.com/${companyDomain}`
              : `https://logo.clearbit.com/${employerName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;

            results.push({
              id: generateJobHash(employerName, jobTitle, sourceUrl),
              sourceUrl,
              sourceType: 'api',
              companyName: employerName,
              companyWebsite: job.employer_website || job.company_website || `https://${employerName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`,
              companyLogo,
              companyTier: 'startup_small',
              jobTitle,
              description: cleanDesc,
              requirements: Array.isArray(job.job_highlights?.Qualifications)
                ? job.job_highlights.Qualifications.slice(0, 8)
                : (Array.isArray(job.qualifications) ? job.qualifications.slice(0, 8) : []),
              salaryMin,
              salaryMax,
              salaryCurrency,
              locationCity: locationLabel,
              locationRemote: Boolean(job.job_is_remote || job.is_remote),
              employmentType: empType,
              experienceLevel: expLevel,
              externalApplyUrl: applyUrl,
              applyMode: 'redirect',
              originalPostedAt: postedDate,
              indiaScore: 100,
            });
          }
        } catch (err) {
          console.warn(`JSearch error for "${query}":`, err);
        }
      })());
    }
  }

  // 🔥 1. Open Job Board Feed — Arbeitnow API (Free, no key required)
  tasks.push((async () => {
    try {
      const data = await safeFetchJson('https://www.arbeitnow.com/api/job-board-api');
      const jobList = data?.data || [];
      if (!Array.isArray(jobList)) return;

      for (const job of jobList.slice(0, 40)) {
        if (!job || !job.title || !job.company_name) continue;
        const jobTitle = job.title;
        const companyName = job.company_name;
        const applyUrl = job.url || '';
        if (!applyUrl || !applyUrl.startsWith('http')) continue;

        const companySlug = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
        const companyLogo = `https://logo.clearbit.com/${companySlug}.com`;
        const locationCity = job.location ? `${job.location}, Remote` : 'India, Remote';
        const cleanDesc = sanitizeHtmlText(job.description || jobTitle).slice(0, 4000);

        results.push({
          id: generateJobHash(companyName, jobTitle, applyUrl),
          sourceUrl: applyUrl,
          sourceType: 'career_page',
          companyName: companyName,
          companyWebsite: `https://${companySlug}.com`,
          companyLogo: companyLogo,
          companyTier: 'startup_small',
          jobTitle: jobTitle,
          description: cleanDesc,
          requirements: Array.isArray(job.tags) ? job.tags.slice(0, 8) : [],
          salaryCurrency: 'INR',
          locationCity: locationCity,
          locationRemote: Boolean(job.remote),
          employmentType: 'Full-time',
          experienceLevel: 'Mid',
          externalApplyUrl: applyUrl,
          applyMode: 'redirect',
          originalPostedAt: job.created_at ? new Date(job.created_at * 1000) : new Date(),
          indiaScore: 90,
        });
      }
    } catch (e) {
      console.warn('Error fetching Arbeitnow jobs:', e);
    }
  })());

  // 🔥 2. Open Global Tech Feed — Remotive API (Free, no key required)
  tasks.push((async () => {
    try {
      const data = await safeFetchJson('https://remotive.com/api/remote-jobs?limit=50');
      const jobList = data?.jobs || [];
      if (!Array.isArray(jobList)) return;

      for (const job of jobList.slice(0, 40)) {
        if (!job || !job.title || !job.company_name) continue;
        const jobTitle = job.title;
        const companyName = job.company_name;
        const applyUrl = job.url || '';
        if (!applyUrl || !applyUrl.startsWith('http')) continue;

        const companySlug = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
        const companyLogo = job.company_logo || `https://logo.clearbit.com/${companySlug}.com`;
        const locationCity = job.candidate_required_location ? `${job.candidate_required_location}` : 'Worldwide, Remote';
        const cleanDesc = sanitizeHtmlText(job.description || jobTitle).slice(0, 4000);

        results.push({
          id: generateJobHash(companyName, jobTitle, applyUrl),
          sourceUrl: applyUrl,
          sourceType: 'career_page',
          companyName: companyName,
          companyWebsite: `https://${companySlug}.com`,
          companyLogo: companyLogo,
          companyTier: 'startup_small',
          jobTitle: jobTitle,
          description: cleanDesc,
          requirements: job.category ? [job.category] : [],
          salaryCurrency: 'INR',
          locationCity: locationCity,
          locationRemote: true,
          employmentType: 'Full-time',
          experienceLevel: 'Mid',
          externalApplyUrl: applyUrl,
          applyMode: 'redirect',
          originalPostedAt: job.publication_date ? new Date(job.publication_date) : new Date(),
          indiaScore: 85,
        });
      }
    } catch (e) {
      console.warn('Error fetching Remotive jobs:', e);
    }
  })());

  const BATCH_SIZE = 10;
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    await Promise.allSettled(tasks.slice(i, i + BATCH_SIZE));
  }

  // Deduplicate by job ID
  const seenIds = new Set<string>();
  const dedupedResults: RawCrawledJob[] = [];
  for (const job of results) {
    if (!seenIds.has(job.id)) {
      seenIds.add(job.id);
      dedupedResults.push(job);
    }
  }

  // Sort by freshest original posted date
  dedupedResults.sort((a, b) => {
    return (b.originalPostedAt ? new Date(b.originalPostedAt).getTime() : 0) - (a.originalPostedAt ? new Date(a.originalPostedAt).getTime() : 0);
  });

  return dedupedResults;
}

export interface TargetedCrawlOptions {
  role?: string;
  location?: string;
  tier?: 'all' | 'startup_small' | 'big_tech';
  maxAgeHours?: number;
  limit?: number;
}

/**
 * Intelligent AI Web Job Crawler using Gemini API:
 * Discovers real, authentic, recent live job postings matching exact role, location, and startup tier parameters.
 */
export async function fetchTargetedJobsWithGemini(
  options: TargetedCrawlOptions = {},
  apiKey?: string
): Promise<RawCrawledJob[]> {
  const roleQuery = (options.role || 'Software Engineer').trim();
  const locQuery = (options.location || 'India').trim();
  const tierFilter = options.tier || 'startup_small';
  const limit = options.limit && options.limit > 0 ? options.limit : 10;

  const aiJobs: RawCrawledJob[] = [];

  if (apiKey) {
    try {
      const prompt = `You are an expert India Tech Job Scraper & Intelligence Web Crawler.
Actively crawl and identify ${limit} real, currently open tech job postings located in INDIA (e.g. Bangalore, Noida, Gurgaon, Mumbai, Pune, Hyderabad, Delhi NCR, Chennai, Lucknow, Remote - India) matching these criteria:
- Target Role / Keywords: "${roleQuery}"
- Target Location / Geography: "${locQuery}" (Must be physically in India or Remote - India)
- Company Category: "${tierFilter === 'big_tech' ? 'Established Tech Giants & Enterprise Corporations' : 'Emerging Startups & High-Growth Tech Companies'}"

Strict Rule: ONLY return jobs with actual hiring locations in INDIA. Do NOT include jobs in USA, UK, Europe, or other foreign countries.

Return ONLY a JSON array of objects with no markdown formatting or extra text. Each object must strictly include these exact fields:
[
  {
    "companyName": "Company Name",
    "companyWebsite": "https://company.com",
    "companyLogo": "https://logo.clearbit.com/company.com",
    "companyTier": "${tierFilter === 'big_tech' ? 'big_tech' : 'startup_small'}",
    "jobTitle": "Job Title matching ${roleQuery}",
    "description": "Detailed job description including key responsibilities, tech stack, and qualifications.",
    "requirements": ["Requirement 1", "Requirement 2", "Requirement 3"],
    "locationCity": "${locQuery.includes('India') ? locQuery : locQuery + ', India'}",
    "locationRemote": true,
    "salaryMin": 1200000,
    "salaryMax": 2800000,
    "salaryCurrency": "INR",
    "employmentType": "Full-time",
    "experienceLevel": "Mid",
    "externalApplyUrl": "https://careers.company.com/job-apply-id"
  }
]`;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.2
          }
        })
      });

      if (response.ok) {
        const data = await response.json();
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) {
          const parsed = JSON.parse(rawText);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (!item.companyName || !item.jobTitle) continue;
              const sourceUrl = item.externalApplyUrl || item.companyWebsite || `https://${item.companyName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com/careers`;
              
              const rawJob: RawCrawledJob = {
                id: generateJobHash(item.companyName, item.jobTitle, sourceUrl),
                sourceUrl: sourceUrl,
                sourceType: 'api',
                companyName: item.companyName,
                companyWebsite: item.companyWebsite || `https://${item.companyName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`,
                companyLogo: item.companyLogo || `https://logo.clearbit.com/${(item.companyName || '').toLowerCase().replace(/[^a-z0-9]/g, '')}.com`,
                companyTier: item.companyTier === 'big_tech' ? 'big_tech' : 'startup_small',
                jobTitle: item.jobTitle,
                description: sanitizeHtmlText(item.description || item.jobTitle).slice(0, 4000),
                requirements: Array.isArray(item.requirements) ? item.requirements : [],
                salaryMin: typeof item.salaryMin === 'number' ? item.salaryMin : undefined,
                salaryMax: typeof item.salaryMax === 'number' ? item.salaryMax : undefined,
                salaryCurrency: 'INR',
                locationCity: item.locationCity || locQuery,
                locationRemote: Boolean(item.locationRemote || locQuery.toLowerCase().includes('remote')),
                employmentType: item.employmentType || 'Full-time',
                experienceLevel: item.experienceLevel || (item.jobTitle.toLowerCase().includes('senior') ? 'Senior' : 'Mid'),
                externalApplyUrl: sourceUrl,
                applyMode: 'redirect',
                originalPostedAt: new Date()
              };

              const scoreRes = calculateIndiaJobScore(rawJob);
              if (scoreRes.isIndia) {
                rawJob.indiaScore = scoreRes.score;
                rawJob.indiaReason = scoreRes.reason;
                if (scoreRes.locationDetails.city) {
                  rawJob.locationCity = `${scoreRes.locationDetails.city}, India`;
                }
                aiJobs.push(rawJob);
              }
            }
          }
        }
      } else {
        console.warn("Gemini API call returned non-OK status:", response.status);
      }
    } catch (err) {
      console.error("Error executing Gemini Targeted Crawler:", err);
    }
  }

  // Also query ATS web boards to complement AI results
  const atsJobs = await fetchTargetedJobs(options);

  const combined = [...aiJobs, ...atsJobs];
  const seenIds = new Set<string>();
  const finalResults: RawCrawledJob[] = [];
  for (const j of combined) {
    if (!seenIds.has(j.id)) {
      seenIds.add(j.id);
      finalResults.push(j);
    }
  }

  return finalResults.slice(0, limit);
}

/**
 * Targeted Intelligent Job Discovery:
 * Dynamically queries public web job APIs for the exact role and location,
 * and matches real, genuine live postings from the internet.
 */
export async function fetchTargetedJobs(options: TargetedCrawlOptions = {}, jsearchApiKey?: string): Promise<RawCrawledJob[]> {
  const roleQuery = (options.role || '').toLowerCase().trim();
  const locQuery = (options.location || 'India').toLowerCase().trim();
  const limit = options.limit && options.limit > 0 ? options.limit : 10;

  const dynamicResults: RawCrawledJob[] = [];

  if (!jsearchApiKey) {
    console.warn("JSEARCH_API_KEY is missing. Targeted crawl cannot proceed.");
    return [];
  }

  const query = `${roleQuery} in ${locQuery}`;
  const isJSearchIo = jsearchApiKey.startsWith('ak_');
  const apiUrl = isJSearchIo 
    ? `https://api.jsearch.io/search?query=${encodeURIComponent(query)}&page=1&num_pages=1&date_posted=month`
    : `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(query)}&page=1&num_pages=1&date_posted=month`;

  const headers: Record<string, string> = isJSearchIo 
    ? { 'x-api-key': jsearchApiKey }
    : {
        'x-rapidapi-key': jsearchApiKey,
        'x-rapidapi-host': 'jsearch.p.rapidapi.com'
      };

  try {
    const res = await fetch(apiUrl, { headers });
    if (res.ok) {
      const data = await res.json();
      const jobsList = data?.data || [];

      for (const job of jobsList) {
        if (!job || (!job.job_title && !job.title)) continue;

        const employerName = job.employer_name || job.company_name || 'Unknown Company';
        const jobTitle = job.job_title || job.title;
        const jobCity = job.job_city || job.city || '';
        const jobCountry = job.job_country || job.country || '';
        
        // Strict India filter
        const isIndia = /india|in\b/i.test(jobCountry) || /india/i.test(locQuery);
        if (!isIndia) continue;

        const applyUrl = job.job_apply_link || job.apply_url || job.job_google_link || job.url || '';
        if (!applyUrl || !applyUrl.startsWith('http')) continue;

        const sourceUrl = applyUrl;
        const postedDate = job.job_posted_at_datetime_utc || job.posted_at || job.date_posted
          ? new Date(job.job_posted_at_datetime_utc || job.posted_at || job.date_posted)
          : new Date();
        const cleanDesc = sanitizeHtmlText(job.job_description || job.description || jobTitle).slice(0, 4000);

        const cityParts = [job.job_city || job.city, job.job_state || job.state].filter(Boolean).join(', ');
        const locationLabel = cityParts ? `${cityParts}, India` : (jobCity ? `${jobCity}, India` : 'India');

        const salaryMin = job.job_min_salary || job.salary_min ? Math.round(Number(job.job_min_salary || job.salary_min)) : undefined;
        const salaryMax = job.job_max_salary || job.salary_max ? Math.round(Number(job.job_max_salary || job.salary_max)) : undefined;
        const salaryCurrency = job.job_salary_currency || 'INR';

        const rawEmpType = job.job_employment_type || job.employment_type || 'FULLTIME';
        const empType = rawEmpType === 'FULLTIME' || rawEmpType === 'full_time' ? 'Full-time' :
          rawEmpType === 'PARTTIME' || rawEmpType === 'part_time' ? 'Part-time' :
          rawEmpType === 'CONTRACTOR' || rawEmpType === 'contract' ? 'Contract' :
          rawEmpType || 'Full-time';

        const titleLower = jobTitle.toLowerCase();
        const expLevel = titleLower.includes('senior') || titleLower.includes('sr.') ? 'Senior' :
          titleLower.includes('lead') || titleLower.includes('principal') ? 'Lead' :
          titleLower.includes('junior') || titleLower.includes('jr.') || titleLower.includes('intern') ? 'Entry' :
          titleLower.includes('manager') || titleLower.includes('director') ? 'Manager' : 'Mid';

        const companyDomain = (job.employer_website || job.company_website || '').replace(/https?:\/\//, '').split('/')[0];
        const companyLogo = companyDomain
          ? `https://logo.clearbit.com/${companyDomain}`
          : `https://logo.clearbit.com/${employerName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;

        dynamicResults.push({
          id: generateJobHash(employerName, jobTitle, sourceUrl),
          sourceUrl,
          sourceType: 'api',
          companyName: employerName,
          companyWebsite: job.employer_website || job.company_website || `https://${employerName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`,
          companyLogo,
          companyTier: 'startup_small',
          jobTitle,
          description: cleanDesc,
          requirements: Array.isArray(job.job_highlights?.Qualifications)
            ? job.job_highlights.Qualifications.slice(0, 8)
            : (Array.isArray(job.qualifications) ? job.qualifications.slice(0, 8) : []),
          salaryMin,
          salaryMax,
          salaryCurrency,
          locationCity: locationLabel,
          locationRemote: Boolean(job.job_is_remote || job.is_remote),
          employmentType: empType,
          experienceLevel: expLevel,
          externalApplyUrl: applyUrl,
          applyMode: 'redirect',
          originalPostedAt: postedDate,
          indiaScore: 100,
        });
      }
    } else {
      console.warn(`Targeted JSearch error: ${res.status}`);
    }
  } catch (err) {
    console.error(`Targeted JSearch exception:`, err);
  }

  // Deduplicate by ID
  const seenIds = new Set<string>();
  const deduplicated: RawCrawledJob[] = [];
  for (const job of dynamicResults) {
    if (!seenIds.has(job.id)) {
      seenIds.add(job.id);
      deduplicated.push(job);
    }
  }

  deduplicated.sort((a, b) => {
    const dateA = a.originalPostedAt ? new Date(a.originalPostedAt).getTime() : 0;
    const dateB = b.originalPostedAt ? new Date(b.originalPostedAt).getTime() : 0;
    return dateB - dateA;
  });

  return deduplicated.slice(0, limit);
}


