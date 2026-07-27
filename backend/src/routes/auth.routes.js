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
import { startSession, revokeUserSessions, revokeUserApiKeys } from '../services/session.service.js';
import { findUserByCredential } from '../utils/credential.js';
import {
  generateSetup,
  generateRecoveryCodes,
  verifyTotp,
  verifySecondFactor,
} from '../services/totp.service.js';
import jwt from 'jsonwebtoken';

const router = Router();
router.use(
  ['/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/resend-verification', '/2fa/verify'],
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

// NOTE: the username-or-email `identifier` schema that used to sit here was
// dead code — nothing in this file referenced it. The routes that take an
// identifier (login, forgot-password, resend-verification) all validate with a
// bare non-empty string on purpose: they do an exact `findUnique` on the value
// and deliberately answer the same way whether or not an account matches, so
// stricter validation would only leak which shapes are real accounts. The live
// copy of that rule is in users.routes.js, where admin account CREATION does
// need it.

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
    totpEnabled: u.totpEnabled,
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

/**
 * CLAIM a single-use `Token` — atomically, before doing any work with it.
 *
 * `usedAt` is the whole of what makes a reset or verification link single-use,
 * and both routes used to read the row, check the flag, and only then write it.
 * That is a read-modify-write on exactly the field whose job is to make the
 * operation happen once, and on the reset path the bcrypt hash of the new
 * password sits inside the window, which makes it comfortably wide.
 *
 * Measured against a real PostgreSQL: five concurrent resets on ONE token all
 * returned 200, and the LAST writer decided the account's final password while
 * the other four were each told their reset had succeeded. Concurrent verify
 * calls likewise minted a session apiece from a single emailed link.
 *
 * The claim is one conditional `updateMany` — the database serialises it per
 * row, so exactly one caller sees `count === 1` and every loser gets the same
 * "invalid or expired" answer a genuinely spent link gives. `type` is part of
 * the condition because reset and verify share this table and are discriminated
 * only by that column, and `expiresAt` is checked in the same statement so a
 * token cannot expire between the check and the claim.
 *
 * Same compare-and-set the rest of this codebase already relies on for
 * `UploadSession.parts`, `User.recoveryCodes`, `reserveQuota` and
 * `upload/complete`, for the same reason.
 *
 * Returns the claimed row, or null if another caller got there first.
 */
async function claimToken(rawToken, type) {
  const hash = sha256(rawToken);
  const rec = await prisma.token.findUnique({ where: { hash } });
  if (!rec || rec.type !== type) return null;

  const claimed = await prisma.token.updateMany({
    where: { id: rec.id, type, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  return claimed.count === 1 ? rec : null;
}

// Confirm an email with the token from the verification link. On success the
// account is activated and the user is signed in (token returned).
router.post(
  '/verify-email',
  asyncHandler(async (req, res) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    // Claim first: a link consumed twice hands out two real sessions.
    const rec = await claimToken(token, 'verify');
    if (!rec) throw badRequest('Invalid or expired verification link');
    const user = await prisma.user.update({
      where: { id: rec.userId },
      data: { emailVerified: true },
    });
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
    const user = await findUserByCredential(id);
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
    const user = await findUserByCredential(data.email);
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
    // Task5 #1 — second factor. Password is correct but no session is created
    // yet: hand back a short-lived intermediate token that only /2fa/verify
    // accepts (claim p:'2fa'), and let the client prompt for the code.
    if (user.totpEnabled) {
      const tmpToken = jwt.sign({ sub: user.id, p: '2fa' }, env.jwtSecret, { expiresIn: '5m' });
      audit('login_2fa_pending', { userId: user.id, ip });
      return res.json({ requires2fa: true, tmpToken });
    }
    audit('login', { userId: user.id, ip });
    res.json({ token: await startSession(user, req), user: publicUser(user) });
  }),
);

// ---- Two-factor auth (Task5 #1) ----

// Complete a 2FA login: exchange the intermediate token + a TOTP code (or a
// one-time recovery code) for a real session.
router.post(
  '/2fa/verify',
  asyncHandler(async (req, res) => {
    const { tmpToken, code } = z
      .object({ tmpToken: z.string().min(10), code: z.string().trim().min(4).max(64) })
      .parse(req.body);
    let payload;
    try {
      payload = jwt.verify(tmpToken, env.jwtSecret);
    } catch {
      throw unauthorized('Login expired — please sign in again');
    }
    if (payload.p !== '2fa') throw unauthorized('Invalid login token');
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.banned || !user.totpEnabled) throw unauthorized('Invalid login token');

    const ip = clientIp(req);
    if (!(await verifySecondFactor(user, code))) {
      audit('login_2fa_failed', { userId: user.id, ip });
      throw unauthorized('Invalid authentication code');
    }
    audit('login', { userId: user.id, meta: { mfa: true }, ip });
    res.json({ token: await startSession(user, req), user: publicUser(user) });
  }),
);

// Begin 2FA setup: store a fresh secret (not yet enforced) and return the
// provisioning QR + secret for the authenticator app.
router.post(
  '/2fa/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.totpEnabled) throw badRequest('Two-factor auth is already enabled');
    const { secret, otpauth, qr } = await generateSetup(req.user);
    await prisma.user.update({ where: { id: req.user.id }, data: { totpSecret: secret } });
    res.json({ secret, otpauth, qr });
  }),
);

