import type { APIRoute } from 'astro';
import { getCrawlerSettings, saveCrawlerSettings } from '../../../../lib/crawler/engine';
import { getDb } from '../../../../lib/db';
import { crawledJobsQueue, jobPostings } from '../../../../db/schema';
import { eq, sql } from 'drizzle-orm';

export const GET: APIRoute = async ({ locals }) => {
  // @ts-ignore
  const user = locals.user;
  if (!user || user.userType !== 'masteradmin') {
    return new Response(JSON.stringify({ error: 'Unauthorized: Master Admin access required' }), { status: 403 });
  }

  try {
    const db = getDb();
    const settings = await getCrawlerSettings();

    // Get queue statistics
    const pendingRow = await db.select({ count: sql<number>`count(*)` }).from(crawledJobsQueue).where(eq(crawledJobsQueue.status, 'pending')).get();
    const publishedQueueRow = await db.select({ count: sql<number>`count(*)` }).from(crawledJobsQueue).where(eq(crawledJobsQueue.status, 'published')).get();
    const totalCrawledLiveRow = await db.select({ count: sql<number>`count(*)` }).from(jobPostings).where(eq(jobPostings.sourceType, 'crawled')).get();

    return new Response(JSON.stringify({
      settings,
      stats: {
        pendingInQueue: pendingRow?.count || 0,
        publishedFromQueue: publishedQueueRow?.count || 0,
        totalCrawledLive: totalCrawledLiveRow?.count || 0,
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to fetch settings' }), { status: 500 });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  // @ts-ignore
  const user = locals.user;
  if (!user || user.userType !== 'masteradmin') {
    return new Response(JSON.stringify({ error: 'Unauthorized: Master Admin access required' }), { status: 403 });
  }

  try {
    const body = await request.json();
    const { jobsPerBatch, intervalHours, maxAgeHours, autoPublishEnabled } = body;

    await saveCrawlerSettings({
      jobsPerBatch: jobsPerBatch !== undefined ? Number(jobsPerBatch) : undefined,
      intervalHours: intervalHours !== undefined ? Number(intervalHours) : undefined,
      maxAgeHours: maxAgeHours !== undefined ? Number(maxAgeHours) : undefined,
      autoPublishEnabled: autoPublishEnabled !== undefined ? Boolean(autoPublishEnabled) : undefined,
    });

    const updated = await getCrawlerSettings();
    return new Response(JSON.stringify({ success: true, settings: updated }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to save settings' }), { status: 500 });
  }
};
