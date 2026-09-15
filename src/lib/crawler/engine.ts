import { getDb } from '../db';
import { crawledJobsQueue, crawlerSettings, jobPostings, users } from '../../db/schema';
import { eq, desc, and, sql } from 'drizzle-orm';
import { fetchFreshJobsFromSources, fetchTargetedJobs, type RawCrawledJob, type TargetedCrawlOptions } from './sources';

export interface CrawlerSettingsData {
  jobsPerBatch: number;
  intervalHours: number;
  maxAgeHours: number;
  autoPublishEnabled: boolean;
  lastRunAt?: Date;
  lastCrawlAt?: Date;
}

// Get or initialize default crawler settings
export async function getCrawlerSettings(): Promise<CrawlerSettingsData> {
  const map: Record<string, string> = {};
  try {
    if (env?.DB) {
      const res = await env.DB.prepare("SELECT key, value FROM crawler_settings").all<{ key: string; value: string }>();
      if (res?.results) {
        for (const r of res.results) {
          map[r.key] = r.value;
        }
      }
    } else {
      const db = getDb();
      const rows = await db.select().from(crawlerSettings).all();
      rows.forEach(r => { map[r.key] = r.value; });
    }
  } catch (err) {
    console.error('Error loading crawler settings:', err);
  }

  return {
    jobsPerBatch: parseInt(map['jobs_per_batch'] || '2', 10) || 2,
    intervalHours: parseInt(map['interval_hours'] || '1', 10) || 1,
    maxAgeHours: parseInt(map['max_age_hours'] || '24', 10) || 24,
    autoPublishEnabled: map['auto_publish_enabled'] !== 'false',
    lastRunAt: map['last_run_at'] ? new Date(map['last_run_at']) : undefined,
    lastCrawlAt: map['last_crawl_at'] ? new Date(map['last_crawl_at']) : undefined,
  };
}