// Confirm setup with the first code from the app → enforce 2FA and hand out
// the one-time recovery codes (shown exactly once).
router.post(
  '/2fa/enable',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { code } = z.object({ code: z.string().trim().min(4).max(16) }).parse(req.body);
    if (req.user.totpEnabled) throw badRequest('Two-factor auth is already enabled');
    if (!req.user.totpSecret) throw badRequest('Run setup first');
    if (!verifyTotp(req.user.totpSecret, code)) throw badRequest('Invalid authentication code');

    const { raw, hashes } = generateRecoveryCodes();
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { totpEnabled: true, recoveryCodes: JSON.stringify(hashes) },
    });
    audit('totp_enable', { userId: user.id, ip: clientIp(req) });
    res.json({ ok: true, recoveryCodes: raw, user: publicUser(user) });
  }),
);

// Turn 2FA off — requires the account password AND a valid code (TOTP or
// recovery) so a hijacked session can't silently weaken the account.
router.post(
  '/2fa/disable',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { password, code } = z
      .object({ password: z.string().min(1), code: z.string().trim().min(4).max(64) })
      .parse(req.body);
    if (!req.user.totpEnabled) throw badRequest('Two-factor auth is not enabled');
    if (!(await bcrypt.compare(password, req.user.password))) throw unauthorized('Wrong password');
    if (!(await verifySecondFactor(req.user, code))) throw unauthorized('Invalid authentication code');

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { totpEnabled: false, totpSecret: null, recoveryCodes: null },
    });
    audit('totp_disable', { userId: user.id, ip: clientIp(req) });
    res.json({ ok: true, user: publicUser(user) });
  }),
);

// B9 — request a password reset. Always responds 200 (no account enumeration).
router.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const { identifier: id } = z.object({ identifier: z.string().trim().min(1) }).parse(req.body);
    const user = await findUserByCredential(id);
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
    // Claim the token BEFORE hashing the new password: the hash is the slowest
    // step in this route, and leaving it inside the check-then-consume window is
    // what let five concurrent resets all succeed, with the last one to commit
    // silently deciding the account's password.
    const rec = await claimToken(token, 'reset');
    if (!rec) throw badRequest('Invalid or expired reset link');
    await prisma.user.update({
      where: { id: rec.userId },
      data: { password: await bcrypt.hash(password, 10) },
    });
    // Security: a reset means the account may have been compromised — drop every
    // existing login so an attacker's stolen token stops working.
    //
    // API keys go too. They are the OTHER bearer credential requireAuth accepts
    // (`Bearer uk_…` / `X-API-Key`), they carry no `sid`, and they never expire —
    // so revoking only sessions left an attacker who had reached the account long
    // enough to call POST /api/keys with permanent, full access that outlived the
    // very recovery meant to lock them out. Nothing in the reset flow shows the
    // owner that a key exists, so they would have no reason to look.
    await revokeUserSessions(rec.userId);
    const { count: keysRevoked } = await revokeUserApiKeys(rec.userId);
    audit('password_reset', {
      userId: rec.userId,
      meta: { apiKeysRevoked: keysRevoked },
      ip: clientIp(req),
    });
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
