import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { users, applications, notifications, recommendations, jobSearches, userBehavior } from '../../../../db/schema';
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
      return new Response(JSON.stringify({ error: 'User ID or User IDs array is required' }), { status: 400 });
    }

    const db = getDb();

    const BATCH_SIZE = 50;
    for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
      const chunk = idsToDelete.slice(i, i + BATCH_SIZE);

      if (user.userType !== 'masteradmin') {
        const targetUsers = await db.select({ id: users.id, userType: users.userType })
          .from(users)
          .where(inArray(users.id, chunk))
          .all();
        const hasMasterAdmin = targetUsers.some(u => u.userType === 'masteradmin');
        if (hasMasterAdmin) {
          return new Response(JSON.stringify({ error: 'Forbidden: Only MasterAdmin can delete a MasterAdmin account' }), { status: 403 });
        }
      }

      await db.delete(applications).where(inArray(applications.applicantId, chunk));
      await db.delete(recommendations).where(inArray(recommendations.employeeId, chunk));
      await db.delete(jobSearches).where(inArray(jobSearches.employeeId, chunk));
      await db.delete(userBehavior).where(inArray(userBehavior.userId, chunk));
      await db.delete(notifications).where(inArray(notifications.userId, chunk));
      await db.delete(users).where(inArray(users.id, chunk));
    }

    return new Response(JSON.stringify({
      success: true,
      message: `${idsToDelete.length} candidate account(s) and associated records deleted permanently.`,
      deletedCount: idsToDelete.length,
      deletedIds: idsToDelete
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Error deleting account(s):', error);
    return new Response(JSON.stringify({ error: error.message || 'Server error' }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
