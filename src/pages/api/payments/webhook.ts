import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { users, plans } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { verifyRazorpayWebhookSignature } from '../../../lib/razorpay';

export const POST: APIRoute = async ({ request }) => {
  try {
    const signature = request.headers.get('x-razorpay-signature');
    const rawBody = await request.text();

    let cfEnv: any = {};
    try {
      const { env } = await import('cloudflare:workers');
      cfEnv = env || {};
    } catch (e) {}

    const webhookSecret =
      cfEnv?.RAZORPAY_WEBHOOK_SECRET ||
      process.env.RAZORPAY_WEBHOOK_SECRET ||
      'recruitnest_webhook_secret_2026';

    // Verify Webhook Signature if signature header is provided
    if (signature) {
      const isValid = await verifyRazorpayWebhookSignature({
        rawBody,
        signature,
        webhookSecret
      });

      if (!isValid) {
        console.error('Invalid Razorpay Webhook signature header');
        return new Response(JSON.stringify({ error: 'Invalid Webhook Signature' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    let payload: any = {};
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), { status: 400 });
    }

    const event = payload.event;
    console.log(`Received Razorpay Webhook Event: ${event}`);

    // Process payment success events: payment.captured or order.paid
    if (event === 'payment.captured' || event === 'order.paid') {
      const paymentEntity = payload.payload?.payment?.entity || payload.payload?.order?.entity;
      const notes = paymentEntity?.notes || {};
      const userId = notes.userId || notes.user_id;
      const planId = notes.planId || notes.plan_id || 'P001';
      const billingCycle = notes.billingCycle || notes.billing_cycle || 'monthly';

      if (userId) {
        const db = getDb();
        const planExpiresAt = new Date();
        if (billingCycle === 'annual') {
          planExpiresAt.setFullYear(planExpiresAt.getFullYear() + 1);
        } else {
          planExpiresAt.setMonth(planExpiresAt.getMonth() + 1);
        }

        await db.update(users)
          .set({
            planId,
            planExpiresAt,
            subscriptionStatus: 'active'
          })
          .where(eq(users.id, userId));

        console.log(`Razorpay Webhook: Successfully activated plan ${planId} for user ${userId}`);
      }
    }

    return new Response(JSON.stringify({ status: 'ok', received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    console.error('Error handling Razorpay Webhook:', err);
    return new Response(JSON.stringify({ error: err.message || 'Webhook Handler Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
