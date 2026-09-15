import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ request, cookies, locals }) => {
  try {
    const cfEnv = (locals as any)?.runtime?.env || {};
    const clientId = cfEnv.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
    
    const requestUrl = new URL(request.url);
    const origin = requestUrl.origin;
    const redirectUri = `${origin}/api/auth/google/callback`;

    const plan = requestUrl.searchParams.get('plan') || '';
    const type = requestUrl.searchParams.get('type') || '';
    const redirect = requestUrl.searchParams.get('redirect') || '';

    // Store in cookie for guaranteed persistence across OAuth redirects
    if (plan || type || redirect) {
      cookies.set('pending_oauth_signup', JSON.stringify({ plan, type, redirect }), {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 600,
      });
    }

    let stateParam = '';
    if (plan || type || redirect) {
      stateParam = `&state=${encodeURIComponent(btoa(encodeURIComponent(JSON.stringify({ plan, type, redirect }))))}`;
    }

    const scope = encodeURIComponent('openid profile email');
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}${stateParam}&access_type=offline&prompt=consent`;

    return new Response(null, {
      status: 302,
      headers: { 
        'Location': googleAuthUrl,
        'Cache-Control': 'no-store, no-cache'
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ 
      error: e?.message || String(e),
      stack: e?.stack || null
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
