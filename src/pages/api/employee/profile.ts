import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { users } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const PUT: APIRoute = async ({ request, locals }) => {
  // @ts-ignore
  const user = locals.user;

  if (!user || user.userType !== 'employee') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const formData = await request.formData();

    // Basic info
    const firstName   = (formData.get('firstName')   as string)?.trim();
    const lastName    = (formData.get('lastName')    as string)?.trim();
    const phone       = (formData.get('phone')       as string)?.trim();
    const headline    = (formData.get('headline')    as string)?.trim();
    const bio         = (formData.get('bio')         as string)?.trim();
    const location    = (formData.get('location')    as string)?.trim();
    const linkedinUrl = (formData.get('linkedinUrl') as string)?.trim();
    const portfolioUrl= (formData.get('portfolioUrl')as string)?.trim();
    let defaultResumeUrl = (formData.get('defaultResumeUrl') as string)?.trim();
    const clearDefaultResume = formData.get('clearDefaultResume') === 'true';
    const defaultResumeFile = (formData.get('defaultResumeFile') || formData.get('resume')) as File | null;
    const experienceYearsRaw = formData.get('experienceYears') as string;
    const skillsRaw   = formData.get('skills')       as string; // JSON string
    const educationRaw= formData.get('education')    as string; // JSON string
    const workExperienceRaw = formData.get('workExperience') as string; // JSON string
    const photoFile   = formData.get('photo')        as File | null;

    if (!firstName || !lastName) {
      return new Response(JSON.stringify({ error: 'First name and last name are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Parse JSON fields
    let skills: string[] = [];
    try {
      skills = skillsRaw ? JSON.parse(skillsRaw) : [];
    } catch {}

    let education: any[] = [];
    try {
      education = educationRaw ? JSON.parse(educationRaw) : [];
    } catch {}

    let workExperience: any[] = [];
    try {
      workExperience = workExperienceRaw ? JSON.parse(workExperienceRaw) : [];
    } catch {}

    const experienceYears = experienceYearsRaw
      ? parseInt(experienceYearsRaw, 10)
      : null;

    // @ts-ignore
    const bucket = env?.BUCKET;

    // --- R2 Default Resume Upload ---
    if (defaultResumeFile && defaultResumeFile instanceof File && defaultResumeFile.size > 0) {
      if (defaultResumeFile.size > 5 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'Default resume must be less than 5MB' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (defaultResumeFile.type !== 'application/pdf') {
        return new Response(JSON.stringify({ error: 'Only PDF files are allowed for resume' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (bucket) {
        try {
          const resumeFilename = `default_resume_${user.userId}.pdf`;
          const buffer = await defaultResumeFile.arrayBuffer();
          await bucket.put(resumeFilename, buffer, {
            httpMetadata: { contentType: 'application/pdf' },
            customMetadata: { uploadedBy: user.userId, uploadedAt: new Date().toISOString() },
          });
          defaultResumeUrl = `/api/resumes/${resumeFilename}`;
        } catch (r2Err) {
          console.warn('R2 put failed for default resume, using data URL fallback:', r2Err);
          const buffer = await defaultResumeFile.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          defaultResumeUrl = `data:application/pdf;base64,${base64}`;
        }
      } else {
        console.warn('R2 BUCKET binding not found in env. Using data URL fallback for default resume.');
        const buffer = await defaultResumeFile.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        defaultResumeUrl = `data:application/pdf;base64,${base64}`;
      }
    } else if (clearDefaultResume) {
      defaultResumeUrl = '';
      if (bucket) {
        try {
          await bucket.delete(`default_resume_${user.userId}.pdf`);
        } catch (delErr) {
          console.warn('Could not delete default resume from R2:', delErr);
        }
      }
    }

    // --- R2 Photo Upload ---
    let avatarUrl: string | undefined;
    if (photoFile && photoFile instanceof File && photoFile.size > 0) {
      // Validate file type
      const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowed.includes(photoFile.type)) {
        return new Response(JSON.stringify({ error: 'Invalid file type. Only JPG, PNG, GIF, WEBP allowed.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Validate size (5MB max)
      if (photoFile.size > 5 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'File size must be under 5MB' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (bucket) {
        try {
          const ext = photoFile.name.split('.').pop()?.toLowerCase() || 'jpg';
          const key = `avatars/${user.userId}-${Date.now()}.${ext}`;
          const buffer = await photoFile.arrayBuffer();

          await bucket.put(key, buffer, {
            httpMetadata: { contentType: photoFile.type },
            customMetadata: { uploadedBy: user.userId, uploadedAt: new Date().toISOString() },
          });

          avatarUrl = `/api/uploads/${key}`;
        } catch (r2Err) {
          console.warn('R2 put failed, falling back to data URL:', r2Err);
          const buffer = await photoFile.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          avatarUrl = `data:${photoFile.type || 'image/png'};base64,${base64}`;
        }
      } else {
        console.warn('R2 BUCKET binding not found in env. Using data URL fallback.');
        const buffer = await photoFile.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        avatarUrl = `data:${photoFile.type || 'image/png'};base64,${base64}`;
      }
    }

    const db = getDb();

    const updateFields: Record<string, any> = {
      firstName,
      lastName,
      phone:          phone          || null,
      headline:       headline       || null,
      bio:            bio            || null,
      location:       location       || null,
      linkedinUrl:    linkedinUrl    || null,
      portfolioUrl:   portfolioUrl   || null,
      skills:         skills.length  > 0 ? JSON.stringify(skills) : null,
      education:      education.length > 0 ? JSON.stringify(education) : null,
      workExperience: workExperience.length > 0 ? JSON.stringify(workExperience) : null,
      experienceYears: experienceYears ?? null,
      updatedAt: new Date(),
    };

    if (defaultResumeUrl !== undefined) {
      updateFields.defaultResumeUrl = defaultResumeUrl || null;
    }

    if (avatarUrl) {
      updateFields.avatarUrl = avatarUrl;
    }

    await db.update(users)
      .set(updateFields)
      .where(eq(users.id, user.userId));

    return new Response(JSON.stringify({
      success: true,
      message: 'Profile updated successfully',
      avatarUrl: avatarUrl ?? null,
      defaultResumeUrl: updateFields.defaultResumeUrl ?? null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Employee profile update error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error', details: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
