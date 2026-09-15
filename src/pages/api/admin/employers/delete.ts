import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { users, jobPostings, applications, notifications, recommendations } from '../../../../db/schema';
import { eq, inArray } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  // @ts-ignore
  const user = locals.user;

  if (!user || (user.userType !== 'admin' && user.userType !== 'superadmin' && user.userType !== 'masteradmin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized: Admin access required' }), { 
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const data = await request.json();
    const { userId, userIds } = data;

    const idsToDelete: string[] = [];
    if (Array.isArray(userIds) && userIds.length > 0) {
      idsToDelete.push(...userIds.map((id: any) => String(id)));
    } else if (userId) {
      idsToDelete.push(String(userId));
    }

    if (idsToDelete.length === 0) {
      return new Response(JSON.stringify({ error: 'Employer User ID or User IDs array is required' }), { status: 400 });
    }

    const db = getDb();

    const BATCH_SIZE = 50;
    for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
      const chunk = idsToDelete.slice(i, i + BATCH_SIZE);

      // Find all job postings created by these employers
      const employerJobs = await db.select({ id: jobPostings.id })
        .from(jobPostings)
        .where(inArray(jobPostings.employerId, chunk))
        .all();

      const jobIds = employerJobs.map(j => j.id);

      if (jobIds.length > 0) {
        for (let j = 0; j < jobIds.length; j += BATCH_SIZE) {
          const jobChunk = jobIds.slice(j, j + BATCH_SIZE);
          await db.delete(applications).where(inArray(applications.jobPostingId, jobChunk));
          await db.delete(recommendations).where(inArray(recommendations.jobPostingId, jobChunk));
        }
        await db.delete(jobPostings).where(inArray(jobPostings.employerId, chunk));
      }

      await db.delete(notifications).where(inArray(notifications.userId, chunk));
      await db.delete(users).where(inArray(users.id, chunk));
    }

    return new Response(JSON.stringify({
      success: true,
      message: `${idsToDelete.length} employer account(s) and all associated jobs deleted permanently.`,
      deletedCount: idsToDelete.length,
      deletedIds: idsToDelete
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Error deleting employer account(s):', error);
    return new Response(JSON.stringify({ error: error.message || 'Server error' }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
