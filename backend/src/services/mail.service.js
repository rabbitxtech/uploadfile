// B9 — email via SMTP (nodemailer). If SMTP isn't configured, falls back to
// logging the message (so password-reset/verify still work in dev — the link is
// printed to the server log).
import nodemailer from 'nodemailer';
import { logger } from '../config/logger.js';

let transport = null;
const FROM = process.env.SMTP_FROM || 'Uploader <no-reply@uploader.local>';

if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
    // Internal submission to our own docker-mailserver uses a self-signed cert
    // over the trusted compose network — accept it when explicitly allowed.
    ...(process.env.SMTP_ALLOW_SELFSIGNED === 'true'
      ? { tls: { rejectUnauthorized: false } }
      : {}),
  });
}

export const mailEnabled = !!transport;

// A username-only account (no real email) can't receive mail.
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || '');

export async function sendMail({ to, subject, html, text }) {
  if (!transport) {
    logger.warn({ to, subject, text: text || html }, '[mail] SMTP not configured — email not sent (logged)');
    return { delivered: false, reason: 'smtp_disabled' };
  }
  if (!looksLikeEmail(to)) {
    logger.warn({ to }, '[mail] recipient is not an email address — skipped (username-only account)');
    return { delivered: false, reason: 'no_email' };
  }
  try {
    const info = await transport.sendMail({ from: FROM, to, subject, html, text });
    logger.info({ to, messageId: info.messageId }, '[mail] sent');
    return { delivered: true };
  } catch (e) {
    logger.error({ to, err: e?.message }, '[mail] send failed');
    return { delivered: false, reason: 'error' };
  }
}

const APP_URL = process.env.PUBLIC_APP_URL || 'http://localhost:8080';
const APP_NAME = process.env.APP_NAME || 'Uploader';
const BRAND = '#2563eb'; // brand-600
const BRAND_DARK = '#1d4ed8'; // brand-700

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A responsive, email-client-safe HTML template (table layout + inline styles +
// a bulletproof button so it renders in Gmail/Outlook/Apple Mail). `preheader`
// is the hidden inbox-preview line. Returns the full HTML document.
function renderEmail({ preheader, heading, intro, buttonText, buttonUrl, after, footnote }) {
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f1f5f9;">${esc(preheader || heading)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.08);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td style="background:${BRAND};padding:24px 32px;">
<span style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">☁ ${esc(APP_NAME)}</span>
</td></tr>
<tr><td style="padding:32px 32px 8px;">
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#0f172a;font-weight:700;">${esc(heading)}</h1>
<p style="margin:0;font-size:15px;line-height:1.6;color:#475569;">${intro}</p>
</td></tr>
<tr><td style="padding:24px 32px 8px;" align="center">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td align="center" style="border-radius:10px;background:${BRAND};">
<a href="${esc(buttonUrl)}" target="_blank" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;background:${BRAND};border:1px solid ${BRAND_DARK};">${esc(buttonText)}</a>
</td></tr></table>
</td></tr>
<tr><td style="padding:8px 32px 0;">
<p style="margin:0;font-size:13px;line-height:1.6;color:#94a3b8;">Or paste this link into your browser:<br>
<a href="${esc(buttonUrl)}" target="_blank" style="color:${BRAND};word-break:break-all;">${esc(buttonUrl)}</a></p>
${after ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#94a3b8;">${after}</p>` : ''}
</td></tr>
<tr><td style="padding:24px 32px 32px;">
<hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px;">
<p style="margin:0;font-size:12px;line-height:1.6;color:#94a3b8;">${esc(footnote)}</p>
</td></tr>
</table>
<p style="max-width:480px;margin:16px auto 0;font-size:11px;color:#cbd5e1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">© ${year} ${esc(APP_NAME)} · This is an automated message, please do not reply.</p>
</td></tr>
</table>
</body>
</html>`;
}

export function sendPasswordReset(to, token) {
  const link = `${APP_URL}/reset-password?token=${token}`;
  logger.info({ to, link }, '[mail] password reset link');
  return sendMail({
    to,
    subject: `Reset your ${APP_NAME} password`,
    text: `Reset your ${APP_NAME} password using this link:\n${link}\n\nThis link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.`,
    html: renderEmail({
      preheader: `Reset your ${APP_NAME} password — link expires in 1 hour.`,
      heading: 'Reset your password',
      intro: `We received a request to reset the password for your ${esc(APP_NAME)} account. Click the button below to choose a new one.`,
      buttonText: 'Reset password',
      buttonUrl: link,
      after: 'This link expires in <strong>1 hour</strong>.',
      footnote: "If you didn't request a password reset, you can safely ignore this email — your password won't change.",
    }),
  });
}

export function sendVerifyEmail(to, token) {
  const link = `${APP_URL}/verify-email?token=${token}`;
  logger.info({ to, link }, '[mail] verify email link');
  return sendMail({
    to,
    subject: `Verify your ${APP_NAME} email`,
    text: `Welcome to ${APP_NAME}! Confirm your email address to activate your account:\n${link}\n\nThis link expires in 24 hours. If you didn't create an account, you can ignore this email.`,
    html: renderEmail({
      preheader: `Confirm your email to activate your ${APP_NAME} account.`,
      heading: `Welcome to ${esc(APP_NAME)}! 🎉`,
      intro: 'Thanks for signing up. Confirm your email address to activate your account and start uploading.',
      buttonText: 'Verify email',
      buttonUrl: link,
      after: 'This link expires in <strong>24 hours</strong>.',
      footnote: "If you didn't create this account, you can safely ignore this email.",
    }),
  });
}
