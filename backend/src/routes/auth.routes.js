import crypto from 'crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/async.js';
import { badRequest, unauthorized, forbidden, notFound } from '../utils/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { notify } from '../services/notify.service.js';
import { authLimiter } from '../middleware/ratelimit.js';
import { audit, clientIp } from '../services/audit.service.js';
import { sendPasswordReset, sendVerifyEmail } from '../services/mail.service.js';
import { startSession, revokeUserSessions } from '../services/session.service.js';

const router = Router();
router.use(
  ['/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/resend-verification'],
  authLimiter,
); // B5

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // verification link valid 24h

// Issue a fresh email-verification token for a user and email the link.
async function issueVerification(user) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await prisma.token.create({
    data: {
      userId: user.id,
      type: 'verify',
      hash: sha256(raw),
      expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
    },
  });
  sendVerifyEmail(user.email, raw).catch(() => {});
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Identifier: either a simple username (letters, digits, dot, underscore,
// hyphen) or an email. Stored in `User.email` column for backward compat with
// existing accounts that registered with an email.
const IDENT_RE = /^[a-zA-Z0-9._-]+$/;
const identifier = z
  .string()
  .trim()
  .min(3, 'At least 3 characters')
  .max(255)
  .refine(
    (v) => IDENT_RE.test(v) || z.string().email().safeParse(v).success,
    'Only letters, numbers, dot, underscore, hyphen — or a valid email',
  );

// Self-registration requires a real, deliverable email — we send a verification
// link to it. (Admin-created accounts may still use a plain username.)
const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required').max(255),
  password: z.string().min(6),
  name: z.string().max(120).optional(),
});

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    banned: u.banned,
    quotaBytes: u.quotaBytes.toString(),
    usedBytes: u.usedBytes.toString(),
    emailVerified: u.emailVerified,
    approved: u.approved,
    createdAt: u.createdAt,
  };
}

// Notify every admin that a self-registered user is awaiting approval.
async function notifyAdminsOfPendingUser(user) {
  const admins = await prisma.user.findMany({ where: { role: 'admin' }, select: { id: true } });
  for (const a of admins) {
    notify(a.id, {
      type: 'approval_pending',
      title: 'New user awaiting approval',
      body: `${user.name || user.email} verified their email and is waiting to be approved.`,
      link: '/users',
    });
  }
}

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const data = registerSchema.parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: data.email } });
    if (exists) throw badRequest('That email is already registered');

    // First registered user becomes admin and is auto-verified (bootstrap, so a
    // fresh DB can never lock itself out if mail isn't configured yet).
    const count = await prisma.user.count();
    const isFirst = count === 0;
    const role = isFirst ? 'admin' : 'user';

    const user = await prisma.user.create({
      data: {
        email: data.email,
        password: await bcrypt.hash(data.password, 10),
        name: data.name ?? null,
        role,
        emailVerified: isFirst,
        // First user (admin) is auto-approved; everyone else needs an admin to
        // approve them before they can upload.
        approved: isFirst,
        quotaBytes: env.defaultQuotaBytes,
      },
    });
    audit('register', { userId: user.id, ip: clientIp(req) });

    if (isFirst) {
      notify(user.id, {
        type: 'welcome',
        title: `Welcome to Uploader, ${user.name || user.email}!`,
        body: 'You are the first user — you have admin privileges.',
        link: '/files',
      });
      return res.status(201).json({ token: await startSession(user, req), user: publicUser(user) });
    }

    // Everyone else must confirm their email before they can sign in.
    await issueVerification(user);
    res.status(201).json({
      requiresVerification: true,
      email: user.email,
      message: 'Account created. Check your email for a verification link to activate it.',
    });
  }),
);

// Confirm an email with the token from the verification link. On success the
// account is activated and the user is signed in (token returned).
router.post(
  '/verify-email',
  asyncHandler(async (req, res) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    const rec = await prisma.token.findUnique({ where: { hash: sha256(token) } });
    if (!rec || rec.type !== 'verify' || rec.usedAt || rec.expiresAt < new Date()) {
      throw badRequest('Invalid or expired verification link');
    }
    const [user] = await prisma.$transaction([
      prisma.user.update({ where: { id: rec.userId }, data: { emailVerified: true } }),
      prisma.token.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
    ]);
    audit('email_verified', { userId: user.id, ip: clientIp(req) });
    notify(user.id, {
      type: 'welcome',
      title: `Welcome to Uploader, ${user.name || user.email}!`,
      body: user.approved
        ? 'Your email is verified. Start by uploading files or creating folders.'
        : 'Your email is verified. An administrator needs to approve your account before you can upload files.',
      link: '/files',
    });
    // A still-unapproved user just became a real pending account — ping admins.
    if (!user.approved) notifyAdminsOfPendingUser(user).catch(() => {});
    if (user.banned) throw forbidden('Account has been banned');
    res.json({ token: await startSession(user, req), user: publicUser(user) });
  }),
);

