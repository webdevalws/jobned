import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { applications, jobPostings, users, plans } from '../../../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { rankCandidateForJob, type CandidateProfile, type JobCriteria } from '../../../lib/candidate-ranker';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    // @ts-ignore
    const user = locals.user;
    if (user.userType !== 'employee') {
      return new Response(JSON.stringify({ error: 'Only employees/students can apply for jobs' }), { status: 403 });
    }

    const db = getDb();
    const candidateRecord = await db.select().from(users).where(eq(users.id, user.userId)).get();

    if (candidateRecord && candidateRecord.isActive === false) {
      return new Response(JSON.stringify({ error: 'Your candidate account has been suspended by an administrator. Job application is disabled.' }), { status: 403 });
    }

    if (candidateRecord && candidateRecord.verifiedStatus === 'rejected') {
      return new Response(JSON.stringify({ error: 'Your candidate account has been rejected by an administrator. Please contact support.' }), { status: 403 });
    }

    const formData = await request.formData();
    const jobPostingId = formData.get('jobPostingId') as string;
    const useDefaultResume = formData.get('useDefaultResume') === 'true';
    const saveAsDefault = formData.get('saveAsDefault') === 'true';
    const coverLetter = formData.get('coverLetter') as string || null;
    let linkedinUrl = (formData.get('linkedinUrl') as string || '').trim();
    let portfolioUrl = (formData.get('portfolioUrl') as string || '').trim();
    const resumeFile = formData.get('resume') as File | null;
    const photoFile = formData.get('photo') as File | null;

    if (!jobPostingId) {
      return new Response(JSON.stringify({ error: 'Job ID is required' }), { status: 400 });
    }

    // Fallback to candidate profile links if not provided in form
    if (!linkedinUrl && candidateRecord?.linkedinUrl) {
      linkedinUrl = candidateRecord.linkedinUrl;
    }
    if (!portfolioUrl && candidateRecord?.portfolioUrl) {
      portfolioUrl = candidateRecord.portfolioUrl;
    }

    let normalizedLinkedin = (linkedinUrl || '').trim();
    if (normalizedLinkedin && !/^https?:\/\//i.test(normalizedLinkedin)) {
      normalizedLinkedin = 'https://' + normalizedLinkedin;
    }

    const linkedinRegex = /^https?:\/\/(www\.)?linkedin\.com\/(in|pub|profile)\/[a-zA-Z0-9%\-_]+(\/.*)?$/i;
    if (!normalizedLinkedin || !linkedinRegex.test(normalizedLinkedin)) {
      return new Response(JSON.stringify({
        error: 'Invalid LinkedIn profile URL. Please provide a valid URL like https://linkedin.com/in/yourprofile'
      }), { status: 400 });
    }

    let normalizedPortfolio = (portfolioUrl || '').trim();
    if (normalizedPortfolio && !/^https?:\/\//i.test(normalizedPortfolio)) {
      normalizedPortfolio = 'https://' + normalizedPortfolio;
    }

    // @ts-ignore
    const bucket = env?.BUCKET;
    let resumeArrayBuffer: ArrayBuffer | null = null;
    let resumeContentType = 'application/pdf';

    const hasNewResumeFile = resumeFile && resumeFile instanceof File && resumeFile.size > 0;

    if (useDefaultResume || !hasNewResumeFile) {
      // Must have default resume configured
      if (!candidateRecord?.defaultResumeUrl) {
        return new Response(JSON.stringify({
          error: 'No default resume found in your profile. Please upload a resume PDF to apply.'
        }), { status: 400 });
      }

      // Fetch resume from R2 or base64 or external URL
      const defaultUrl = candidateRecord.defaultResumeUrl;
      if (defaultUrl.startsWith('data:application/pdf;base64,')) {
        try {
          const base64Str = defaultUrl.replace(/^data:application\/pdf;base64,/, '');
          const binaryStr = atob(base64Str);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          resumeArrayBuffer = bytes.buffer;
        } catch (b64Err) {
          console.warn('Error parsing base64 default resume:', b64Err);
        }
      } else if (defaultUrl.startsWith('/api/resumes/')) {
        const r2Key = defaultUrl.replace('/api/resumes/', '');
        if (bucket) {
          try {
            const obj = await bucket.get(r2Key);
            if (obj) {
              resumeArrayBuffer = await obj.arrayBuffer();
            }
          } catch (r2Err) {
            console.warn('Error fetching default resume from R2:', r2Err);
          }
        }
      }

      if (!resumeArrayBuffer) {
        try {
          const fetchRes = await fetch(defaultUrl.startsWith('/') ? new URL(defaultUrl, request.url).href : defaultUrl);
          if (fetchRes.ok) {
            resumeArrayBuffer = await fetchRes.arrayBuffer();
          }
        } catch (fetchErr) {
          console.warn('Could not fetch default resume buffer:', fetchErr);
        }
      }

      if (!resumeArrayBuffer) {
        return new Response(JSON.stringify({
          error: 'Could not load your default resume file. Please upload a new resume.'
        }), { status: 400 });
      }
    } else {
      // Custom uploaded resume
      if (resumeFile.size > 5 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'Resume must be less than 5MB' }), { status: 400 });
      }

      if (resumeFile.type !== 'application/pdf') {
        return new Response(JSON.stringify({ error: 'Only PDF files are allowed for resume' }), { status: 400 });
      }

      resumeArrayBuffer = await resumeFile.arrayBuffer();
      resumeContentType = resumeFile.type;
    }

    let photoUrl: string | null = candidateRecord?.avatarUrl || null;
    if (photoFile && photoFile instanceof File && photoFile.size > 0) {
      if (photoFile.size > 5 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'Photo must be less than 5MB' }), { status: 400 });
      }
      if (!photoFile.type.startsWith('image/')) {
        return new Response(JSON.stringify({ error: 'Only image files (PNG, JPG, WEBP) are allowed for photo' }), { status: 400 });
      }
    }

    const job = await db.select().from(jobPostings).where(eq(jobPostings.id, jobPostingId)).get();

    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), { status: 404 });
    }

    if (job.status !== 'published') {
      return new Response(JSON.stringify({ error: 'This job is no longer accepting applications' }), { status: 400 });
    }

    // --- candidate monthly apply quota check ---
    let candidateApplyLimit = 200;
    if (candidateRecord && candidateRecord.planId) {
      const planRecord = await db.select().from(plans).where(eq(plans.planId, candidateRecord.planId)).get();
      if (planRecord) {
        candidateApplyLimit = planRecord.candidateApplyLimit;
      }
    }

    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const candidateAppliedCountRecord = await db.select({ count: sql<number>`count(*)` })
      .from(applications)
      .where(and(
        eq(applications.applicantId, user.userId),
        sql`${applications.appliedAt} >= ${Math.floor(currentMonthStart.getTime() / 1000)}`
      ))
      .get();
    const candidateAppliedCount = candidateAppliedCountRecord?.count || 0;

    if (candidateAppliedCount >= candidateApplyLimit) {
      return new Response(JSON.stringify({ error: `Monthly application limit reached (${candidateApplyLimit} applications allowed). Please upgrade your plan.` }), { status: 403 });
    }

    // --- employer received resumes limit check ---
    let employerResumeLimit = 500; // default for basic
    const employerRecord = await db.select().from(users).where(eq(users.id, job.employerId)).get();
    if (employerRecord && employerRecord.planId) {
      const employerPlanRecord = await db.select().from(plans).where(eq(plans.planId, employerRecord.planId)).get();
      if (employerPlanRecord) {
        employerResumeLimit = employerPlanRecord.resumeLimit;
      }
    }

    const employerReceivedCountRecord = await db.select({ count: sql<number>`count(*)` })
      .from(applications)
      .where(eq(applications.employerId, job.employerId))
      .get();
    const employerReceivedCount = employerReceivedCountRecord?.count || 0;

    if (employerReceivedCount >= employerResumeLimit) {
      return new Response(JSON.stringify({ error: 'This employer is not accepting any more resumes at this time.' }), { status: 403 });
    }

    const applicationId = crypto.randomUUID();

    // Store Application Snapshot in R2 Bucket
    const filename = `resume_${applicationId}.pdf`;
    let resumeUrl = `/api/resumes/${filename}`;
    if (resumeArrayBuffer) {
      if (bucket) {
        try {
          await bucket.put(filename, resumeArrayBuffer, {
            httpMetadata: { contentType: resumeContentType }
          });
        } catch (r2Err) {
          console.warn('Could not put application resume to R2, using data URL fallback:', r2Err);
          const base64 = Buffer.from(resumeArrayBuffer).toString('base64');
          resumeUrl = `data:application/pdf;base64,${base64}`;
        }
      } else {
        console.warn('R2 bucket binding not found. Using data URL fallback for application resume.');
        const base64 = Buffer.from(resumeArrayBuffer).toString('base64');
        resumeUrl = `data:application/pdf;base64,${base64}`;
      }
    }

    // If candidate asked to save this new uploaded resume as their default resume
    if (hasNewResumeFile && saveAsDefault && resumeArrayBuffer) {
      let defaultFilenameUrl = `/api/resumes/default_resume_${user.userId}.pdf`;
      if (bucket) {
        try {
          const defaultFilename = `default_resume_${user.userId}.pdf`;
          await bucket.put(defaultFilename, resumeArrayBuffer, {
            httpMetadata: { contentType: 'application/pdf' },
            customMetadata: { uploadedBy: user.userId, uploadedAt: new Date().toISOString() }
          });
        } catch (r2Err) {
          const base64 = Buffer.from(resumeArrayBuffer).toString('base64');
          defaultFilenameUrl = `data:application/pdf;base64,${base64}`;
        }
      } else {
        const base64 = Buffer.from(resumeArrayBuffer).toString('base64');
        defaultFilenameUrl = `data:application/pdf;base64,${base64}`;
      }
      await db.update(users)
        .set({ defaultResumeUrl: defaultFilenameUrl, updatedAt: new Date() })
        .where(eq(users.id, user.userId));
    }

    if (photoFile && photoFile instanceof File && photoFile.size > 0) {
      let ext = 'jpg';
      if (photoFile.type === 'image/png') ext = 'png';
      else if (photoFile.type === 'image/webp') ext = 'webp';

      const photoFilename = `photo_${applicationId}.${ext}`;
      const photoBuffer = await photoFile.arrayBuffer();
      if (bucket) {
        try {
          await bucket.put(photoFilename, photoBuffer, {
            httpMetadata: { contentType: photoFile.type }
          });
          photoUrl = `/api/resumes/${photoFilename}`;
        } catch (r2Err) {
          const base64 = Buffer.from(photoBuffer).toString('base64');
          photoUrl = `data:${photoFile.type};base64,${base64}`;
        }
      } else {
        const base64 = Buffer.from(photoBuffer).toString('base64');
        photoUrl = `data:${photoFile.type};base64,${base64}`;
      }
    }

    const customAnswersRaw = formData.get('screeningAnswers') as string || null;
    let parsedScreeningAnswers: any[] = [];
    if (customAnswersRaw) {
      try {
        parsedScreeningAnswers = JSON.parse(customAnswersRaw);
      } catch (e) { }
    }

    const customAnswers = {
      linkedinUrl: normalizedLinkedin,
      portfolioUrl: normalizedPortfolio,
      photoUrl,
      appliedWithDefaultResume: Boolean(useDefaultResume || !hasNewResumeFile),
      screeningAnswers: parsedScreeningAnswers
    };

    let aiScore = null;
    let aiSummary = null;

    // Insert Application
    await db.insert(applications).values({
      id: applicationId,
      jobPostingId,
      applicantId: user.userId,
      employerId: job.employerId,
      resumeUrl,
      coverLetter,
      customAnswers: JSON.stringify(customAnswers),
      status: 'received',
      statusHistory: JSON.stringify([{ status: 'received', updated_at: new Date() }]),
      aiScore,
      aiSummary
    });

    // Update applicant profile with latest links/photo if provided
    try {
      const userUpdates: Record<string, any> = {};
      if (normalizedLinkedin && normalizedLinkedin !== candidateRecord?.linkedinUrl) userUpdates.linkedinUrl = normalizedLinkedin;
      if (normalizedPortfolio && normalizedPortfolio !== candidateRecord?.portfolioUrl) userUpdates.portfolioUrl = normalizedPortfolio;
      if (photoUrl && photoUrl !== candidateRecord?.avatarUrl) userUpdates.avatarUrl = photoUrl;

      if (Object.keys(userUpdates).length > 0) {
        await db.update(users).set(userUpdates).where(eq(users.id, user.userId));
      }
    } catch (err) {
      console.error('Error updating user profile info on apply:', err);
    }

    // Update Application Count on Job Posting
    await db.update(jobPostings)
      .set({ applicationsCount: sql`${jobPostings.applicationsCount} + 1` })
      .where(eq(jobPostings.id, jobPostingId));

    // --- Admin & MasterAdmin Notifications ---
    try {
      const { notifications } = await import('../../../db/schema');
      const systemAdmins = await db.select({ id: users.id })
        .from(users)
        .where(sql`${users.userType} IN ('admin', 'superadmin', 'masteradmin')`).all();

      if (systemAdmins.length > 0) {
        const candidateUser = await db.select().from(users).where(eq(users.id, user.userId)).get();
        const candidateName = candidateUser ? `${candidateUser.firstName} ${candidateUser.lastName}` : 'A candidate';
        const adminNotifs = systemAdmins.map(admin => ({
          id: crypto.randomUUID(),
          userId: admin.id,
          title: 'New Application Submitted',
          message: `${candidateName} has submitted an application for the job "${job.jobTitle}".`,
          type: 'system',
          isRead: false,
          createdAt: new Date(),
        }));
        await db.insert(notifications).values(adminNotifs);
      }
    } catch (adminNotifErr) {
      console.error('Failed to create admin notifications', adminNotifErr);
    }

    // NOTE: Send Email Notification to Applicant (Cloudflare Email Routing or Resend API)

    return new Response(JSON.stringify({
      success: true,
      applicationId,
      message: 'Application submitted successfully. You will be notified of status updates.'
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || 'Server error' }), { status: 500 });
  }
};
