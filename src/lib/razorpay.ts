/**
 * Razorpay Payment Helper (Cloudflare Workers / Web Crypto compatible)
 */

export interface RazorpayOrderResult {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
  status: string;
}

/**
 * Creates an order via Razorpay Orders API.
 * Uses native fetch with Basic authentication.
 * Falls back to simulation if dummy/mock test keys are in use.
 */
export async function createRazorpayOrder({
  amountInPaise,
  currency = 'INR',
  receipt,
  notes = {},
  customKeyId,
  customKeySecret
}: {
  amountInPaise: number;
  currency?: string;
  receipt?: string;
  notes?: Record<string, any>;
  customKeyId?: string;
  customKeySecret?: string;
}): Promise<RazorpayOrderResult> {
  let cfEnv: any = {};
  try {
    const { env } = await import('cloudflare:workers');
    cfEnv = env || {};
  } catch (e) {}

  const keyId =
    customKeyId ||
    cfEnv?.RAZORPAY_KEY_ID ||
    cfEnv?.PUBLIC_RAZORPAY_KEY_ID ||
    process.env.RAZORPAY_KEY_ID ||
    process.env.PUBLIC_RAZORPAY_KEY_ID ||
    'rzp_live_TbnQ3kUA2u3BbQ';

  const keySecret =
    customKeySecret ||
    cfEnv?.RAZORPAY_KEY_SECRET ||
    process.env.RAZORPAY_KEY_SECRET ||
    'ZB6RWeDPibT7KZRdgEbli7rh';

  const isPlaceholderKey = !keyId || keyId.includes('placeholder') || keyId.includes('dummy');

  if (isPlaceholderKey) {
    // Generate a mock order ID so UI testing works seamlessly before real keys are provided
    return {
      id: `order_mock_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      amount: amountInPaise,
      currency: currency.toUpperCase(),
      receipt: receipt || `rcpt_${Date.now()}`,
      status: 'created'
    };
  }

  const basicAuth = btoa(`${keyId}:${keySecret}`);

  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: amountInPaise,
      currency: currency.toUpperCase(),
      receipt: receipt || `rcpt_${Date.now()}`,
      notes
    })
  });

  const data: any = await res.json();

  if (!res.ok) {
    console.error('Razorpay Order Creation Error:', data);
    throw new Error(data.error?.description || 'Failed to create Razorpay order');
  }

  return {
    id: data.id,
    amount: data.amount,
    currency: data.currency,
    receipt: data.receipt,
    status: data.status
  };
}

/**
 * Verifies Razorpay payment signature using standard Web Crypto HMAC SHA-256.
 * Expected data string: `${orderId}|${paymentId}`
 */
export async function verifyRazorpaySignature({
  orderId,
  paymentId,
  signature,
  customKeySecret
}: {
  orderId: string;
  paymentId: string;
  signature: string;
  customKeySecret?: string;
}): Promise<boolean> {
  let cfEnv: any = {};
  try {
    const { env } = await import('cloudflare:workers');
    cfEnv = env || {};
  } catch (e) {}

  const keySecret =
    customKeySecret ||
    cfEnv?.RAZORPAY_KEY_SECRET ||
    process.env.RAZORPAY_KEY_SECRET ||
    'ZB6RWeDPibT7KZRdgEbli7rh';

  // If mock test order, accept mock signature
  if (orderId.startsWith('order_mock_') || keySecret === 'placeholder_secret_key') {
    return true;
  }

  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(keySecret);
    const messageData = encoder.encode(`${orderId}|${paymentId}`);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const hashArray = Array.from(new Uint8Array(signatureBuffer));
    const generatedSignature = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return generatedSignature.toLowerCase() === signature.toLowerCase();
  } catch (err) {
    console.error('Razorpay Signature Verification Error:', err);
    return false;
  }
}

/**
 * Queries Razorpay Orders API directly to check if an order has been paid.
 * Useful for UPI QR, Webhooks, or when signature callback is interrupted.
 */
export async function checkOrderPaymentStatus({
  orderId,
  customKeyId,
  customKeySecret
}: {
  orderId: string;
  customKeyId?: string;
  customKeySecret?: string;
}): Promise<{
  isPaid: boolean;
  status: string;
  paymentId?: string;
  error?: string;
}> {
  let cfEnv: any = {};
  try {
    const { env } = await import('cloudflare:workers');
    cfEnv = env || {};
  } catch (e) {}

  const keyId =
    customKeyId ||
    cfEnv?.RAZORPAY_KEY_ID ||
    cfEnv?.PUBLIC_RAZORPAY_KEY_ID ||
    process.env.RAZORPAY_KEY_ID ||
    process.env.PUBLIC_RAZORPAY_KEY_ID ||
    'rzp_live_TbnQ3kUA2u3BbQ';

  const keySecret =
    customKeySecret ||
    cfEnv?.RAZORPAY_KEY_SECRET ||
    process.env.RAZORPAY_KEY_SECRET ||
    'ZB6RWeDPibT7KZRdgEbli7rh';

  if (orderId.startsWith('order_mock_')) {
    return { isPaid: true, status: 'captured', paymentId: `pay_mock_${Date.now()}` };
  }

  try {
    const basicAuth = btoa(`${keyId}:${keySecret}`);
    const res = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}/payments`, {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/json'
      }
    });

    const data: any = await res.json();
    if (!res.ok) {
      return { isPaid: false, status: 'error', error: data.error?.description || 'Failed to check order status' };
    }

    const items = data.items || [];
    const successfulPayment = items.find((p: any) => p.status === 'captured' || p.status === 'authorized');
    if (successfulPayment) {
      return {
        isPaid: true,
        status: successfulPayment.status,
        paymentId: successfulPayment.id
      };
    }

    const failedPayment = items.find((p: any) => p.status === 'failed');
    if (failedPayment) {
      return {
        isPaid: false,
        status: 'failed',
        error: failedPayment.error_description || failedPayment.error_reason || 'Payment failed or was blocked by gateway'
      };
    }

    return { isPaid: false, status: 'pending' };
  } catch (err: any) {
    console.error('Error checking order payment status:', err);
    return { isPaid: false, status: 'error', error: err.message || 'Error communicating with Razorpay' };
  }
}

/**
 * Verifies Razorpay Webhook signature using Web Crypto HMAC SHA-256.
 * Expected data string is the raw HTTP request body string.
 */
export async function verifyRazorpayWebhookSignature({
  rawBody,
  signature,
  webhookSecret
}: {
  rawBody: string;
  signature: string;
  webhookSecret: string;
}): Promise<boolean> {
  if (!signature || !webhookSecret) return false;
  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(webhookSecret);
    const messageData = encoder.encode(rawBody);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const hashArray = Array.from(new Uint8Array(signatureBuffer));
    const generatedSignature = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return generatedSignature.toLowerCase() === signature.toLowerCase();
  } catch (err) {
    console.error('Razorpay Webhook Signature Verification Error:', err);
    return false;
  }
}

