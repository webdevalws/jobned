import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '../../../lib/db';
import { users, jobPostings, notifications } from '../../../db/schema';
import { eq } from 'drizzle-orm';

export const GET: APIRoute = async ({ request, locals }) => {
  // CRON Job endpoint to generate daily digests
  // Secure this endpoint in production!
  const authHeader = request.headers.get('Authorization');
  // if (authHeader !== `Bearer ${import.meta.env.CRON_SECRET}`) return new Response('Unauthorized', { status: 401 });

  try {
    const db = getDb();
    const workerEnv = (env as any) || process.env;

    // 1. Fetch all employees looking for jobs
    const candidates = await db.select().from(users).where(eq(users.userType, 'employee')).all();

    // 2. Fetch recent jobs
    // In a real implementation, we would use the Vectorize index to match candidate embeddings 
    // to the newest job embeddings!

    // 3. Generate Notifications / Emails
    let emailsSent = 0;
    for (const candidate of candidates) {
      // Mock sending an email via Resend
      if (workerEnv?.RESEND_API_KEY && candidate.email) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${workerEnv.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'JobNed <noreply@yourdomain.com>',
            to: [candidate.email],
            subject: 'Your Daily Job Matches',
            html: '<p>Here are 5 new jobs perfectly matched to your profile!</p>'
          })
        });
        emailsSent++;
      }

      // Fallback: Create in-app notification
      await db.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: candidate.id,
        title: 'New Daily Matches!',
        message: 'We found 5 new jobs matching your profile.',
        type: 'alert'
      });
    }

    return new Response(JSON.stringify({ success: true, emailsSent }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error("Cron Digest Error:", error);
    return new Response(JSON.stringify({ error: "Failed to run cron" }), { status: 500 });
  }
};
