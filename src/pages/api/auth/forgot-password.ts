import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db';
import { users } from '../../../db/schema';
import { signResetToken } from '../../../lib/auth';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const { email } = await request.json();

    if (!email) {
      return new Response(JSON.stringify({ error: 'Email address is required' }), { status: 400 });
    }

    const db = getDb();
    const user = await db.select().from(users).where(eq(users.email, email)).get();

    if (!user) {
      return new Response(JSON.stringify({ 
        error: 'No account found with this email. Please sign up first.' 
      }), { status: 404 });
    }

    // Generate short-lived reset token
    const token = await signResetToken(email);

    // Build the reset URL pointing back to the website
    const url = new URL(request.url);
    const resetUrl = `${url.origin}/reset-password?token=${encodeURIComponent(token)}`;

    // Check for Brevo API Keys (Free tier allows 300 emails/day)
    let brevoApiKeys: string[] = [];
    
    // Support the comma-separated variable
    const envBrevoKeys = env?.BREVO_API_KEYS || process.env?.BREVO_API_KEYS;
    if (envBrevoKeys) {
      brevoApiKeys.push(...envBrevoKeys.split(',').map((k: string) => k.trim()).filter(Boolean));
    }

    // Support individual variables like BREVO_API_KEY, BREVO_API_KEY1, BREVO_API_KEY2, etc.
    const allEnv = env || process.env || {};
    for (const [key, value] of Object.entries(allEnv)) {
      if (key.startsWith('BREVO_API_KEY') && key !== 'BREVO_API_KEYS' && typeof value === 'string' && value.trim()) {
        brevoApiKeys.push(value.trim());
      }
    }
    
    // Remove duplicates just in case
    brevoApiKeys = [...new Set(brevoApiKeys)];

    if (brevoApiKeys.length > 0) {
      let brevoEmailSent = false;
      let brevoLastError = null;

      for (let i = 0; i < brevoApiKeys.length; i++) {
        const apiKey = brevoApiKeys[i];
        try {
          const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
              'accept': 'application/json',
              'api-key': apiKey,
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              sender: { name: 'JobNed', email: 'prashantsinghstd@gmail.com' },
              to: [{ email }],
              subject: 'Reset your JobNed password',
              htmlContent: `
                <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
                  <h2 style="color: #10b981; margin-top: 0;">Password Reset Request</h2>
                  <p>You requested a password reset for your JobNed account. Click the button below to set a new password. This link is valid for 15 minutes.</p>
                  <div style="margin: 24px 0; text-align: center;">
                    <a href="${resetUrl}" style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500; display: inline-block;">Reset Password</a>
                  </div>
                  <p style="color: #6b7280; font-size: 0.875rem;">If the button doesn't work, copy and paste this link in your browser:</p>
                  <p style="word-break: break-all; font-size: 0.875rem;"><a href="${resetUrl}" style="color: #10b981;">${resetUrl}</a></p>
                  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
                  <p style="color: #9ca3af; font-size: 0.75rem; margin: 0;">If you did not request this email, you can safely ignore it.</p>
                </div>
              `
            })
          });

          if (brevoRes.ok) {
            brevoEmailSent = true;
            return new Response(JSON.stringify({ 
              success: true, 
              message: `Password reset email sent to ${email}!` 
            }), { status: 200 });
          } else {
            const errText = await brevoRes.text();
            console.error(`Brevo API error with key index ${i}:`, errText);
            brevoLastError = errText;
          }
        } catch (brevoErr: any) {
          console.error(`Brevo API fetch error with key index ${i}:`, brevoErr);
          brevoLastError = brevoErr.message;
        }
      }

      if (!brevoEmailSent) {
        console.error('All Brevo API keys failed. Last error:', brevoLastError);
      }
    }

    // Check for Gmail App Password configuration
    const gmailUser = env?.GMAIL_USER || process.env?.GMAIL_USER || 'prashantsinghstd@gmail.com';
    const gmailAppPassword = env?.GMAIL_APP_PASSWORD || process.env?.GMAIL_APP_PASSWORD;

    if (gmailAppPassword) {
      try {
        const nodemailer = await import('nodemailer');
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: gmailUser,
            pass: gmailAppPassword,
          },
        });

        await transporter.sendMail({
          from: `JobNed <${gmailUser}>`,
          to: email,
          subject: 'Reset your JobNed password',
          html: `
            <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
              <h2 style="color: #10b981; margin-top: 0;">Password Reset Request</h2>
              <p>You requested a password reset for your JobNed account. Click the button below to set a new password. This link is valid for 15 minutes.</p>
              <div style="margin: 24px 0; text-align: center;">
                <a href="${resetUrl}" style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500; display: inline-block;">Reset Password</a>
              </div>
              <p style="color: #6b7280; font-size: 0.875rem;">If the button doesn't work, copy and paste this link in your browser:</p>
              <p style="word-break: break-all; font-size: 0.875rem;"><a href="${resetUrl}" style="color: #10b981;">${resetUrl}</a></p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
              <p style="color: #9ca3af; font-size: 0.75rem; margin: 0;">If you did not request this email, you can safely ignore it.</p>
            </div>
          `,
        });

        return new Response(JSON.stringify({ 
          success: true, 
          message: `Password reset email sent directly to ${email}!` 
        }), { status: 200 });
      } catch (gmailErr: any) {
        console.error('Gmail SMTP send error:', gmailErr);
      }
    }

    // Read Resend API Keys from environmental variables
    // Support either the single key or a comma-separated list of keys
    const envResendKey = env?.RESEND_API_KEY || process.env?.RESEND_API_KEY;
    const envResendKeys = env?.RESEND_API_KEYS || process.env?.RESEND_API_KEYS;
    
    // Parse into an array, removing empty spaces
    let resendApiKeys: string[] = [];
    if (envResendKeys) {
      resendApiKeys = envResendKeys.split(',').map((k: string) => k.trim()).filter((k: string) => k);
    } else if (envResendKey) {
      resendApiKeys = [envResendKey.trim()];
    }

    if (resendApiKeys.length === 0) {
      console.warn('RESEND_API_KEY is not defined. Reset Link:', resetUrl);
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'If the email exists, a reset link has been sent.'
      }), { status: 200 });
    }

    let emailSent = false;
    let lastError = null;

    for (let i = 0; i < resendApiKeys.length; i++) {
      const apiKey = resendApiKeys[i];
      try {
        const resendResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'JobNed <onboarding@resend.dev>', // Default Resend domain
            to: email,
            subject: 'Reset your JobNed password',
            html: `
              <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
                <h2 style="color: #10b981; margin-top: 0;">Password Reset Request</h2>
                <p>You requested a password reset for your JobNed account. Click the button below to set a new password. This link is valid for 15 minutes.</p>
                <div style="margin: 24px 0; text-align: center;">
                  <a href="${resetUrl}" style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500; display: inline-block;">Reset Password</a>
                </div>
                <p style="color: #6b7280; font-size: 0.875rem;">If the button doesn't work, copy and paste this link in your browser:</p>
                <p style="word-break: break-all; font-size: 0.875rem;"><a href="${resetUrl}" style="color: #10b981;">${resetUrl}</a></p>
                <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
                <p style="color: #9ca3af; font-size: 0.75rem; margin: 0;">If you did not request this email, you can safely ignore it.</p>
              </div>
            `
          })
        });

        if (resendResponse.ok) {
          emailSent = true;
          break; // Successfully sent, break out of the retry loop
        } else {
          const errText = await resendResponse.text();
          console.error(`Resend API error with key index ${i}:`, errText);
          lastError = errText;
          // Continue to the next key in the array if available
        }
      } catch (err: any) {
        console.error(`Resend API fetch error with key index ${i}:`, err);
        lastError = err.message;
        // Continue to the next key
      }
    }

    if (!emailSent) {
      console.error('All Resend API keys failed. Last error:', lastError);
      return new Response(JSON.stringify({ 
        error: 'Failed to send reset email. Please try again later.'
      }), { status: 500 });
    }

    return new Response(JSON.stringify({ 
      success: true, 
      message: `Password reset email sent to ${email}!` 
    }), { status: 200 });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || 'Server error' }), { status: 500 });
  }
};
