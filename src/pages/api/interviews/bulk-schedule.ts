import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { interviews, applications, jobPostings, users, notifications } from '../../../db/schema';
import { eq, and, inArray } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user || user.userType !== 'employer') {
      return new Response(JSON.stringify({ error: 'Unauthorized. Employer access required.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await request.json().catch(() => ({}));
    const {
      applicationIds = [],
      title,
      interviewType = 'video',
      meetingLink,
      startAt,
      durationMinutes = 30,
      slotMode = 'staggered',
      bufferMinutes = 5,
      notes = '',
      interviewerNames = '',
      timezone = 'UTC'
    } = body;

    if (!Array.isArray(applicationIds) || applicationIds.length === 0) {
      return new Response(JSON.stringify({ error: 'Please select at least one candidate/application.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!title || !title.trim()) {
      return new Response(JSON.stringify({ error: 'Interview Title is required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!startAt) {
      return new Response(JSON.stringify({ error: 'Start Date & Time is required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const startAtDate = new Date(startAt);
    if (isNaN(startAtDate.getTime())) {
      return new Response(JSON.stringify({ error: 'Invalid startAt date format.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb();

    // Fetch verified applications belonging to this employer
    const validApps = await db.select({
      id: applications.id,
      applicantId: applications.applicantId,
      employerId: applications.employerId,
      jobPostingId: applications.jobPostingId,
      status: applications.status,
      jobTitle: jobPostings.jobTitle,
      candidateFirstName: users.firstName,
      candidateLastName: users.lastName,
      candidateEmail: users.email
    })
    .from(applications)
    .innerJoin(jobPostings, eq(applications.jobPostingId, jobPostings.id))
    .innerJoin(users, eq(applications.applicantId, users.id))
    .where(and(
      inArray(applications.id, applicationIds),
      eq(applications.employerId, user.userId)
    ))
    .all();

    if (validApps.length === 0) {
      return new Response(JSON.stringify({ error: 'No matching authorized applications found to schedule.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const durationNum = Math.max(5, parseInt(durationMinutes, 10) || 30);
    const bufferNum = Math.max(0, parseInt(bufferMinutes, 10) || 0);
    const stepMs = (durationNum + bufferNum) * 60 * 1000;

    let scheduledCount = 0;
    const now = new Date();

    for (let i = 0; i < validApps.length; i++) {
      const app = validApps[i];
      const slotTime = slotMode === 'group'
        ? new Date(startAtDate.getTime())
        : new Date(startAtDate.getTime() + (i * stepMs));

      const interviewId = crypto.randomUUID();

      // 1. Insert individual interview entry
      await db.insert(interviews).values({
        id: interviewId,
        applicationId: app.id,
        jobPostingId: app.jobPostingId,
        employerId: user.userId,
        candidateId: app.applicantId,
        title: title.trim(),
        interviewType,
        meetingLink: meetingLink?.trim() || null,
        scheduledAt: slotTime,
        durationMinutes: durationNum,
        status: 'scheduled',
        notes: notes?.trim() || null,
        interviewerNames: interviewerNames?.trim() || null,
        timezone: timezone || 'UTC',
        createdAt: now,
        updatedAt: now
      });

      // 2. Automatically advance application status to 'shortlisted' if currently received or under_review
      if (app.status === 'received' || app.status === 'under_review') {
        await db.update(applications)
          .set({
            status: 'shortlisted',
            updatedAt: now
          })
          .where(and(
            eq(applications.id, app.id),
            eq(applications.employerId, user.userId)
          ));
      }

      // 3. Deliver rich in-app notification directly to candidate's Notifications section
      const formattedDateStr = slotTime.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
      const formattedTimeStr = slotTime.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit'
      });

      const typeLabel = interviewType === 'video' ? 'Video Call' : interviewType === 'phone' ? 'Phone Screening' : 'In-Person Round';
      const notifMsg = `You have been scheduled for an interview for "${app.jobTitle}" (${title.trim()}) on ${formattedDateStr} at ${formattedTimeStr} (${durationNum} mins). Format: ${typeLabel}. Check your Interviews section to view details, join link, and sync with your calendar.`;

      try {
        await db.insert(notifications).values({
          id: crypto.randomUUID(),
          userId: app.applicantId,
          title: `📅 Interview Scheduled: ${app.jobTitle}`,
          message: notifMsg,
          type: 'interview',
          isRead: false,
          createdAt: now
        });
      } catch (notifErr) {
        console.error('Failed to dispatch candidate notification for app', app.id, notifErr);
      }

      scheduledCount++;
    }

    return new Response(JSON.stringify({
      success: true,
      count: scheduledCount,
      message: `Successfully scheduled ${scheduledCount} candidate interview(s) with student notifications delivered.`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Error in bulk-schedule API:', error);
    return new Response(JSON.stringify({
      error: error.message || 'Internal server error while scheduling bulk interviews.'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
