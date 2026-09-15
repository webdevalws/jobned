import type { APIRoute } from 'astro';

import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ params, locals }) => {
  const { path } = params;
  if (!path) {
    return new Response('Not found', { status: 404 });
  }

  // @ts-ignore
  const bucket = env?.BUCKET;
  if (!bucket) {
    return new Response('Bucket not configured', { status: 500 });
  }

  try {
    const object = await bucket.get(path);
    if (!object) {
      return new Response('Not found', { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=31536000');

    // Guess content type from path
    const ext = path.split('.').pop()?.toLowerCase();
    if (ext === 'png') headers.set('Content-Type', 'image/png');
    else if (ext === 'jpg' || ext === 'jpeg') headers.set('Content-Type', 'image/jpeg');
    else if (ext === 'gif') headers.set('Content-Type', 'image/gif');
    else if (ext === 'webp') headers.set('Content-Type', 'image/webp');
    else if (ext === 'svg') headers.set('Content-Type', 'image/svg+xml');
    else if (ext === 'pdf') headers.set('Content-Type', 'application/pdf');
    else headers.set('Content-Type', 'application/octet-stream');

    headers.set('Content-Disposition', 'inline');

    return new Response(object.body, {
      headers,
    });
  } catch (error: any) {
    return new Response(error.message, { status: 500 });
  }
};
