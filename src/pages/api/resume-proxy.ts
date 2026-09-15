import type { APIRoute } from 'astro';

/**
 * Resume Proxy Endpoint
 * Fetches a resume from an external URL (e.g. Cloudinary raw uploads) and
 * streams it back with proper Content-Type/Content-Disposition headers so
 * the browser can render it inline as a PDF — without needing Google Docs Viewer.
 *
 * Handles signed URLs for restricted Cloudinary raw uploads.
 *
 * Usage: GET /api/resume-proxy?url=<encoded-external-url>
 */

const ALLOWED_DOMAINS = [
  'res.cloudinary.com',
  'cloudinary.com',
  'api.cloudinary.com',
  'storage.googleapis.com',
  'amazonaws.com',
  'pub-',          // Cloudflare R2 public buckets
];

const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt'];

// Default Cloudinary credentials (from Sanskar Construction config)
const CLOUDINARY_CLOUD_NAME = 'guuap5ie';
const CLOUDINARY_API_KEY = '231371681636823';
const CLOUDINARY_API_SECRET = 'ks-2r40k9FTApVROcsKizSkLYCw';

async function generateSignedCloudinaryUrl(publicId: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = `attachment=false&public_id=${publicId}&timestamp=${timestamp}&type=upload${CLOUDINARY_API_SECRET}`;
  const msgUint8 = new TextEncoder().encode(paramsToSign);
  const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const signature = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/raw/download?timestamp=${timestamp}&public_id=${encodeURIComponent(publicId)}&type=upload&attachment=false&signature=${signature}&api_key=${CLOUDINARY_API_KEY}`;
}

export const GET: APIRoute = async ({ url }) => {
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Security: Only allow trusted domains
  const hostname = parsedUrl.hostname;
  const isAllowed = ALLOWED_DOMAINS.some(domain => hostname.includes(domain));
  if (!isAllowed) {
    return new Response(JSON.stringify({ error: 'Domain not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Security: Only allow document file types
  const pathname = parsedUrl.pathname.toLowerCase();
  const hasAllowedExt = ALLOWED_EXTENSIONS.some(ext => pathname.endsWith(ext));
  if (!hasAllowedExt) {
    return new Response(JSON.stringify({ error: 'File type not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    let upstream: Response | null = null;

    // Check if URL is Cloudinary URL that might require signature
    if (hostname.includes('cloudinary.com')) {
      const match = targetUrl.match(/\/(?:raw|image)\/upload\/(?:v\d+\/)?(.+)$/);
      if (match && match[1]) {
        const publicId = decodeURIComponent(match[1]);
        try {
          const signedUrl = await generateSignedCloudinaryUrl(publicId);
          const signedFetch = await fetch(signedUrl);
          if (signedFetch.ok) {
            upstream = signedFetch;
          }
        } catch (err) {
          console.warn('[resume-proxy] Signed fetch attempt failed:', err);
        }
      }
    }

    // Fallback to direct fetch if signed fetch wasn't used or failed
    if (!upstream || !upstream.ok) {
      upstream = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });
    }

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: `Upstream error: ${upstream.status} ${upstream.statusText}` }),
        { status: upstream.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Determine content type
    let contentType = upstream.headers.get('Content-Type') || 'application/octet-stream';
    if (pathname.endsWith('.pdf')) contentType = 'application/pdf';
    else if (pathname.endsWith('.docx')) contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    else if (pathname.endsWith('.doc')) contentType = 'application/msword';

    // Extract a clean filename from the URL path
    const rawFilename = parsedUrl.pathname.split('/').pop() || 'resume.pdf';
    const filename = decodeURIComponent(rawFilename);

    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', contentType);
    responseHeaders.set('Content-Disposition', `inline; filename="${filename}"`);
    responseHeaders.set('Cache-Control', 'private, max-age=3600');
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(upstream.body, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err: any) {
    console.error('[resume-proxy] Fetch error:', err);
    return new Response(JSON.stringify({ error: 'Failed to fetch resume from upstream' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
