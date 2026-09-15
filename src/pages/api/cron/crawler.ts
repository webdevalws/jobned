import type { APIRoute } from 'astro';
import { executeScheduledCrawlerCycle, publishNextPendingBatch, crawlAndQueueJobs } from '../../../lib/crawler/engine';

export const ALL: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;

    if (action === 'publish_batch') {
      const res = await publishNextPendingBatch(limit);
      return new Response(JSON.stringify({ success: true, action: 'publish_batch', timestamp: new Date().toISOString(), ...res }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'crawl') {
      const res = await crawlAndQueueJobs();
      return new Response(JSON.stringify({ success: true, action: 'crawl', timestamp: new Date().toISOString(), ...res }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const res = await executeScheduledCrawlerCycle();
    return new Response(JSON.stringify({ success: true, timestamp: new Date().toISOString(), ...res }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    console.error('Scheduled crawler cron failed:', err);
    return new Response(JSON.stringify({ error: err.message || 'Cron failed' }), { status: 500 });
  }
};

