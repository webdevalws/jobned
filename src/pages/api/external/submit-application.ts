import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { users, jobPostings, applications, notifications } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

export const OPTIONS: APIRoute = async () => {
  return new Response(null, {
    status: 204,
    headers: corsHeaders
  });
};

export const POST: APIRoute = async ({ request }) => {
  try {
    // 1. Verify API Key
    const authHeader = request.headers.get('Authorization');
    // Using import.meta.env for Astro environment variables, or a hardcoded fallback if not set yet.
    const expectedKey = import.meta.env.EXTERNAL_API_KEY || 'rn_live_8392jf9823f';
    
    if (!authHeader || authHeader !== `Bearer ${expectedKey}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Invalid API Key' }), { 
        status: 401,
        headers: corsHeaders
      });
    }

    // 2. Parse request data
    const data = await request.json();
    const { jobId, applicantEmail, applicantName, applicantPhone, resumeUrl, coverLetter, source } = data;

    if (!jobId || !applicantEmail || !applicantName) {
      return new Response(JSON.stringify({ error: 'Missing required fields: jobId, applicantEmail, applicantName' }), { 
        status: 400,
        headers: corsHeaders
      });
    }

    const db = getDb();

    // 3. Find or Create the Job Posting
    let job = null;
    const jobResults = await db.select().from(jobPostings).where(eq(jobPostings.id, jobId));
    if (jobResults.length > 0) {
      job = jobResults[0];
    } else {
      // Auto-create a dummy job for this external ID under masteradmin
      const masterAdmins = await db.select().from(users).where(eq(users.userType, 'masteradmin'));
      let ownerId = '';
      if (masterAdmins.length > 0) {
        ownerId = masterAdmins[0].id;
      } else {
        const superAdmins = await db.select().from(users).where(eq(users.userType, 'superadmin'));
        if (superAdmins.length === 0) {
          return new Response(JSON.stringify({ error: 'System configuration error: No admin found to own this external job.' }), { 
            status: 500,
            headers: corsHeaders
          });
        }
        ownerId = superAdmins[0].id;
      }

      const dummyJobId = `external_${jobId}`;
      
      let dummyJobs = await db.select().from(jobPostings).where(eq(jobPostings.id, dummyJobId));
      if (dummyJobs.length === 0) {
        await db.insert(jobPostings).values({
          id: dummyJobId,
          employerId: ownerId,
          jobTitle: jobId,
          description: 'Auto-generated placeholder job for external Website applications.',
          status: 'published'
        });
        dummyJobs = await db.select().from(jobPostings).where(eq(jobPostings.id, dummyJobId));
      }
      job = dummyJobs[0];
    }

    // 4. Find or Create the Applicant User
    let applicantId = '';
    const existingUsers = await db.select().from(users).where(eq(users.email, applicantEmail));
    
    if (existingUsers.length > 0) {
      applicantId = existingUsers[0].id;
    } else {
      // Create a new employee (candidate) record for them
      applicantId = crypto.randomUUID();
      const [firstName, ...lastNameArr] = applicantName.split(' ');
      const lastName = lastNameArr.join(' ') || '';

      await db.insert(users).values({
        id: applicantId,
        userType: 'external_applicant',
        email: applicantEmail,
        phone: applicantPhone || null,
        firstName: firstName,
        lastName: lastName,
        passwordHash: 'EXTERNAL_USER_NO_PASSWORD', // They authenticate via Website X
        verifiedStatus: 'verified', // Automatically verify since they came from a trusted external site
        isActive: true,
      });
    }

    // 5. Check if they already applied
    const existingApps = await db.select()
      .from(applications)
      .where(sql`${applications.jobPostingId} = ${job.id} AND ${applications.applicantId} = ${applicantId}`);
      
    if (existingApps.length > 0) {
      return new Response(JSON.stringify({ error: 'Applicant has already applied to this job' }), { 
        status: 409,
        headers: corsHeaders
      });
    }

    // 6. Insert the Application
    const applicationId = crypto.randomUUID();
    await db.insert(applications).values({
      id: applicationId,
      jobPostingId: job.id,
      applicantId: applicantId,
      employerId: job.employerId,
      resumeUrl: resumeUrl || '',
      coverLetter: coverLetter || null,
      notes: source ? (source.startsWith('Submitted via') ? source : `Submitted via ${source}`) : 'Submitted via Alightway Live Website',
      status: 'received',
      statusHistory: [{ status: 'received', updated_at: new Date().toISOString() }]
    });

    // 7. Create notifications (ONLY for masteradmin and employer if owned by an employer)
    const notificationsToInsert: any[] = [];

    // If job is owned by a regular employer, notify that employer
    if (job.employerId) {
      const owner = await db.select({ userType: users.userType }).from(users).where(eq(users.id, job.employerId)).get();
      if (owner && owner.userType === 'employer') {
        notificationsToInsert.push({
          id: crypto.randomUUID(),
          userId: job.employerId,
          title: 'New External Application',
          message: `${applicantName} just applied for your job "${job.jobTitle}" via your external website!`,
          type: 'alert',
          isRead: false,
          createdAt: new Date()
        });
      }
    }

    // Send notifications ONLY to masteradmin users (exclude superadmin and admin)
    try {
      const masterAdmins = await db.select({ id: users.id })
                                   .from(users)
                                   .where(eq(users.userType, 'masteradmin')).all();
      
      if (masterAdmins.length > 0) {
        masterAdmins.forEach(mAdmin => {
          if (!notificationsToInsert.some(n => n.userId === mAdmin.id)) {
            notificationsToInsert.push({
              id: crypto.randomUUID(),
              userId: mAdmin.id,
              title: 'New External Application Submitted',
              message: `${applicantName} has submitted an external application for "${job.jobTitle}".`,
              type: 'system',
              isRead: false,
              createdAt: new Date()
            });
          }
        });
      }
    } catch (adminNotifErr) {
      console.error('Failed to create masteradmin notifications', adminNotifErr);
    }

    if (notificationsToInsert.length > 0) {
      await db.insert(notifications).values(notificationsToInsert);
    }

    // Success response
    return new Response(JSON.stringify({ 
      success: true, 
      message: 'Application successfully synced to JobNed',
      applicationId: applicationId
    }), { 
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error("External API Error:", error);
    return new Response(JSON.stringify({ error: error.message || 'Internal Server Error' }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
// We need 'sql' from drizzle-orm for the application check
import { sql } from 'drizzle-orm';
