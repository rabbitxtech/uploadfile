// Task 2 — login session management. A JWT is still the bearer credential, but
// it now carries a `sid` (session id) that points at a Session row. requireAuth
// rejects the token if that row is revoked or expired, so sessions can be listed
// and individually/collectively logged out despite JWTs being stateless.
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { clientIp } from './audit.service.js';

// Parse a jsonwebtoken-style duration ("7d", "12h", "30m", "3600", "3600s")
// into milliseconds. Falls back to 7 days on anything unrecognised.
export function parseDurationMs(v) {
  if (typeof v === 'number') return v * 1000;
  const m = /^(\d+)\s*(ms|s|m|h|d|w|y)?$/.exec(String(v).trim());
  if (!m) return 7 * 24 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  const unit = m[2] || 's';
  const mult = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, y: 31536e6 }[unit];
  return n * mult;
}

const SESSION_TTL_MS = parseDurationMs(env.jwtExpiresIn);

// Create a Session row for this login and return a JWT bound to it.
export async function startSession(user, req) {
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      userAgent: (req?.headers?.['user-agent'] || '').slice(0, 300) || null,
      ip: req ? clientIp(req) : null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  const token = jwt.sign({ sub: user.id, role: user.role, sid: session.id }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });
  return token;
}

// Revoke every active session for a user (e.g. after a password change),
// optionally keeping one (the caller's current session).
export function revokeUserSessions(userId, exceptId = null) {
  return prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revoke every active API key for a user.
 *
 * A `Session` is not the only bearer credential on this account. `requireAuth`
 * accepts `Authorization: Bearer uk_…` / `X-API-Key: uk_…` and resolves it
 * straight to `req.user` — no `sid`, no session row, so revoking sessions does
 * not touch it. That makes an API key strictly MORE durable than a login: it
 * survives "log out everywhere", a password change, and a password RESET.
 *
 * A password reset exists for exactly one situation — the account may be
 * compromised — and the whole point of dropping every session there is that a
 * stolen credential stops working. An attacker who reached the account for even
 * a moment can mint a key from POST /api/keys, and that key then outlives the
 * recovery: full read/write access to every file, upload, share and delete, with
 * the legitimate owner believing they had locked the intruder out. The key is
 * not listed anywhere the owner is prompted to look during recovery, and it
 * never expires on its own (`ApiKey` has `revokedAt` but no `expiresAt`).
 *
 * So the credential-reset paths revoke both kinds. Kept as a separate function
 * rather than folded into `revokeUserSessions` because the two are used at
 * different bars: revoking sessions is also how "log out my other devices"
 * works, and that must NOT destroy the user's scripts and integrations. Only a
 * password CHANGE/RESET — where the premise is that the old credentials are no
 * longer trusted — reaches for this one.
 */
export function revokeUserApiKeys(userId) {
  return prisma.apiKey.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
