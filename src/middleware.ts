import { defineMiddleware } from 'astro:middleware';
import { verifyToken } from './lib/auth';
import { getDb } from './lib/db';
import { users } from './db/schema';
import { eq } from 'drizzle-orm';

export const onRequest = defineMiddleware(async ({ cookies, request, locals, redirect }, next) => {
  const url = new URL(request.url);

  // Check if it's an API route that requires auth, or protected pages
  const isApiRoute = url.pathname.startsWith('/api/');
  const isEmployeeRoute = url.pathname.startsWith('/applications') || url.pathname.startsWith('/saved') || url.pathname.startsWith('/recommended') || url.pathname.startsWith('/notifications') || url.pathname.startsWith('/settings') || url.pathname.startsWith('/employee');
  const isDashboard = url.pathname.startsWith('/dashboard') || url.pathname.startsWith('/employer') || url.pathname.startsWith('/admin') || url.pathname.startsWith('/superadmin') || url.pathname.startsWith('/masteradmin') || url.pathname.startsWith('/checkout') || isEmployeeRoute;

  // Get token from Authorization header or cookies
  const authHeader = request.headers.get('Authorization');
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else {
    token = cookies.get('auth_token')?.value;
  }

  if (token) {
    const payload = await verifyToken(token);
    if (payload) {
      // @ts-ignore
      locals.user = payload;
    }
  }

  if (!isApiRoute && !isDashboard) {
    // Public routes don't require auth by default
    return next();
  }

  // Allow public auth & search API routes (no auth required, but user payload attached if present)
  if (
    url.pathname.startsWith('/api/auth/') ||
    url.pathname.startsWith('/api/external/') ||
    url.pathname.startsWith('/api/resumes/') ||
    url.pathname.startsWith('/api/payments/') ||
    url.pathname.startsWith('/api/jobs') ||
    url.pathname.startsWith('/api/cron/') ||
    url.pathname.startsWith('/api/ai/chat')
  ) {
    return next();
  }

  if (!locals.user) {
    if (isApiRoute) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // Redirect to standard user login
    return redirect('/login');
  }

  // Strict RBAC check for admin routes
  if (url.pathname.startsWith('/admin') || url.pathname.startsWith('/api/admin')) {
    if (locals.user?.userType !== 'admin' && locals.user?.userType !== 'superadmin' && locals.user?.userType !== 'masteradmin') {
      if (isApiRoute) {
        return new Response(JSON.stringify({ error: 'Forbidden: Admin access required' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return redirect('/dashboard');
    }
  }

  // Strict RBAC check for superadmin routes
  if (url.pathname.startsWith('/superadmin') || url.pathname.startsWith('/api/superadmin')) {
    if (locals.user?.userType !== 'superadmin' && locals.user?.userType !== 'masteradmin') {
      if (isApiRoute) {
        return new Response(JSON.stringify({ error: 'Forbidden: SuperAdmin access required' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return redirect('/dashboard');
    }
  }

  // Strict RBAC check for masteradmin routes
  if (url.pathname.startsWith('/masteradmin') || url.pathname.startsWith('/api/masteradmin')) {
    if (locals.user?.userType !== 'masteradmin' && locals.user?.userType !== 'superadmin') {
      if (isApiRoute) {
        return new Response(JSON.stringify({ error: 'Forbidden: MasterAdmin access required' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return redirect('/dashboard');
    }
  }
  
  // Strict subscription check for employer accounts across all protected pages and API endpoints
  if (locals.user?.userType === 'employer') {
    const isExemptEmployerRoute =
      url.pathname.startsWith('/checkout') ||
      url.pathname.startsWith('/logout') ||
      url.pathname.startsWith('/api/payments/') ||
      url.pathname.startsWith('/api/auth/') ||
      url.pathname.startsWith('/api/external/') ||
      url.pathname.startsWith('/employer/public');

    if (!isExemptEmployerRoute) {
      try {
        const db = getDb();
        const currentDbUser = await db.select().from(users).where(eq(users.id, locals.user.userId)).get();
        if (currentDbUser && currentDbUser.subscriptionStatus !== 'active') {
          const { plans } = await import('./db/schema');
          const currentPlan = await db.select().from(plans).where(eq(plans.planId, currentDbUser.planId || 'P001')).get();
          if (currentPlan && currentPlan.price > 0) {
            const checkoutUrl = `/checkout?plan=${encodeURIComponent(currentDbUser.planId || 'P001')}`;
            if (isApiRoute) {
              return new Response(JSON.stringify({ 
                error: 'Payment required: Please complete your subscription payment to activate your employer account.',
                requirePayment: true,
                redirectUrl: checkoutUrl 
              }), {
                status: 402,
                headers: { 'Content-Type': 'application/json' }
              });
            }
            return redirect(checkoutUrl);
          }
        }
      } catch (subErr) {
        console.error('Middleware subscription check error:', subErr);
      }
    }
  }

  const response = await next();

  // Attach standard security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Content Security Policy
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://apis.google.com https://challenges.cloudflare.com https://cdn.jsdelivr.net https://checkout.razorpay.com https://*.razorpay.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https: http: https://*.razorpay.com",
    "connect-src 'self' https: wss: https://api.razorpay.com https://lumberjack.razorpay.com https://*.razorpay.com",
    "frame-src 'self' https://accounts.google.com https://challenges.cloudflare.com https://api.razorpay.com https://checkout.razorpay.com https://*.razorpay.com",
    "object-src 'none'",
    "base-uri 'self'"
  ].join('; ');

  response.headers.set('Content-Security-Policy', csp);

  return response;
});
