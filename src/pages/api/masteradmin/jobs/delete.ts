import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { jobPostings } from '../../../../db/schema';
import { eq, inArray } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  // @ts-ignore
  const user = locals.user;

  if (!user || (user.userType !== 'masteradmin' && user.userType !== 'superadmin' && user.userType !== 'admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized. Admin access required.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const { jobId, jobIds } = body;

    const idsToDelete: string[] = [];
    if (Array.isArray(jobIds) && jobIds.length > 0) {
      idsToDelete.push(...jobIds.map((id: any) => String(id)));
    } else if (jobId) {
      idsToDelete.push(String(jobId));
    }

    if (idsToDelete.length === 0) {
      return new Response(JSON.stringify({ error: 'Job ID or Job IDs array is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb();

    // Perform soft deletion in chunks of 50 to stay within Cloudflare D1 / SQLite SQL parameter limits
    const BATCH_SIZE = 50;
    for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
      const chunk = idsToDelete.slice(i, i + BATCH_SIZE);
      if (chunk.length === 1) {
        await db.update(jobPostings)
          .set({ isDeleted: true, status: 'closed' })
          .where(eq(jobPostings.id, chunk[0]));
      } else {
        await db.update(jobPostings)
          .set({ isDeleted: true, status: 'closed' })
          .where(inArray(jobPostings.id, chunk));
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `${idsToDelete.length} job(s) deleted successfully`,
      deletedCount: idsToDelete.length,
      deletedIds: idsToDelete
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('Error deleting job(s) in MasterAdmin:', error);
    return new Response(JSON.stringify({ error: 'Failed to delete job(s)', details: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

