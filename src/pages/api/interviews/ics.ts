import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { interviews, jobPostings, users } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { generateICSContent } from '../../../lib/calendar';

export const GET: APIRoute = async ({ url, locals }) => {
  const interviewId = url.searchParams.get('id');
  if (!interviewId) {
    return new Response('Missing interview id', { status: 400 });
  }

  try {
    const db = getDb();
    const item = await db.select({
      id: interviews.id,
      title: interviews.title,
      interviewType: interviews.interviewType,
      meetingLink: interviews.meetingLink,
      scheduledAt: interviews.scheduledAt,
      durationMinutes: interviews.durationMinutes,
      notes: interviews.notes,
      interviewerNames: interviews.interviewerNames,
      jobTitle: jobPostings.jobTitle,
      companyName: users.companyName,
      employerFirstName: users.firstName,
      employerLastName: users.lastName
    })
    .from(interviews)
    .innerJoin(jobPostings, eq(interviews.jobPostingId, jobPostings.id))
    .innerJoin(users, eq(interviews.employerId, users.id))
    .where(eq(interviews.id, interviewId))
    .get();

    if (!item) {
      return new Response('Interview not found', { status: 404 });
    }

    const description = [
      `Interview for ${item.jobTitle} with ${item.companyName || 'JobNed Employer'}.`,
      item.interviewerNames ? `Interviewers: ${item.interviewerNames}` : '',
      item.meetingLink ? `Meeting Link / Location: ${item.meetingLink}` : '',
      item.notes ? `\nAgenda / Instructions:\n${item.notes}` : '',
      '\nScheduled via JobNed.'
    ].filter(Boolean).join('\n');

    const icsString = generateICSContent({
      title: item.title,
      description,
      location: item.meetingLink || 'Online Video Meeting',
      startTime: item.scheduledAt,
      durationMinutes: item.durationMinutes || 45,
      organizerName: item.companyName || `${item.employerFirstName} ${item.employerLastName}`
    });

    const safeFilename = `interview-${item.title.replace(/[^a-zA-Z0-9]/g, '_')}.ics`;

    return new Response(icsString, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeFilename}"`,
        'Cache-Control': 'no-cache'
      }
    });

  } catch (err: any) {
    console.error('Error generating .ics file:', err);
    return new Response('Failed to generate calendar file', { status: 500 });
  }
};
