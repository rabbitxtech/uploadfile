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

/**
 * Spend every OTHER live `Token` of one kind for a user.
 *
 * The third bearer credential on an account, and the only one that OVERRIDES a
 * password. `claimToken` in auth.routes.js makes one link single-use; it says
 * nothing about how many links exist, and each `forgot-password` /
 * `resend-verification` mints a fresh row while leaving the previous ones
 * `usedAt: null` for the rest of their TTL. So the flow was single-use per
 * link but multi-use per REQUEST:
 *
 *   - Ask for the reset mail twice because the first was slow, use the second,
 *     and the first still resets the account for the remainder of its hour.
 *   - Worse, a live reset link OUTLIVED the password change it was competing
 *     with. Someone who saw that link once — a shared inbox, a forwarded mail,
 *     a device briefly not theirs — keeps the ability to take the account over,
 *     and the owner's natural reaction (setting a new password) did nothing
 *     about it. That is the same premise `revokeUserSessions` and
 *     `revokeUserApiKeys` act on here: after a credential reset, the older ways
 *     in stop working. Leaving alive the one credential that outranks the
 *     password was the gap.
 *
 * A `reset` link is therefore killed by anything that re-establishes the
 * password: another reset completing, the user changing it, an admin resetting
 * it. A `verify` link is killed once the address it proves is verified.
 *
 * Lives here rather than in auth.routes.js so users.routes.js can reach it
 * without importing one route module from another. `exceptId` keeps the row the
 * caller just claimed intact, so the trail still shows which link was used.
 */
export function invalidateTokens(userId, type, exceptId = null) {
  return prisma.token.updateMany({
    where: {
      userId,
      type,
      usedAt: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { usedAt: new Date() },
  });
}
