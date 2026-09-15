import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { users, plans } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { verifyToken } from '../../../lib/auth';
import { verifyRazorpaySignature } from '../../../lib/razorpay';

export const GET: APIRoute = async ({ request, url }) => {
  const userType = url.searchParams.get('userType') || 'employee';
  const redirectUrl = userType === 'employer' ? '/employer' : '/dashboard';
  return new Response(null, {
    status: 302,
    headers: { 'Location': redirectUrl }
  });
};

export const POST: APIRoute = async ({ request, cookies, locals, url }) => {
  // 1. Authenticate User
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
  
  let fallbackUserId = url.searchParams.get('userId');

  if (!user && !fallbackUserId) {
    return new Response(JSON.stringify({ error: 'Unauthorized: Please log in to activate a plan' }), { 
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const activeUserId = user ? user.userId : fallbackUserId;

  try {
    const contentType = request.headers.get('content-type') || '';
    let body: any = {};

    if (contentType.includes('application/json')) {
      body = await request.json().catch(() => ({}));
    } else {
      const formData = await request.formData().catch(() => new FormData());
      for (const [key, value] of formData.entries()) {
        body[key] = value;
      }
    }

    const planId = body.planId || url.searchParams.get('planId') || 'P001';
    const billingCycle = body.billingCycle || url.searchParams.get('billingCycle') || 'monthly';
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;

    const db = getDb();

    // 2. Fetch Plan to check if it's free or paid
    const targetPlan = await db.select().from(plans).where(eq(plans.planId, planId)).get();
    const rawPrice = billingCycle === 'annual'
      ? (targetPlan?.annualPrice && targetPlan.annualPrice > 0 ? targetPlan.annualPrice : (targetPlan?.price || 0) * 10)
      : (targetPlan?.price || 0);

    const price = Number(rawPrice) || 0;

    // 3. If plan is paid (price > 0), verify Razorpay payment
    if (price > 0) {
      let isVerified = false;

      // Method A: Verify HMAC Signature if paymentId and signature are present
      if (razorpay_order_id && razorpay_payment_id && razorpay_signature) {
        isVerified = await verifyRazorpaySignature({
          orderId: razorpay_order_id,
          paymentId: razorpay_payment_id,
          signature: razorpay_signature
        });
      }

      // Method B: Fallback to direct Razorpay Orders API verification
      if (!isVerified && razorpay_order_id) {
        const { checkOrderPaymentStatus } = await import('../../../lib/razorpay');
        const orderStatus = await checkOrderPaymentStatus({ orderId: razorpay_order_id });

        if (orderStatus.isPaid) {
          isVerified = true;
        } else if (orderStatus.status === 'failed') {
          return new Response(JSON.stringify({ 
            error: orderStatus.error || 'Payment was declined or blocked by gateway.',
            code: 'PAYMENT_FAILED'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        } else if (orderStatus.status === 'pending') {
          return new Response(JSON.stringify({ 
            pending: true,
            message: 'Payment is currently pending confirmation from UPI / Bank. Please wait a moment.' 
          }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      if (!isVerified) {
        return new Response(JSON.stringify({ 
          error: 'Payment verification failed. No completed transaction found on Razorpay.' 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 4. Calculate Expiry Date
    const planExpiresAt = new Date();
    if (price <= 0) {
      // Free plan expires in 100 years
      planExpiresAt.setFullYear(planExpiresAt.getFullYear() + 100);
    } else if (billingCycle === 'annual') {
      planExpiresAt.setFullYear(planExpiresAt.getFullYear() + 1);
    } else {
      // Monthly
      planExpiresAt.setMonth(planExpiresAt.getMonth() + 1);
    }

    // 5. Update user subscription status in D1
    await db.update(users)
      .set({
        planId: planId,
        planExpiresAt: planExpiresAt,
        subscriptionStatus: 'active'
      })
      .where(eq(users.id, activeUserId));

    return new Response(JSON.stringify({
      success: true,
      message: price > 0 ? 'Payment verified and plan activated!' : 'Free plan activated successfully!',
      planId,
      planExpiresAt: planExpiresAt.toISOString()
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Error activating plan:', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal Server Error' }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
