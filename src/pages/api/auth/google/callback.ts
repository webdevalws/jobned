import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/db';
import { users } from '../../../../db/schema';
import { signToken } from '../../../../lib/auth';
import { eq } from 'drizzle-orm';

export const GET: APIRoute = async ({ request, cookies }) => {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const errorParam = url.searchParams.get('error');

    if (errorParam || !code) {
      return Response.redirect(`${url.origin}/login?error=google_auth_canceled`, 302);
    }

    const cfEnv = (locals as any)?.runtime?.env || {};
    const clientId = cfEnv.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
    const clientSecret = cfEnv.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';
    const redirectUri = `${url.origin}/api/auth/google/callback`;

    // 1. Exchange authorization code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('Google token exchange error:', tokenData);
      return Response.redirect(`${url.origin}/login?error=google_token_failed`, 302);
    }

    // 2. Fetch User Profile from Google
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const googleUser = await userRes.json();

    if (!googleUser.email) {
      return Response.redirect(`${url.origin}/login?error=google_email_missing`, 302);
    }

    const db = getDb();
    const userEmail = googleUser.email.toLowerCase().trim();

    // Parse state from cookie first (most reliable), fallback to state query param
    let stateData: { plan?: string; type?: string; redirect?: string } = {};

    const cookieState = cookies.get('pending_oauth_signup')?.value;
    if (cookieState) {
      try {
        stateData = JSON.parse(cookieState);
      } catch (e) {
        console.error('Error parsing pending_oauth_signup cookie:', e);
      }
      cookies.delete('pending_oauth_signup', { path: '/' });
    }

    if (!stateData.plan && !stateData.type) {
      const stateParam = url.searchParams.get('state');
      if (stateParam) {
        try {
          stateData = JSON.parse(decodeURIComponent(atob(stateParam)));
        } catch (e) {
          try {
            stateData = JSON.parse(atob(stateParam));
          } catch (e2) {}
        }
      }
    }

    const requestedPlan = stateData.plan || null;
    const requestedType = stateData.type || (requestedPlan ? 'employer' : null);
    const requestedRedirect = stateData.redirect || null;

    const isEmployer = requestedType === 'employer' || !!requestedPlan;
    const finalUserType = isEmployer ? 'employer' : 'employee';
    const finalPlanId = requestedPlan || (isEmployer ? 'P001' : null);

    let initialSubscriptionStatus = 'active';
    let requirePayment = false;

    if (isEmployer && finalPlanId) {
      try {
        const { plans } = await import('../../../../db/schema');
        const chosenPlan = await db.select().from(plans).where(eq(plans.planId, finalPlanId)).get();
        if (chosenPlan && chosenPlan.price > 0) {
          initialSubscriptionStatus = 'inactive';
          requirePayment = true;
        }
      } catch (pErr) {
        console.error('Failed to query plan for Google user:', pErr);
      }
    }

    // 3. Check if User exists in Database
    let user = await db.select().from(users).where(eq(users.email, userEmail)).get();

    if (!user) {
      // Create new account for Google OAuth user
      const newUserId = crypto.randomUUID();
      const firstName = googleUser.given_name || googleUser.name || 'Google';
      const lastName = googleUser.family_name || 'User';
      const avatarUrl = googleUser.picture || null;

      const planExpiresAt = new Date();
      planExpiresAt.setFullYear(planExpiresAt.getFullYear() + (requirePayment ? 0 : 100));

      await db.insert(users).values({
        id: newUserId,
        email: userEmail,
        passwordHash: 'GOOGLE_OAUTH_USER',
        firstName,
        lastName,
        userType: finalUserType,
        verifiedStatus: finalUserType === 'employee' ? 'verified' : 'pending',
        avatarUrl,
        planId: finalPlanId,
        planExpiresAt,
        subscriptionStatus: initialSubscriptionStatus,
        isActive: true,
      });

      user = await db.select().from(users).where(eq(users.id, newUserId)).get();
    } else if (!user.isActive) {
      return Response.redirect(`${url.origin}/login?error=account_deactivated`, 302);
    } else {
      // Existing user: if they clicked an employer plan, upgrade their account
      const updates: any = {};
      if (googleUser.picture && !user.avatarUrl) {
        updates.avatarUrl = googleUser.picture;
        user.avatarUrl = googleUser.picture;
      }

      if (isEmployer) {
        updates.userType = 'employer';
        user.userType = 'employer';

        if (finalPlanId) {
          updates.planId = finalPlanId;
          user.planId = finalPlanId;
        }

        if (requirePayment) {
          // If they haven't paid or are switching to a new paid plan, require payment
          if (user.subscriptionStatus !== 'active' || user.planId !== finalPlanId) {
            updates.subscriptionStatus = 'inactive';
            user.subscriptionStatus = 'inactive';
            requirePayment = true;
          }
        }
      } else if (user.userType === 'employer' && user.subscriptionStatus !== 'active') {
        // If an existing employer with inactive subscription signs in, check if their plan requires payment
        try {
          const { plans } = await import('../../../../db/schema');
          const currentPlan = await db.select().from(plans).where(eq(plans.planId, user.planId || 'P001')).get();
          if (currentPlan && currentPlan.price > 0) {
            requirePayment = true;
          }
        } catch (e) {}
      }

      if (Object.keys(updates).length > 0) {
        await db.update(users).set(updates).where(eq(users.id, user.id));
      }
    }

    if (!user) {
      return Response.redirect(`${url.origin}/login?error=user_creation_failed`, 302);
    }

    // 4. Generate JWT Authentication Token
    const token = await signToken({
      userId: user.id,
      userType: user.userType as 'employee' | 'employer' | 'admin' | 'superadmin' | 'masteradmin',
      verifiedStatus: user.verifiedStatus as 'pending' | 'verified' | 'rejected',
    });

    // 5. Set Cookie for SSR Auth
    cookies.set('auth_token', token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24, // 24 hours
    });

    // Determine target redirect route
    let targetPath = '/dashboard';
    if (user.userType === 'employer') {
      if (requirePayment || user.subscriptionStatus !== 'active') {
        targetPath = `/checkout?plan=${encodeURIComponent(user.planId || requestedPlan || 'P001')}`;
      } else {
        targetPath = requestedRedirect || '/employer';
      }
    } else if (user.userType === 'admin') targetPath = '/admin';
    else if (user.userType === 'superadmin') targetPath = '/superadmin';
    else if (user.userType === 'masteradmin') targetPath = '/masteradmin';
    else if (requestedRedirect) targetPath = requestedRedirect;

    const userObjectJson = JSON.stringify({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      userType: user.userType,
      verifiedStatus: user.verifiedStatus,
      avatarUrl: user.avatarUrl,
    });

    // Return HTML redirect script to set client-side localStorage before navigating
    const htmlResponse = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authenticating...</title>
</head>
<body style="background: #0f172a; color: #f8fafc; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
  <div style="text-align: center;">
    <div style="font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem;">Authenticating with Google...</div>
    <div style="font-size: 0.95rem; color: #94a3b8;">Redirecting to your dashboard...</div>
  </div>
  <script>
    try {
      localStorage.setItem('auth_token', ${JSON.stringify(token)});
      localStorage.setItem('user', ${JSON.stringify(userObjectJson)});
    } catch (e) {}
    window.location.href = ${JSON.stringify(targetPath)};
  </script>
</body>
</html>`;

    return new Response(htmlResponse, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (err: any) {
    console.error('Google Callback Exception:', err);
    return Response.redirect(`${new URL(request.url).origin}/login?error=google_auth_exception`, 302);
  }
};
