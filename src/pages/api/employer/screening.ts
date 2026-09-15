import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { applications, jobPostings, users, messages, notifications } from '../../../db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { rankCandidatesList, type CandidateProfile, type JobCriteria } from '../../../lib/candidate-ranker';

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    // @ts-ignore
    const payload = locals.user;
    if (!payload || payload.userType !== 'employer') {
      return new Response(JSON.stringify({ error: 'Unauthorized employer access' }), { status: 401 });
    }

    const url = new URL(request.url);
    const jobId = url.searchParams.get('jobId');
    const mode = url.searchParams.get('mode') || 'applied'; // 'applied' | 'talent_pool'

    const db = getDb();

    // 1. Fetch employer's active jobs
    const employerJobs = await db
      .select({
        id: jobPostings.id,
        jobTitle: jobPostings.jobTitle,
        description: jobPostings.description,
        requirements: jobPostings.requirements,
        experienceLevel: jobPostings.experienceLevel,
        locationCity: jobPostings.locationCity,
        locationRemote: jobPostings.locationRemote,
        employmentType: jobPostings.employmentType,
        status: jobPostings.status,
      })
      .from(jobPostings)
      .where(eq(jobPostings.employerId, payload.userId))
      .all();

    if (employerJobs.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        jobs: [],
        selectedJob: null,
        rankedCandidates: [],
        stats: { total: 0, topMatches: 0, strongMatches: 0, moderateMatches: 0, lowMatches: 0, avgScore: 0 }
      }), { status: 200 });
    }

    // Determine target job
    const targetJob = (jobId ? employerJobs.find(j => j.id === jobId) : employerJobs[0]) || employerJobs[0];

    const jobCriteria: JobCriteria = {
      id: targetJob.id,
      jobTitle: targetJob.jobTitle,
      description: targetJob.description || '',
      requirements: targetJob.requirements,
      experienceLevel: targetJob.experienceLevel,
      locationCity: targetJob.locationCity,
      locationRemote: targetJob.locationRemote,
      employmentType: targetJob.employmentType,
    };

    let candidateProfiles: CandidateProfile[] = [];

    if (mode === 'applied') {
      // Fetch applicants for this specific job
      const apps = await db
        .select({
          applicationId: applications.id,
          applicationStatus: applications.status,
          appliedAt: applications.appliedAt,
          resumeUrl: applications.resumeUrl,
          coverLetter: applications.coverLetter,
          candidateId: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          phone: users.phone,
          location: users.location,
          skills: users.skills,
          experienceYears: users.experienceYears,
          bio: users.bio,
          verifiedStatus: users.verifiedStatus,
        })
        .from(applications)
        .innerJoin(users, eq(applications.applicantId, users.id))
        .where(
          and(
            eq(applications.jobPostingId, targetJob.id),
            eq(applications.employerId, payload.userId)
          )
        )
        .all();

      candidateProfiles = apps.map(a => ({
        id: a.candidateId,
        applicationId: a.applicationId,
        applicationStatus: a.applicationStatus,
        appliedAt: a.appliedAt,
        resumeUrl: a.resumeUrl,
        coverLetter: a.coverLetter,
        firstName: a.firstName,
        lastName: a.lastName,
        email: a.email,
        phone: a.phone,
        location: a.location,
        skills: a.skills,
        experienceYears: a.experienceYears,
        bio: a.bio,
        verifiedStatus: a.verifiedStatus,
      }));
    } else {
      // Talent Pool Mode: Fetch all registered job seekers in JobNed
      const allSeekers = await db
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          phone: users.phone,
          location: users.location,
          skills: users.skills,
          experienceYears: users.experienceYears,
          bio: users.bio,
          verifiedStatus: users.verifiedStatus,
          resumeUrl: users.defaultResumeUrl,
        })
        .from(users)
        .where(eq(users.userType, 'employee'))
        .all();

      // Check if any of these already applied
      const existingApps = await db
        .select({
          applicantId: applications.applicantId,
          applicationId: applications.id,
          status: applications.status,
        })
        .from(applications)
        .where(eq(applications.jobPostingId, targetJob.id))
        .all();

      const appMap = new Map(existingApps.map(a => [a.applicantId, a]));

      candidateProfiles = allSeekers.map(s => {
        const app = appMap.get(s.id);
        return {
          id: s.id,
          firstName: s.firstName,
          lastName: s.lastName,
          email: s.email,
          phone: s.phone,
          location: s.location,
          skills: s.skills,
          experienceYears: s.experienceYears,
          bio: s.bio,
          verifiedStatus: s.verifiedStatus,
          resumeUrl: s.resumeUrl,
          applicationId: app?.applicationId || null,
          applicationStatus: app?.status || null,
        };
      });
    }

    // Rank candidates using the AI engine
    const ranked = rankCandidatesList(candidateProfiles, jobCriteria);

    const total = ranked.length;
    const topMatches = ranked.filter(r => r.tier === 'top').length;
    const strongMatches = ranked.filter(r => r.tier === 'strong').length;
    const moderateMatches = ranked.filter(r => r.tier === 'moderate').length;
    const lowMatches = ranked.filter(r => r.tier === 'low').length;
    const totalScore = ranked.reduce((acc, r) => acc + r.overallScore, 0);
    const avgScore = total > 0 ? Math.round(totalScore / total) : 0;

    return new Response(JSON.stringify({
      success: true,
      jobs: employerJobs,
      selectedJob: targetJob,
      mode,
      rankedCandidates: ranked,
      stats: {
        total,
        topMatches,
        strongMatches,
        moderateMatches,
        lowMatches,
        avgScore,
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('Error in AI candidate screening API:', error);
    return new Response(JSON.stringify({ error: error.message || 'Screening engine failed' }), { status: 500 });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    // @ts-ignore
    const payload = locals.user;
    if (!payload || payload.userType !== 'employer') {
      return new Response(JSON.stringify({ error: 'Unauthorized employer access' }), { status: 401 });
    }

    const data = await request.json();
    const { action, applicationId, candidateId, jobId } = data;

    const db = getDb();

    if (action === 'update_status' && applicationId) {
      const { newStatus } = data;
      if (!['received', 'under_review', 'shortlisted', 'accepted', 'rejected'].includes(newStatus)) {
        return new Response(JSON.stringify({ error: 'Invalid application status' }), { status: 400 });
      }

      await db
        .update(applications)
        .set({ status: newStatus })
        .where(
          and(
            eq(applications.id, applicationId),
            eq(applications.employerId, payload.userId)
          )
        );

      return new Response(JSON.stringify({ success: true, message: `Application status updated to ${newStatus}` }), { status: 200 });
    }

    if (action === 'batch_shortlist' && Array.isArray(data.applicationIds)) {
      for (const appId of data.applicationIds) {
        await db
          .update(applications)
          .set({ status: 'shortlisted' })
          .where(
            and(
              eq(applications.id, appId),
              eq(applications.employerId, payload.userId)
            )
          );
      }
      return new Response(JSON.stringify({ success: true, count: data.applicationIds.length }), { status: 200 });
    }

    if (action === 'invite_talent' && candidateId && jobId) {
      const job = await db.select().from(jobPostings).where(eq(jobPostings.id, jobId)).get();
      if (!job) {
        return new Response(JSON.stringify({ error: 'Job not found' }), { status: 404 });
      }

      const notifId = crypto.randomUUID();
      await db.insert(notifications).values({
        id: notifId,
        userId: candidateId,
        title: '🌟 Employer Invitation',
        message: `An employer screened your profile and invited you to apply for "${job.jobTitle}". Link: /jobs/${job.id}`,
        type: 'invitation',
        isRead: false,
      });

      return new Response(JSON.stringify({ success: true, message: 'Invitation sent successfully' }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400 });
  } catch (error: any) {
    console.error('Error in screening action POST:', error);
    return new Response(JSON.stringify({ error: error.message || 'Action failed' }), { status: 500 });
  }
};
