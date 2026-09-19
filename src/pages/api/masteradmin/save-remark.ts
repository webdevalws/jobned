import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { applications } from '../../../db/schema';
import { eq } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  // Check authorization for masteradmin / superadmin
  const user = (locals as any).user;
  if (!user || (user.userType !== 'masteradmin' && user.userType !== 'superadmin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized. Admin privileges required.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const data = await request.json();
    const applicationId = data.applicationId || data.id;
    const remarks = typeof data.remarks === 'string' ? data.remarks.trim() : null;

    if (!applicationId) {
      return new Response(JSON.stringify({ error: 'Application ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb();
    const updated = await db
      .update(applications)
      .set({
        remarks: remarks || null,
        updatedAt: new Date(),
      })
      .where(eq(applications.id, applicationId))
      .returning({ id: applications.id, remarks: applications.remarks });

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Remark saved successfully',
        applicationId,
        remarks: remarks || null,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    console.error('Error saving applicant remark:', error);
    return new Response(
      JSON.stringify({ error: error?.message || 'Failed to save remark' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
