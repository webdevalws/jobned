import type { APIRoute } from 'astro';
import { getDb } from '../lib/db';
import { jobPostings } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';

function escapeXml(unsafe: string): string {
  return String(unsafe || '').replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

export const GET: APIRoute = async ({ request }) => {
  const baseUrl = 'https://jobned.com';
  const now = new Date().toISOString().split('T')[0];

  const staticPages = [
    { url: '/', priority: '1.0', changefreq: 'daily' },
    { url: '/jobs', priority: '0.9', changefreq: 'hourly' },
    { url: '/pricing', priority: '0.8', changefreq: 'weekly' },
    { url: '/about', priority: '0.7', changefreq: 'monthly' },
    { url: '/contact', priority: '0.7', changefreq: 'monthly' },
    { url: '/terms', priority: '0.6', changefreq: 'monthly' },
    { url: '/refund-policy', priority: '0.6', changefreq: 'monthly' },
    { url: '/privacy', priority: '0.6', changefreq: 'monthly' },
    { url: '/login', priority: '0.5', changefreq: 'monthly' },
    { url: '/register', priority: '0.5', changefreq: 'monthly' },
    { url: '/forgot-password', priority: '0.4', changefreq: 'monthly' }
  ];

  let dynamicJobUrls: string[] = [];

  try {
    const db = getDb();
    const jobsList = await db
      .select({
        id: jobPostings.id,
        createdAt: jobPostings.createdAt,
        publishedAt: jobPostings.publishedAt
      })
      .from(jobPostings)
      .where(
        and(
          eq(jobPostings.status, 'published'),
          eq(jobPostings.isDeleted, false)
        )
      )
      .orderBy(desc(jobPostings.createdAt))
      .all();

    if (Array.isArray(jobsList)) {
      dynamicJobUrls = jobsList.map(job => {
        let dateStr = now;
        const val = job.publishedAt || job.createdAt;
        if (val) {
          try {
            const d = typeof val === 'number' ? (val < 10000000000 ? new Date(val * 1000) : new Date(val)) : new Date(val);
            if (!isNaN(d.getTime())) dateStr = d.toISOString().split('T')[0];
          } catch (e) {}
        }
        return `  <url>
    <loc>${escapeXml(`${baseUrl}/jobs/${job.id}`)}</loc>
    <lastmod>${dateStr}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>0.9</priority>
  </url>`;
      });
    }
  } catch (e) {
    console.error('[sitemap] Database fetch skipped, using static pages only:', e);
  }

  const staticUrls = staticPages.map(page => `  <url>
    <loc>${escapeXml(`${baseUrl}${page.url}`)}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`);

  const allUrls = [...staticUrls, ...dynamicJobUrls];

  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allUrls.join('\n')}
</urlset>`;

  return new Response(sitemapXml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600'
    }
  });
};
