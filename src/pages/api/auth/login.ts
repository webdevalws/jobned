import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { users } from '../../../db/schema';
import { verifyPassword, signToken } from '../../../lib/auth';
import { eq } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals, cookies }) => {
  try {
    const data = await request.json();
    const { email, password } = data;

    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'Email and password required' }), { status: 400 });
    }

    const cleanEmail = email.trim().toLowerCase();
    const altEmail = cleanEmail.endsWith('@jobned.com')
      ? cleanEmail.replace('@jobned.com', '@recruitnest.com')
      : cleanEmail.endsWith('@recruitnest.com')
        ? cleanEmail.replace('@recruitnest.com', '@jobned.com')
        : cleanEmail;

    const db = getDb();

    let user = await db.select().from(users).where(eq(users.email, cleanEmail)).get();
    if (!user && altEmail !== cleanEmail) {
      user = await db.select().from(users).where(eq(users.email, altEmail)).get();
    }
    if (!user) {
      // Fallback case-insensitive search
      const allUsers = await db.select().from(users);
      user = allUsers.find(u => u.email.toLowerCase() === cleanEmail || u.email.toLowerCase() === altEmail);
    }

    if (!user) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 });
    }

    if (!user.isActive) {
      return new Response(JSON.stringify({ error: 'Account is deactivated' }), { status: 403 });
    }

    // Verify password
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 });
    }

    // Generate JWT
    const token = await signToken({
      userId: user.id,
      userType: user.userType as 'employee' | 'employer' | 'admin' | 'superadmin' | 'masteradmin',
      verifiedStatus: user.verifiedStatus as 'pending' | 'verified' | 'rejected'
    });

    // Set secure HTTP-only cookie
    cookies.set('auth_token', token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 86400 * 7
    });

    let requirePayment = false;
    let redirectUrl: string | null = null;

    if (user.userType === 'employer' && user.subscriptionStatus !== 'active') {
      try {
        const { plans } = await import('../../../db/schema');
        const userPlan = await db.select().from(plans).where(eq(plans.planId, user.planId || 'P001')).get();
        if (userPlan && userPlan.price > 0) {
          requirePayment = true;
          redirectUrl = `/checkout?plan=${encodeURIComponent(user.planId || 'P001')}`;
        }
      } catch (pErr) {
        console.error('Failed to check user plan on login:', pErr);
      }
    }

    return new Response(JSON.stringify({ 
      success: true, 
      token,
      requirePayment,
      redirectUrl,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        userType: user.userType,
        verifiedStatus: user.verifiedStatus,
        planId: user.planId,
        subscriptionStatus: user.subscriptionStatus
      }
    }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || 'Server error' }), { status: 500 });
  }
};