// Update settings
export async function saveCrawlerSettings(settings: Partial<CrawlerSettingsData>): Promise<void> {
  const nowUnix = Math.floor(Date.now() / 1000);

  const upsert = async (key: string, value: string) => {
    try {
      if (env?.DB) {
        await env.DB.prepare(`
          INSERT INTO crawler_settings (key, value, updated_at) 
          VALUES (?, ?, ?) 
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).bind(key, value, nowUnix).run();
      } else {
        const db = getDb();
        await db.insert(crawlerSettings).values({
          key,
          value,
          updatedAt: new Date(),
        }).onConflictDoUpdate({
          target: crawlerSettings.key,
          set: { value, updatedAt: new Date() }
        });
      }
    } catch (e) {
      console.error(`Error saving crawler setting ${key}:`, e);
    }
  };

  if (settings.jobsPerBatch !== undefined) await upsert('jobs_per_batch', String(settings.jobsPerBatch));
  if (settings.intervalHours !== undefined) await upsert('interval_hours', String(settings.intervalHours));
  if (settings.maxAgeHours !== undefined) await upsert('max_age_hours', String(settings.maxAgeHours));
  if (settings.autoPublishEnabled !== undefined) await upsert('auto_publish_enabled', String(settings.autoPublishEnabled));
  if (settings.lastRunAt) await upsert('last_run_at', settings.lastRunAt.toISOString());
  if (settings.lastCrawlAt) await upsert('last_crawl_at', settings.lastCrawlAt.toISOString());
}

import { env } from 'cloudflare:workers';

// Find or create a verified employer profile for crawled company
async function getOrCreateCrawledCompanyEmployer(companyName: string, companyWebsite?: string, companyLogo?: string): Promise<string> {
  const cleanName = companyName.trim();
  const slug = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const dummyEmail = `jobs+${slug}@recruitnest.ai`;

  if (env?.DB) {
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(dummyEmail).first<{ id: string }>();
    if (existing?.id) {
      return existing.id;
    }

    const newEmployerId = 'crawled_emp_' + slug.slice(0, 20) + '_' + Math.random().toString(36).substring(2, 6);
    const nowUnix = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`
      INSERT INTO users (id, user_type, email, password_hash, first_name, last_name, company_name, company_website, avatar_url, verified_status, verified_at, is_active, created_at, updated_at)
      VALUES (?, 'employer', ?, 'CRAWLED_SYSTEM_ACCOUNT', ?, 'Careers', ?, ?, ?, 'verified', ?, 1, ?, ?)
    `).bind(
      newEmployerId,
      dummyEmail,
      cleanName,
      cleanName,
      companyWebsite || null,
      companyLogo || null,
      nowUnix,
      nowUnix,
      nowUnix
    ).run();

    return newEmployerId;
  }

  const db = getDb();
  const existingUser = await db.select().from(users).where(eq(users.email, dummyEmail)).get();
  if (existingUser) {
    return existingUser.id;
  }

  const newEmployerId = 'crawled_emp_' + slug.slice(0, 20) + '_' + Math.random().toString(36).substring(2, 6);
  await db.insert(users).values({
    id: newEmployerId,
    userType: 'employer',
    email: dummyEmail,
    passwordHash: 'CRAWLED_SYSTEM_ACCOUNT',
    firstName: cleanName,
    lastName: 'Careers',
    companyName: cleanName,
    companyWebsite: companyWebsite || null,
    avatarUrl: companyLogo || null,
    verifiedStatus: 'verified',
    verifiedAt: new Date(),
    isActive: true,
  });

  return newEmployerId;
}

/**
 * 1. CRAWL & STAGE:
 * Crawls target sources and stages newly discovered fresh jobs into crawledJobsQueue
 */
export async function crawlAndQueueJobs(): Promise<{ fetched: number; newQueued: number; skipped: number }> {
  const settings = await getCrawlerSettings();
  const jsearchApiKey = (env as any)?.JSEARCH_API_KEY || process.env?.JSEARCH_API_KEY;
  const freshJobs = await fetchFreshJobsFromSources(settings.maxAgeHours, jsearchApiKey);

  let newQueued = 0;
  let skipped = 0;

  if (env?.DB) {
    // 1. Fetch existing IDs in 2 fast queries
    const existingQueueIds = new Set<string>();
    const existingJobIds = new Set<string>();

    try {
      const qRes = await env.DB.prepare("SELECT id FROM crawled_jobs_queue").all<{ id: string }>();
      if (qRes?.results) {
        for (const r of qRes.results) existingQueueIds.add(r.id);
      }
      const jRes = await env.DB.prepare("SELECT id FROM job_postings").all<{ id: string }>();
      if (jRes?.results) {
        for (const r of jRes.results) existingJobIds.add(r.id);
      }
    } catch (e) {
      console.warn('Error fetching existing IDs for deduplication:', e);
    }

    // 2. Filter out already existing jobs
    const jobsToInsert = freshJobs.filter(job => {
      if (existingQueueIds.has(job.id) || existingJobIds.has(job.id)) {
        skipped++;
        return false;
      }
      return true;
    });

    // 3. Perform batch inserts in chunks of 50
    const nowUnix = Math.floor(Date.now() / 1000);
    const chunkSize = 50;
    for (let i = 0; i < jobsToInsert.length; i += chunkSize) {
      const chunk = jobsToInsert.slice(i, i + chunkSize);
      const stmts = chunk.map(job => {
        const postedUnix = job.originalPostedAt ? Math.floor(new Date(job.originalPostedAt).getTime() / 1000) : nowUnix;
        const requirementsJson = JSON.stringify(job.requirements || []);
        return env.DB.prepare(`
          INSERT OR IGNORE INTO crawled_jobs_queue (
            id, source_url, source_type, company_name, company_website, company_logo, company_tier,
            job_title, description, requirements, salary_min, salary_max, salary_currency,
            location_city, location_remote, employment_type, experience_level,
            external_apply_url, contact_email, apply_mode, original_posted_at, status, crawled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).bind(
          job.id,
          job.sourceUrl,
          job.sourceType,
          job.companyName,
          job.companyWebsite || null,
          job.companyLogo || null,
          job.companyTier || 'startup_small',
          job.jobTitle,
          job.description,
          requirementsJson,
          job.salaryMin ?? null,
          job.salaryMax ?? null,
          job.salaryCurrency || 'USD',
          job.locationCity || 'Remote',
          job.locationRemote ? 1 : 0,
          job.employmentType || 'Full-time',
          job.experienceLevel || 'Mid',
          job.externalApplyUrl || null,
          job.contactEmail || null,
          job.applyMode || 'redirect',
          postedUnix,
          nowUnix
        );
      });

      try {
        await env.DB.batch(stmts);
        newQueued += chunk.length;
      } catch (err) {
        console.error('Error executing batch insert into crawled_jobs_queue:', err);
      }
    }
  } else {
    // Fallback for local ORM
    const db = getDb();
    for (const job of freshJobs) {
      try {
        const existingQueue = await db.select({ id: crawledJobsQueue.id }).from(crawledJobsQueue).where(eq(crawledJobsQueue.id, job.id)).get();
        const existingJob = await db.select({ id: jobPostings.id }).from(jobPostings).where(eq(jobPostings.id, job.id)).get();
        if (existingQueue || existingJob) {
          skipped++;
          continue;
        }
        await db.insert(crawledJobsQueue).values({
          id: job.id,
          sourceUrl: job.sourceUrl,
          sourceType: job.sourceType,
          companyName: job.companyName,
          companyWebsite: job.companyWebsite || null,
          companyLogo: job.companyLogo || null,
          companyTier: job.companyTier || 'startup_small',
          jobTitle: job.jobTitle,
          description: job.description,
          requirements: job.requirements || [],
          salaryMin: job.salaryMin || null,
          salaryMax: job.salaryMax || null,
          salaryCurrency: job.salaryCurrency || 'INR',
          locationCity: job.locationCity || 'India',
          locationRemote: !!job.locationRemote,
          employmentType: job.employmentType || 'Full-time',
          experienceLevel: job.experienceLevel || 'Mid',
          externalApplyUrl: job.externalApplyUrl || null,
          contactEmail: job.contactEmail || null,
          applyMode: job.applyMode || 'redirect',
          originalPostedAt: job.originalPostedAt,
          status: 'pending',
          crawledAt: new Date(),
        });
        newQueued++;
      } catch (err) {
        skipped++;
      }
    }
  }

  await saveCrawlerSettings({ lastCrawlAt: new Date() });
  return { fetched: freshJobs.length, newQueued, skipped };
}

