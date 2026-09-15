import type { APIRoute } from 'astro';
import { getDb } from '../lib/db';
import { jobPostings } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getBaseUrl } from '../lib/config';

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
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

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const reqUrl = new URL(request.url);
    const origin = reqUrl.origin;
    
    let baseUrl = getBaseUrl(locals?.runtime?.env);
    if (origin && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
      baseUrl = origin.replace(/\/+$/, '');
    }

    const now = new Date().toISOString().split('T')[0];

    const staticPages = [
      { url: '/', priority: '1.0', changefreq: 'daily' },
      { url: '/jobs', priority: '0.9', changefreq: 'hourly' },
      { url: '/pricing', priority: '0.8', changefreq: 'weekly' },
      { url: '/about', priority: '0.7', changefreq: 'monthly' },
      { url: '/privacy', priority: '0.6', changefreq: 'monthly' },
      { url: '/login', priority: '0.5', changefreq: 'monthly' },
      { url: '/register', priority: '0.5', changefreq: 'monthly' }
    ];

    let jobsList: any[] = [];
    try {
      const db = getDb();
      jobsList = await db
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
    } catch (e) {
      console.error('Error fetching jobs for sitemap:', e);
    }

    const formatDate = (val: any) => {
      if (!val) return now;
      try {
        const d = typeof val === 'number' ? (val < 10000000000 ? new Date(val * 1000) : new Date(val)) : new Date(val);
        return isNaN(d.getTime()) ? now : d.toISOString().split('T')[0];
      } catch (e) {
        return now;
      }
    };

    const xmlUrls = [
      ...staticPages.map(page => `  <url>
    <loc>${escapeXml(`${baseUrl}${page.url}`)}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`),
      ...(jobsList || []).map(job => `  <url>
    <loc>${escapeXml(`${baseUrl}/jobs/${job.id}`)}</loc>
    <lastmod>${formatDate(job.publishedAt || job.createdAt)}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>0.9</priority>
  </url>`)
    ];

    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${xmlUrls.join('\n')}
</urlset>`;

    return new Response(sitemapXml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600'
      }
    });
  } catch (err) {
    console.error('Sitemap generation error:', err);
    return new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', {
      status: 200,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' }
    });
  }
};

