import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { users } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const PUT: APIRoute = async ({ request, locals }) => {
  // @ts-ignore
  const user = locals.user;

  if (!user || !['admin', 'superadmin', 'masteradmin'].includes(user.userType)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const formData = await request.formData();

    const firstName = (formData.get('firstName') as string)?.trim();
    const lastName  = (formData.get('lastName')  as string)?.trim();
    const phone     = (formData.get('phone')     as string)?.trim();
    const photoFile = formData.get('photo')      as File | null;

    if (!firstName || !lastName) {
      return new Response(JSON.stringify({ error: 'First name and last name are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // @ts-ignore
    const bucket = env?.BUCKET;
    let avatarUrl: string | undefined;

    if (photoFile && photoFile instanceof File && photoFile.size > 0) {
      if (photoFile.size > 5 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'Photo must be less than 5MB' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (!photoFile.type.startsWith('image/')) {
        return new Response(JSON.stringify({ error: 'Only image files are allowed' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (bucket) {
        try {
          const ext = photoFile.name.split('.').pop() || 'jpg';
          const key = `avatar_${user.userId}_${Date.now()}.${ext}`;
          const buffer = await photoFile.arrayBuffer();

          await bucket.put(key, buffer, {
            httpMetadata: { contentType: photoFile.type },
            customMetadata: { uploadedBy: user.userId, uploadedAt: new Date().toISOString() },
          });

          avatarUrl = `/api/uploads/${key}`;
        } catch (err) {
          console.warn('R2 put failed, falling back to data URL:', err);
          const buffer = await photoFile.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          avatarUrl = `data:${photoFile.type || 'image/png'};base64,${base64}`;
        }
      } else {
        console.warn('R2 BUCKET binding not found. Using data URL fallback.');
        const buffer = await photoFile.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        avatarUrl = `data:${photoFile.type || 'image/png'};base64,${base64}`;
      }
    }

    const db = getDb();
    const updateData: any = {
      firstName,
      lastName,
      phone: phone || null,
      updatedAt: new Date(),
    };

    if (avatarUrl) {
      updateData.avatarUrl = avatarUrl;
    }

    await db.update(users).set(updateData).where(eq(users.id, user.userId));

    return new Response(
      JSON.stringify({
        message: 'Admin profile updated successfully',
        avatarUrl,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error updating admin profile:', error);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