/**
 * 1B. RE-CRAWL & RESET QUEUE:
 * Clears pending queue entries and re-populates fresh jobs into the queue
 */
export async function clearAndRefillQueue(): Promise<{ cleared: number; fetched: number; newQueued: number }> {
  let cleared = 0;
  if (env?.DB) {
    try {
      const clearRes = await env.DB.prepare("DELETE FROM crawled_jobs_queue WHERE status = 'pending'").run();
      cleared = clearRes.meta?.changes || 0;
    } catch (e) {
      console.warn('Error clearing pending queue:', e);
    }
  }
  const crawlRes = await crawlAndQueueJobs();
  return { cleared, fetched: crawlRes.fetched, newQueued: crawlRes.newQueued };
}

/**
 * 2. RATE-LIMITED PUBLISHER (BALANCED & DIVERSE COMPANIES):
 * Publishes N pending jobs ensuring every job in the batch is from a DIFFERENT company
 * and prioritizes Startups and Small/Lesser-known companies.
 */
export async function publishNextPendingBatch(customLimit?: number): Promise<{ publishedCount: number; publishedJobIds: string[] }> {
  const settings = await getCrawlerSettings();
  const limit = customLimit !== undefined ? customLimit : settings.jobsPerBatch;

  if (limit <= 0) {
    return { publishedCount: 0, publishedJobIds: [] };
  }

  // Find recent companies published to prioritize newer different companies
  let recentlyPublishedCompanies = new Set<string>();
  try {
    if (env?.DB) {
      const recentRes = await env.DB.prepare("SELECT company_name FROM crawled_jobs_queue WHERE status = 'published' ORDER BY published_at DESC LIMIT 20").all<{ company_name: string }>();
      if (recentRes?.results) {
        recentlyPublishedCompanies = new Set(recentRes.results.map(r => (r.company_name || '').toLowerCase().trim()));
      }
    }
  } catch (e) {
    console.warn('Could not query recent published companies:', e);
  }

  // Fetch pending jobs from the queue
  let allPending: any[] = [];
  try {
    if (env?.DB) {
      const rawRes = await env.DB.prepare("SELECT * FROM crawled_jobs_queue WHERE status = 'pending' LIMIT 300").all();
      allPending = rawRes?.results || [];
    } else {
      const db = getDb();
      allPending = await db.select().from(crawledJobsQueue).where(eq(crawledJobsQueue.status, 'pending')).limit(300).all();
    }
  } catch (err) {
    console.error('Error fetching pending jobs from queue:', err);
    allPending = [];
  }

  if (allPending.length === 0) {
    return { publishedCount: 0, publishedJobIds: [] };
  }

  // Prioritize startup_small companies first, then freshest dates
  allPending.sort((a, b) => {
    const tierA = a.company_tier || a.companyTier || 'startup_small';
    const tierB = b.company_tier || b.companyTier || 'startup_small';
    if (tierA === 'startup_small' && tierB !== 'startup_small') return -1;
    if (tierB === 'startup_small' && tierA !== 'startup_small') return 1;

    const rawDateA = a.original_posted_at || a.originalPostedAt || a.crawled_at || a.crawledAt;
    const rawDateB = b.original_posted_at || b.originalPostedAt || b.crawled_at || b.crawledAt;
    const dateA = rawDateA ? new Date(typeof rawDateA === 'number' && rawDateA < 1e11 ? rawDateA * 1000 : rawDateA).getTime() : 0;
    const dateB = rawDateB ? new Date(typeof rawDateB === 'number' && rawDateB < 1e11 ? rawDateB * 1000 : rawDateB).getTime() : 0;
    return dateB - dateA;
  });

  const pendingJobs: any[] = [];
  const pickedCompaniesInBatch = new Set<string>();

  // Pass 1: Pick jobs from companies not recently published AND not already in this batch
  for (const job of allPending) {
    if (pendingJobs.length >= limit) break;
    const compName = job.company_name || job.companyName || '';
    const compKey = compName.toLowerCase().trim();
    if (compKey && !pickedCompaniesInBatch.has(compKey) && !recentlyPublishedCompanies.has(compKey)) {
      pendingJobs.push(job);
      pickedCompaniesInBatch.add(compKey);
    }
  }

  // Pass 2: If still need more, pick from any company not already in this current batch
  if (pendingJobs.length < limit) {
    for (const job of allPending) {
      if (pendingJobs.length >= limit) break;
      const compName = job.company_name || job.companyName || '';
      const compKey = compName.toLowerCase().trim();
      if (compKey && !pickedCompaniesInBatch.has(compKey) && !pendingJobs.some(p => p.id === job.id)) {
        pendingJobs.push(job);
        pickedCompaniesInBatch.add(compKey);
      }
    }
  }

  // Pass 3: Fallback to remaining
  if (pendingJobs.length < limit) {
    for (const job of allPending) {
      if (pendingJobs.length >= limit) break;
      if (!pendingJobs.some(p => p.id === job.id)) {
        pendingJobs.push(job);
      }
    }
  }

  const publishedJobIds: string[] = [];

  for (const queued of pendingJobs) {
    try {
      const companyName = queued.company_name || queued.companyName || 'Emerging Startup';
      const companyWebsite = queued.company_website || queued.companyWebsite;
      const companyLogo = queued.company_logo || queued.companyLogo;
      const jobTitle = queued.job_title || queued.jobTitle;
      const description = queued.description || '';
      let requirements = queued.requirements;
      if (typeof requirements !== 'string') {
        requirements = JSON.stringify(requirements || []);
      }
      const salaryMin = queued.salary_min !== undefined ? queued.salary_min : queued.salaryMin;
      const salaryMax = queued.salary_max !== undefined ? queued.salaryMax : queued.salaryMax;
      const salaryCurrency = queued.salary_currency || queued.salaryCurrency || 'USD';
      const locationCity = queued.location_city || queued.locationCity || 'Remote';
      const locationRemote = queued.location_remote !== undefined ? queued.location_remote : (queued.locationRemote ? 1 : 0);
      const employmentType = queued.employment_type || queued.employmentType || 'Full-time';
      const experienceLevel = queued.experience_level || queued.experienceLevel || 'Mid';
      const externalApplyUrl = queued.external_apply_url || queued.externalApplyUrl || null;
      const applyMode = queued.apply_mode || queued.applyMode || 'redirect';
      const jobId = queued.id;

      // 1. Get or create employer profile
      const employerId = await getOrCreateCrawledCompanyEmployer(companyName, companyWebsite, companyLogo);

      const nowUnix = Math.floor(Date.now() / 1000);

      // 2. Insert into live jobPostings
      if (env?.DB) {
        await env.DB.prepare(`
          INSERT INTO job_postings (
            id, employer_id, job_title, description, requirements,
            salary_min, salary_max, salary_currency, location_city,
            location_remote, employment_type, experience_level,
            status, applications_count, view_count,
            external_apply_url, apply_mode, source_type,
            created_at, published_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 0, 0, ?, ?, 'crawled', ?, ?)
        `).bind(
          jobId,
          employerId,
          jobTitle,
          description,
          requirements,
          salaryMin ?? null,
          salaryMax ?? null,
          salaryCurrency,
          locationCity,
          locationRemote ? 1 : 0,
          employmentType,
          experienceLevel,
          externalApplyUrl,
          applyMode,
          nowUnix,
          nowUnix
        ).run();

        // 3. Mark queue status as published
        await env.DB.prepare(`
          UPDATE crawled_jobs_queue 
          SET status = 'published', published_job_id = ?, published_at = ? 
          WHERE id = ?
        `).bind(jobId, nowUnix, jobId).run();
      }

      publishedJobIds.push(jobId);
    } catch (err) {
      console.error(`Error publishing queued job ${queued.id}:`, err);
      if (env?.DB) {
        try {
          await env.DB.prepare("UPDATE crawled_jobs_queue SET status = 'failed' WHERE id = ?").bind(queued.id).run();
        } catch {}
      }
    }
  }

  await saveCrawlerSettings({ lastRunAt: new Date() });
  return { publishedCount: publishedJobIds.length, publishedJobIds };
}

