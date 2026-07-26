import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { forbidden, unauthorized } from '../utils/errors.js';

export const API_KEY_PREFIX = 'uk_';
export const hashApiKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

// Accept either a JWT (Authorization: Bearer <jwt>) or a personal access token
// (Authorization: Bearer uk_... or X-API-Key: uk_...). API keys (B8) let scripts
// authenticate without a 7-day JWT.
export async function requireAuth(req, _res, next) {
  try {
    const h = req.headers.authorization || '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
    const apiKey = req.headers['x-api-key'] || (bearer?.startsWith(API_KEY_PREFIX) ? bearer : null);

    if (apiKey) {
      const rec = await prisma.apiKey.findUnique({
        where: { hash: hashApiKey(apiKey) },
        include: { user: true },
      });
      if (!rec || rec.revokedAt) throw unauthorized('Invalid API key');
      if (rec.user.banned) throw forbidden('Account banned');
      prisma.apiKey.update({ where: { id: rec.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
      req.user = rec.user;
      req.authViaApiKey = true;
      return next();
    }

    if (!bearer) throw unauthorized('Missing token');
    const payload = jwt.verify(bearer, env.jwtSecret);

    // Both claim checks below are pure payload inspection, so they run BEFORE
    // any database work — a token that can never authenticate shouldn't cost a
    // user lookup.
    //
    // Reject purpose-scoped tokens, the same rule authenticateWs applies to
    // sockets. The 2FA tmpToken ({p:'2fa'}, minted BEFORE the code is checked)
    // and the video stream token ({p:'stream'}) are signed with this same
    // secret, so they clear jwt.verify. Neither currently carries a `sid`, so
    // the session check would also refuse them — but that makes this
    // middleware's safety depend on a detail of how those two tokens happen to
    // be minted elsewhere. State the rule directly: a full session token has no
    // `p` claim, so anything carrying one is not a session credential.
    if (payload.p) throw unauthorized('Invalid token');

    // Session binding (Task 2): tokens are issued with a `sid`. Reject the token
    // if its session was revoked (logged out) or has expired. Tokens minted
    // before sessions existed (no sid) are no longer accepted — those users
    // simply log in again.
    if (!payload.sid) throw unauthorized('Session expired, please sign in again');

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw unauthorized('Invalid token');
    if (user.banned) throw forbidden('Account banned');

    const session = await prisma.session.findUnique({ where: { id: payload.sid } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw unauthorized('Session expired, please sign in again');
    }
    // Best-effort "last seen" bump for the sessions UI (don't await).
    prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => {});

    req.user = user;
    req.sessionId = session.id;
    next();
  } catch (e) {
    if (e?.name === 'JsonWebTokenError' || e?.name === 'TokenExpiredError') {
      return next(unauthorized('Invalid or expired token'));
    }
    next(e);
  }
}

// Gate for actions self-registered users can't do until an admin approves them
// (currently: uploading files). Admins always pass.
export function requireApproved(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role === 'admin' || req.user.approved) return next();
  return next(
    forbidden('Your account is pending administrator approval before you can upload files.'),
  );
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden('Requires role: ' + roles.join('|')));
    next();
  };
}