// Resend a verification link. Always 200 (no account enumeration).
router.post(
  '/resend-verification',
  asyncHandler(async (req, res) => {
    const { identifier: id } = z.object({ identifier: z.string().trim().min(1) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: id.toLowerCase() } });
    if (user && !user.emailVerified) {
      await issueVerification(user);
      audit('verification_resent', { userId: user.id, ip: clientIp(req) });
    }
    res.json({ ok: true });
  }),
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const data = z
      .object({ email: z.string().trim().min(1), password: z.string() })
      .parse(req.body);
    const ip = clientIp(req);
    const user = await prisma.user.findUnique({ where: { email: data.email } });
    if (!user) {
      audit('login_failed', { meta: { identifier: data.email }, ip });
      throw unauthorized('Invalid credentials');
    }
    const ok = await bcrypt.compare(data.password, user.password);
    if (!ok) {
      audit('login_failed', { userId: user.id, meta: { identifier: data.email }, ip });
      throw unauthorized('Invalid credentials');
    }
    if (user.banned) throw unauthorized('Account has been banned');
    if (!user.emailVerified) {
      audit('login_unverified', { userId: user.id, ip });
      throw forbidden('Please verify your email before signing in. Check your inbox for the link.');
    }
    audit('login', { userId: user.id, ip });
    res.json({ token: await startSession(user, req), user: publicUser(user) });
  }),
);

// B9 — request a password reset. Always responds 200 (no account enumeration).
router.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const { identifier: id } = z.object({ identifier: z.string().trim().min(1) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: id } });
    if (user) {
      const raw = crypto.randomBytes(32).toString('base64url');
      await prisma.token.create({
        data: {
          userId: user.id,
          type: 'reset',
          hash: sha256(raw),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      audit('password_reset_request', { userId: user.id, ip: clientIp(req) });
      sendPasswordReset(user.email, raw).catch(() => {});
    }
    res.json({ ok: true });
  }),
);

// B9 — complete a password reset with the emailed token.
router.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const { token, password } = z
      .object({ token: z.string().min(10), password: z.string().min(6) })
      .parse(req.body);
    const rec = await prisma.token.findUnique({ where: { hash: sha256(token) } });
    if (!rec || rec.type !== 'reset' || rec.usedAt || rec.expiresAt < new Date()) {
      throw badRequest('Invalid or expired reset link');
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: rec.userId }, data: { password: await bcrypt.hash(password, 10) } }),
      prisma.token.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
    ]);
    // Security: a reset means the account may have been compromised — drop every
    // existing login so an attacker's stolen token stops working.
    await revokeUserSessions(rec.userId);
    audit('password_reset', { userId: rec.userId, ip: clientIp(req) });
    res.json({ ok: true });
  }),
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  }),
);

// ---- Session management (Task 2) ----

// List the current user's active (non-revoked, non-expired) sessions. The one
// the request is authenticated with is flagged `current`.
router.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessions = await prisma.session.findMany({
      where: { userId: req.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    res.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        userAgent: s.userAgent,
        ip: s.ip,
        lastSeenAt: s.lastSeenAt,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        current: s.id === req.sessionId,
      })),
    });
  }),
);

// Revoke one session (must belong to the caller). Revoking the current session
// is allowed and behaves like logging out this device.
router.delete(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const s = await prisma.session.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!s) throw notFound('Session');
    await prisma.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
    audit('session_revoke', { userId: req.user.id, targetType: 'session', targetId: s.id, ip: clientIp(req) });
    res.json({ ok: true });
  }),
);

// Log out every other device, keeping the current session alive.
router.post(
  '/sessions/revoke-others',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { count } = await revokeUserSessions(req.user.id, req.sessionId);
    audit('session_revoke_others', { userId: req.user.id, meta: { count }, ip: clientIp(req) });
    res.json({ ok: true, count });
  }),
);

// Log out the current device (revoke this session).
router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.sessionId) {
      await prisma.session.update({ where: { id: req.sessionId }, data: { revokedAt: new Date() } });
    }
    res.json({ ok: true });
  }),
);

export default router;