/**
 * 3. RUN HOURLY CRON JOB / CRAWLER DISPATCH:
 * Runs the crawl (if queue is low) and publishes the exact configured batch (e.g. 1-2 jobs)
 */
export async function executeScheduledCrawlerCycle(): Promise<{ queued: number; published: number }> {
  const settings = await getCrawlerSettings();
  if (!settings.autoPublishEnabled) {
    return { queued: 0, published: 0 };
  }

  // 1. Discover fresh jobs from all target sources (Big Tech, Startups, Lever, Greenhouse, RemoteOK)
  let queued = 0;
  try {
    const crawlRes = await crawlAndQueueJobs();
    queued = crawlRes.newQueued;
  } catch (crawlErr) {
    console.error('Error during scheduled crawl phase:', crawlErr);
  }

  // 2. Publish configured batch of diverse jobs (e.g. 2 jobs from different companies)
  const publishRes = await publishNextPendingBatch(settings.jobsPerBatch);

  return { queued, published: publishRes.publishedCount };
}

/**
 * 4. TARGETED LOCATION & ROLE-BASED CRAWL:
 * Crawls target sources matching role, location, and company tier. Stages matching jobs to queue.
 */
export async function crawlAndStageTargetedJobs(options: TargetedCrawlOptions, apiKey?: string): Promise<{
  found: number;
  newQueued: number;
  skipped: number;
  jobs: { id: string; title: string; company: string; location: string }[];
}> {
  const jsearchApiKey = (env as any)?.JSEARCH_API_KEY || process.env?.JSEARCH_API_KEY;
  const matchedJobs = await fetchTargetedJobs(options, jsearchApiKey);
  if (matchedJobs.length === 0) {
    return { found: 0, newQueued: 0, skipped: 0, jobs: [] };
  }

  let newQueued = 0;
  let skipped = 0;
  const nowUnix = Math.floor(Date.now() / 1000);

  if (env?.DB) {
    const existingQueueIds = new Set<string>();
    const existingJobIds = new Set<string>();

    try {
      const qRes = await env.DB.prepare("SELECT id FROM crawled_jobs_queue").all<{ id: string }>();
      if (qRes?.results) for (const r of qRes.results) existingQueueIds.add(r.id);
      const jRes = await env.DB.prepare("SELECT id FROM job_postings").all<{ id: string }>();
      if (jRes?.results) for (const r of jRes.results) existingJobIds.add(r.id);
    } catch (e) {
      console.warn('Error fetching IDs in targeted stage:', e);
    }

    const jobsToInsert = matchedJobs.filter(job => {
      if (existingQueueIds.has(job.id) || existingJobIds.has(job.id)) {
        skipped++;
        return false;
      }
      return true;
    });

    const chunkSize = 50;
    for (let i = 0; i < jobsToInsert.length; i += chunkSize) {
      const chunk = jobsToInsert.slice(i, i + chunkSize);
      const stmts = chunk.map(job => {
        const postedUnix = job.originalPostedAt ? Math.floor(new Date(job.originalPostedAt).getTime() / 1000) : nowUnix;
        const requirementsJson = JSON.stringify(job.requirements || []);
        return env.DB.prepare(`
          INSERT OR IGNORE INTO crawled_jobs_queue (
            id, source_url, source_type, company_name, company_website, company_logo, company_tier,
            job_title, description, requirements, salary_min, salary_max, salary_currency,
            location_city, location_remote, employment_type, experience_level,
            external_apply_url, contact_email, apply_mode, original_posted_at, status, crawled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).bind(
          job.id,
          job.sourceUrl,
          job.sourceType,
          job.companyName,
          job.companyWebsite || null,
          job.companyLogo || null,
          job.companyTier || 'startup_small',
          job.jobTitle,
          job.description,
          requirementsJson,
          job.salaryMin ?? null,
          job.salaryMax ?? null,
          job.salaryCurrency || 'USD',
          job.locationCity || 'Remote',
          job.locationRemote ? 1 : 0,
          job.employmentType || 'Full-time',
          job.experienceLevel || 'Mid',
          job.externalApplyUrl || null,
          job.contactEmail || null,
          job.applyMode || 'redirect',
          postedUnix,
          nowUnix
        );
      });

      try {
        await env.DB.batch(stmts);
        newQueued += chunk.length;
      } catch (err) {
        console.error('Error in targeted batch queue insert:', err);
      }
    }
  } else {
    const db = getDb();
    for (const job of matchedJobs) {
      try {
        const existingQueue = await db.select({ id: crawledJobsQueue.id }).from(crawledJobsQueue).where(eq(crawledJobsQueue.id, job.id)).get();
        const existingJob = await db.select({ id: jobPostings.id }).from(jobPostings).where(eq(jobPostings.id, job.id)).get();
        if (existingQueue || existingJob) {
          skipped++;
          continue;
        }
        await db.insert(crawledJobsQueue).values({
          id: job.id,
          sourceUrl: job.sourceUrl,
          sourceType: job.sourceType,
          companyName: job.companyName,
          companyWebsite: job.companyWebsite || null,
          companyLogo: job.companyLogo || null,
          companyTier: job.companyTier || 'startup_small',
          jobTitle: job.jobTitle,
          description: job.description,
          requirements: job.requirements || [],
          salaryMin: job.salaryMin || null,
          salaryMax: job.salaryMax || null,
          salaryCurrency: job.salaryCurrency || 'USD',
          locationCity: job.locationCity || 'Remote',
          locationRemote: !!job.locationRemote,
          employmentType: job.employmentType || 'Full-time',
          experienceLevel: job.experienceLevel || 'Mid',
          externalApplyUrl: job.externalApplyUrl || null,
          contactEmail: job.contactEmail || null,
          applyMode: job.applyMode || 'redirect',
          originalPostedAt: job.originalPostedAt,
          status: 'pending',
          crawledAt: new Date(),
        });
        newQueued++;
      } catch (e) {
        skipped++;
      }
    }
  }

  const sampleJobs = matchedJobs.slice(0, 10).map(j => ({
    id: j.id,
    title: j.jobTitle,
    company: j.companyName,
    location: j.locationCity || 'Remote'
  }));

  return { found: matchedJobs.length, newQueued, skipped, jobs: sampleJobs };
}

/**
 * 5. TARGETED PUBLISH DIRECTLY:
 * Crawls target sources matching role, location, and tier, and immediately publishes them to the live jobs board.
 */
export async function crawlAndPublishTargetedJobs(options: TargetedCrawlOptions, apiKey?: string): Promise<{
  found: number;
  publishedCount: number;
  publishedJobs: { id: string; title: string; company: string; location: string }[];
}> {
  const jsearchApiKey = (env as any)?.JSEARCH_API_KEY || process.env?.JSEARCH_API_KEY;
  const matchedJobs = await fetchTargetedJobs(options, jsearchApiKey);
  if (matchedJobs.length === 0) {
    return { found: 0, publishedCount: 0, publishedJobs: [] };
  }

  const limit = options.limit || matchedJobs.length;
  const toPublish = matchedJobs.slice(0, limit);
  const publishedList: { id: string; title: string; company: string; location: string }[] = [];
  const nowUnix = Math.floor(Date.now() / 1000);

  for (const job of toPublish) {
    try {
      const employerId = await getOrCreateCrawledCompanyEmployer(job.companyName, job.companyWebsite, job.companyLogo);
      const requirementsJson = JSON.stringify(job.requirements || []);
      const postedUnix = job.originalPostedAt ? Math.floor(new Date(job.originalPostedAt).getTime() / 1000) : nowUnix;

      if (env?.DB) {
        // Insert into live job_postings
        await env.DB.prepare(`
          INSERT INTO job_postings (
            id, employer_id, job_title, description, requirements,
            salary_min, salary_max, salary_currency, location_city,
            location_remote, employment_type, experience_level,
            status, applications_count, view_count,
            external_apply_url, apply_mode, source_type,
            created_at, published_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 0, 0, ?, ?, 'crawled', ?, ?)
          ON CONFLICT(id) DO UPDATE SET 
            status = 'published',
            published_at = excluded.published_at
        `).bind(
          job.id,
          employerId,
          job.jobTitle,
          job.description,
          requirementsJson,
          job.salaryMin ?? null,
          job.salaryMax ?? null,
          job.salaryCurrency || 'USD',
          job.locationCity || 'Remote',
          job.locationRemote ? 1 : 0,
          job.employmentType || 'Full-time',
          job.experienceLevel || 'Mid',
          job.externalApplyUrl || null,
          job.applyMode || 'redirect',
          postedUnix,
          nowUnix
        ).run();

        // Also record in queue as published
        await env.DB.prepare(`
          INSERT INTO crawled_jobs_queue (
            id, source_url, source_type, company_name, company_website, company_logo, company_tier,
            job_title, description, requirements, salary_min, salary_max, salary_currency,
            location_city, location_remote, employment_type, experience_level,
            external_apply_url, contact_email, apply_mode, original_posted_at, status, published_job_id, published_at, crawled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = 'published',
            published_job_id = excluded.published_job_id,
            published_at = excluded.published_at
        `).bind(
          job.id,
          job.sourceUrl,
          job.sourceType,
          job.companyName,
          job.companyWebsite || null,
          job.companyLogo || null,
          job.companyTier || 'startup_small',
          job.jobTitle,
          job.description,
          requirementsJson,
          job.salaryMin ?? null,
          job.salaryMax ?? null,
          job.salaryCurrency || 'USD',
          job.locationCity || 'Remote',
          job.locationRemote ? 1 : 0,
          job.employmentType || 'Full-time',
          job.experienceLevel || 'Mid',
          job.externalApplyUrl || null,
          job.contactEmail || null,
          job.applyMode || 'redirect',
          postedUnix,
          job.id,
          nowUnix,
          nowUnix
        ).run();
      } else {
        const db = getDb();
        await db.insert(jobPostings).values({
          id: job.id,
          employerId,
          jobTitle: job.jobTitle,
          description: job.description,
          requirements: job.requirements || [],
          salaryMin: job.salaryMin || null,
          salaryMax: job.salaryMax || null,
          salaryCurrency: job.salaryCurrency || 'USD',
          locationCity: job.locationCity || 'Remote',
          locationRemote: !!job.locationRemote,
          employmentType: job.employmentType || 'Full-time',
          experienceLevel: job.experienceLevel || 'Mid',
          status: 'published',
          applicationsCount: 0,
          viewCount: 0,
          externalApplyUrl: job.externalApplyUrl || null,
          applyMode: job.applyMode || 'redirect',
          sourceType: 'crawled',
          createdAt: job.originalPostedAt || new Date(),
          publishedAt: new Date(),
        }).onConflictDoUpdate({
          target: jobPostings.id,
          set: { status: 'published', publishedAt: new Date() }
        });
      }

      publishedList.push({
        id: job.id,
        title: job.jobTitle,
        company: job.companyName,
        location: job.locationCity || 'Remote'
      });
    } catch (e) {
      console.error(`Error directly publishing targeted job ${job.id}:`, e);
    }
  }

  await saveCrawlerSettings({ lastRunAt: new Date() });
  return { found: matchedJobs.length, publishedCount: publishedList.length, publishedJobs: publishedList };
}
