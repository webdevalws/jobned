import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ params, locals }) => {
  try {
    // Authentication check removed so Google Docs Viewer can fetch the file.
    // Security relies on the unguessable UUID filename.
    const { filename } = params;
    if (!filename) {
      return new Response('Filename is required', { status: 400 });
    }

    // Ensure it's a PDF or supported image to prevent serving malicious files
    const extMatch = filename.match(/\.(pdf|png|jpg|jpeg|webp)$/i);
    if (!extMatch) {
      return new Response('Invalid file type', { status: 400 });
    }

    // @ts-ignore
    const bucket = env?.BUCKET;
    if (!bucket) {
      return new Response('Storage bucket not configured', { status: 503 });
    }
    const object = await bucket.get(filename);

    if (object === null) {
      return new Response('File not found', { status: 404 });
    }

    const ext = extMatch[1].toLowerCase();
    let contentType = 'application/pdf';
    if (ext === 'png') contentType = 'image/png';
    else if (ext === 'jpg' || ext === 'jpeg') contentType = 'image/jpeg';
    else if (ext === 'webp') contentType = 'image/webp';

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Content-Type', contentType);
    headers.set('Content-Disposition', `inline; filename="${filename}"`);
    headers.set('etag', object.httpEtag);
    headers.set('Cache-Control', 'private, max-age=3600'); // Cache for 1 hour

    return new Response(object.body, { headers });
  } catch (error: any) {
    console.error('Error fetching file:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};
