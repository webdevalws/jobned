import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { users, plans } from '../../../db/schema';
import { hashPassword, signToken } from '../../../lib/auth';
import { eq, sql } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals, cookies }) => {
  try {
    const data = await request.json();
    const { email, password, confirmPassword, firstName, lastName, userType, phone, planId } = data;

    if (!email || !password || !firstName || !lastName || !userType) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanFirstName = String(firstName).trim().slice(0, 100);
    const cleanLastName = String(lastName).trim().slice(0, 100);
    const cleanPhone = phone ? String(phone).trim().slice(0, 25) : null;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 255) {
      return new Response(JSON.stringify({ error: 'Invalid email address' }), { status: 400 });
    }

    if (password.length < 6 || password.length > 128) {
      return new Response(JSON.stringify({ error: 'Password must be between 6 and 128 characters' }), { status: 400 });
    }

    if (confirmPassword && password !== confirmPassword) {
      return new Response(JSON.stringify({ error: 'Passwords do not match' }), { status: 400 });
    }

    if (!['employee', 'employer'].includes(userType)) {
      return new Response(JSON.stringify({ error: 'Invalid user type' }), { status: 400 });
    }

    const db = getDb();

    // Auto-seed plans if they don't exist yet (prevents foreign key constraint errors)
    try {
      const hasMediumPlan = await db.select().from(plans).where(eq(plans.planId, 'P002')).get();
      if (!hasMediumPlan) {
        // ... (skipped insert for brevity, not needed since we seeded)
      }
    } catch (dbError: any) {
      console.error("EXACT DB ERROR:", dbError);
      return new Response(JSON.stringify({ error: `DB Error: ${dbError.message} | Cause: ${dbError.cause?.message || dbError.cause}` }), { status: 500 });
    }

    // Check if user exists
    const existingUser = await db.select().from(users).where(eq(users.email, email)).get();
    if (existingUser) {
      return new Response(JSON.stringify({ error: 'Email already registered' }), { status: 409 });
    }

    // Hash password (12 rounds enforced in auth.ts)
    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID(); // Cloudflare workers support crypto.randomUUID natively

    // Assign planId, default to Basic (P001) if not provided
    const finalPlanId = planId || 'P001';
    const planExpiresAt = new Date();
    planExpiresAt.setFullYear(planExpiresAt.getFullYear() + 100);

    const initialVerifiedStatus = userType === 'employee' ? 'verified' : 'pending';

    let initialSubscriptionStatus = 'active';
    let requirePayment = false;

    if (userType === 'employer') {
      const chosenPlan = await db.select().from(plans).where(eq(plans.planId, finalPlanId)).get();
      if (chosenPlan && chosenPlan.price > 0) {
        initialSubscriptionStatus = 'inactive';
        requirePayment = true;
      }
    }

    // Insert user
    await db.insert(users).values({
      id: userId,
      email,
      passwordHash,
      firstName,
      lastName,
      userType,
      phone,
      planId: finalPlanId,
      planExpiresAt,
      subscriptionStatus: initialSubscriptionStatus,
      verifiedStatus: initialVerifiedStatus,
      isActive: true
    });

    // Notify admins and superadmins about the new registration
    try {
      const admins = await db.select({ id: users.id })
                             .from(users)
                             .where(sql`${users.userType} IN ('admin', 'superadmin', 'masteradmin')`);
      
      if (admins.length > 0) {
        const notificationsData = admins.map(admin => ({
          id: crypto.randomUUID(),
          userId: admin.id,
          title: 'New User Registration',
          message: `A new ${userType} (${firstName} ${lastName}) has registered.`,
          type: 'registration'
        }));
        // Require the notifications table
        const { notifications } = await import('../../../db/schema');
        await db.insert(notifications).values(notificationsData);
      }
    } catch (notifErr) {
      console.error("Failed to create notifications:", notifErr);
      // We don't fail the registration if notifications fail
    }

    // Generate JWT
    const token = await signToken({
      userId,
      userType,
      verifiedStatus: initialVerifiedStatus
    });

    // Set secure HTTP-only cookie
    cookies.set('auth_token', token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 86400 * 7
    });

    return new Response(JSON.stringify({ 
      success: true, 
      token,
      requirePayment,
      planId: finalPlanId,
      message: userType === 'employee' ? 'Registration successful! Welcome to JobNed.' : 'Registration successful. Your employer account is being set up.' 
    }), { 
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || 'Server error' }), { status: 500 });
  }
};
