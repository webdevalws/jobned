import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { users } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const PUT: APIRoute = async ({ request, locals }) => {
  // @ts-ignore
  const user = locals.user;

  if (!user || user.userType !== 'employer') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const formData = await request.formData();
    const firstName = formData.get('firstName') as string;
    const lastName = formData.get('lastName') as string;
    const phone = formData.get('phone') as string;
    const companyName = formData.get('companyName') as string;
    const companyWebsite = formData.get('companyWebsite') as string;
    const companyIndustry = formData.get('companyIndustry') as string;
    const companySize = formData.get('companySize') as string;
    const companyBio = formData.get('companyBio') as string;
    const photoFile = formData.get('photo') as File | null;

    if (!firstName || !lastName) {
      return new Response(JSON.stringify({ error: 'First name and last name are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let avatarUrl: string | null = null;
    if (photoFile && photoFile instanceof File && photoFile.size > 0) {
      // @ts-ignore
      const bucket = env?.BUCKET;
      if (bucket) {
        try {
          const ext = photoFile.name.split('.').pop() || 'png';
          const key = `avatars/${user.userId}-${Date.now()}.${ext}`;
          const buffer = await photoFile.arrayBuffer();
          
          await bucket.put(key, buffer, {
            httpMetadata: {
              contentType: photoFile.type
            }
          });
          avatarUrl = `/api/uploads/${key}`;
        } catch (err) {
          console.warn('R2 put failed, falling back to data URL:', err);
          const buffer = await photoFile.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          avatarUrl = `data:${photoFile.type || 'image/png'};base64,${base64}`;
        }
      } else {
        console.warn('R2 BUCKET binding not found in env, using data URL fallback');
        const buffer = await photoFile.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        avatarUrl = `data:${photoFile.type || 'image/png'};base64,${base64}`;
      }
    }

    const db = getDb();

    const updateFields: Record<string, any> = {
      firstName,
      lastName,
      phone: phone || null,
      companyName: companyName || null,
      companyWebsite: companyWebsite || null,
      companyIndustry: companyIndustry || null,
      companySize: companySize || null,
      companyBio: companyBio || null,
      updatedAt: new Date()
    };

    if (avatarUrl) {
      updateFields.avatarUrl = avatarUrl;
    }

    await db.update(users)
      .set(updateFields)
      .where(eq(users.id, user.userId));

    return new Response(JSON.stringify({ message: 'Profile updated successfully', avatarUrl }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('Error updating profile:', error);
    return new Response(JSON.stringify({ error: 'Internal server error', details: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
