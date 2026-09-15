import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { 
  crawlAndQueueJobs, 
  publishNextPendingBatch, 
  executeScheduledCrawlerCycle, 
  clearAndRefillQueue,
  crawlAndStageTargetedJobs,
  crawlAndPublishTargetedJobs
} from '../../../../lib/crawler/engine';

export const POST: APIRoute = async ({ request, locals }) => {
  // @ts-ignore
  const user = locals.user;
  if (!user || user.userType !== 'masteradmin') {
    return new Response(JSON.stringify({ error: 'Unauthorized: Master Admin access required' }), { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const action = body.action || 'cycle'; // 'crawl', 'publish_batch', 'clear_and_recrawl', 'cycle', 'targeted_crawl', 'targeted_publish'
    const customLimit = body.limit ? Number(body.limit) : undefined;

    if (action === 'crawl') {
      const res = await crawlAndQueueJobs();
      return new Response(JSON.stringify({ success: true, action: 'crawl', ...res }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'clear_and_recrawl') {
      const res = await clearAndRefillQueue();
      return new Response(JSON.stringify({ success: true, action: 'clear_and_recrawl', ...res }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'publish_batch') {
      const res = await publishNextPendingBatch(customLimit);
      return new Response(JSON.stringify({ success: true, action: 'publish_batch', ...res }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const cfEnv = (env as any) || process.env || {};
    const apiKey = cfEnv.GEMINI_API_KEY || process.env.GEMINI_API_KEY;

    if (action === 'targeted_crawl') {
      const res = await crawlAndStageTargetedJobs({
        role: body.role,
        location: body.location,
        tier: body.tier,
        limit: customLimit,
      }, apiKey);
      return new Response(JSON.stringify({ success: true, action: 'targeted_crawl', ...res }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'targeted_publish') {
      const res = await crawlAndPublishTargetedJobs({
        role: body.role,
        location: body.location,
        tier: body.tier,
        limit: customLimit,
      }, apiKey);
      return new Response(JSON.stringify({ success: true, action: 'targeted_publish', ...res }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Default: execute complete cycle
    const res = await executeScheduledCrawlerCycle();
    return new Response(JSON.stringify({ success: true, action: 'cycle', ...res }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    console.error('Error running crawler action:', err);
    return new Response(JSON.stringify({ error: err.message || 'Crawler execution failed' }), { status: 500 });
  }
};
