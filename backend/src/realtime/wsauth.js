// Shared WebSocket handshake authentication.
//
// The three socket servers (/ws presence, /yjs collab, /gws games) all take the
// JWT from a `?token=` query param, and each used to do a bare `jwt.verify` +
// user lookup. That skipped two checks `requireAuth` enforces on every HTTP
// request, so a socket was strictly weaker than the REST API:
//
//   1. Session binding. Tokens carry a `sid` pointing at a Session row; logging
//      out / revoking a device / changing a password flips `revokedAt`. Without
//      this check a revoked JWT still opened a socket until it expired — "log
//      out everywhere" didn't cover realtime, and /yjs is read-write on file
//      content.
//   2. Purpose claim. Other short-lived tokens are signed with the SAME secret
//      and so pass jwt.verify: the 2FA `tmpToken` ({p:'2fa'}, minted BEFORE the
//      TOTP code is checked) and the video `stream` token ({p:'stream'}). Only
//      a full session token (no `p`) may open a socket — otherwise someone with
//      just a password, stopped at the 2FA prompt, could still reach collab.
//
// Returns the user record on success, or null when the socket must be refused;
// callers destroy the socket. `select` lets each caller pick the fields it needs
// (collab additionally needs `role` for access checks).
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';

const DEFAULT_SELECT = { id: true, name: true, email: true, banned: true };

export async function authenticateWs(token, select = DEFAULT_SELECT) {
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    return null; // invalid signature / expired
  }
  // Reject purpose-scoped tokens (2fa tmpToken, stream token): a session token
  // has no `p` claim.
  if (payload.p) return null;
  if (!payload.sid) return null; // pre-session token — force a re-login

  const session = await prisma.session.findUnique({ where: { id: payload.sid } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;

  const user = await prisma.user.findUnique({ where: { id: payload.sub }, select });
  if (!user || user.banned) return null;
  return user;
}
