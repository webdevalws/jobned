import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { plans, users } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { verifyToken } from '../../../lib/auth';
import { createRazorpayOrder } from '../../../lib/razorpay';

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  try {
    // 1. Authenticate user (optional for guest checkout initiation)
    let user = (locals as any)?.user;

    if (!user) {
      const authHeader = request.headers.get('Authorization');
      let token = null;

      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      } else {
        token = cookies.get('auth_token')?.value;
      }

      if (token) {
        user = await verifyToken(token);
      }
    }

    // 2. Parse request
    const body = await request.json().catch(() => ({}));
    const planId = body.planId || 'P001';
    const billingCycle = body.billingCycle || 'monthly';

    const db = getDb();
    const targetPlan = await db.select().from(plans).where(eq(plans.planId, planId)).get();

    if (!targetPlan) {
      return new Response(JSON.stringify({ error: 'Plan not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. Determine price
    const rawPrice = billingCycle === 'annual'
      ? (targetPlan.annualPrice && targetPlan.annualPrice > 0 ? targetPlan.annualPrice : targetPlan.price * 10)
      : targetPlan.price;

    const price = Number(rawPrice) || 0;

    // 4. If Free (price <= 0), signal to frontend for instant activation
    if (price <= 0) {
      if (!user) {
        return new Response(JSON.stringify({
          isFree: true,
          requireAuth: true,
          planId: targetPlan.planId,
          planName: targetPlan.planName,
          message: 'Free plan requires account registration.'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        isFree: true,
        planId: targetPlan.planId,
        planName: targetPlan.planName,
        message: 'Plan is free. Instant activation available.'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 5. If Paid (price > 0), generate Razorpay order
    const amountInPaise = Math.round(price * 100);
    const currency = targetPlan.currency || 'USD';

    let dbUser = null;
    if (user) {
      dbUser = await db.select().from(users).where(eq(users.id, user.userId || user.id)).get();
    }

    const userEmail = dbUser?.email || body.email || '';
    const userName = dbUser?.firstName ? `${dbUser.firstName} ${dbUser.lastName || ''}`.trim() : (body.name || '');
    const userPhone = dbUser?.phone || body.phone || '';

    const order = await createRazorpayOrder({
      amountInPaise,
      currency,
      receipt: `rcpt_${(user?.userId || user?.id || 'guest').substring(0, 8)}_${Date.now().toString().slice(-6)}`,
      notes: {
        userId: user?.userId || user?.id || 'guest',
        planId: targetPlan.planId,
        billingCycle,
        userEmail,
        userPhone
      }
    });

    let cfEnv: any = {};
    try {
      // @ts-ignore
      cfEnv = env;
    } catch {
      cfEnv = {};
    }

    const keyId = cfEnv.PUBLIC_RAZORPAY_KEY_ID ||
      process.env.PUBLIC_RAZORPAY_KEY_ID ||
      'rzp_live_TbnQ3kUA2u3BbQ';

    return new Response(JSON.stringify({
      isFree: false,
      planId: targetPlan.planId,
      planName: targetPlan.planName,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId,
      userEmail,
      userName
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Error creating payment order:', error);
    return new Response(JSON.stringify({ error: error.message || 'Failed to initiate checkout' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
