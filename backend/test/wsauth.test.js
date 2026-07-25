// Security: WebSocket handshake auth (/ws, /yjs, /gws).
//
// These sockets used to accept ANY signature-valid JWT, which made them weaker
// than the REST API. Each case below is a real bypass that was possible before
// authenticateWs existed — they must all stay rejected.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = 'test-secret-value-long-enough-abcdefgh';

const h = vi.hoisted(() => ({
  findSession: vi.fn(),
  findUser: vi.fn(),
}));

vi.mock('../src/config/env.js', () => ({
  env: { jwtSecret: 'test-secret-value-long-enough-abcdefgh' },
}));
vi.mock('../src/config/prisma.js', () => ({
  prisma: {
    session: { findUnique: (...a) => h.findSession(...a) },
    user: { findUnique: (...a) => h.findUser(...a) },
  },
}));

import { authenticateWs } from '../src/realtime/wsauth.js';

const USER = { id: 'u1', name: 'Ann', email: 'a@b.c', banned: false };
const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 60_000);

// A normal, fully-authenticated session token.
const sessionToken = (over = {}) =>
  jwt.sign({ sub: 'u1', sid: 's1', ...over }, SECRET, { expiresIn: '1h' });

beforeEach(() => {
  h.findSession.mockReset();
  h.findUser.mockReset();
  h.findSession.mockResolvedValue({ id: 's1', revokedAt: null, expiresAt: future() });
  h.findUser.mockResolvedValue(USER);
});

describe('authenticateWs · accepts a valid session token', () => {
  it('returns the user when session is live and user is active', async () => {
    await expect(authenticateWs(sessionToken())).resolves.toEqual(USER);
  });
});

describe('authenticateWs · rejects malformed credentials', () => {
  it('rejects a missing token', async () => {
    await expect(authenticateWs(null)).resolves.toBeNull();
    await expect(authenticateWs('')).resolves.toBeNull();
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ sub: 'u1', sid: 's1' }, 'wrong-secret');
    await expect(authenticateWs(forged)).resolves.toBeNull();
  });

  it('rejects an expired token', async () => {
    const stale = jwt.sign({ sub: 'u1', sid: 's1' }, SECRET, { expiresIn: '-1s' });
    await expect(authenticateWs(stale)).resolves.toBeNull();
  });
});

describe('authenticateWs · enforces session revocation', () => {
  it('rejects a token whose session was revoked (logout / log out everywhere)', async () => {
    h.findSession.mockResolvedValue({ id: 's1', revokedAt: new Date(), expiresAt: future() });
    await expect(authenticateWs(sessionToken())).resolves.toBeNull();
  });

  it('rejects a token whose session row is gone', async () => {
    h.findSession.mockResolvedValue(null);
    await expect(authenticateWs(sessionToken())).resolves.toBeNull();
  });

  it('rejects a token whose session has expired', async () => {
    h.findSession.mockResolvedValue({ id: 's1', revokedAt: null, expiresAt: past() });
    await expect(authenticateWs(sessionToken())).resolves.toBeNull();
  });

  it('rejects a pre-session token that carries no sid', async () => {
    const old = jwt.sign({ sub: 'u1' }, SECRET, { expiresIn: '1h' });
    await expect(authenticateWs(old)).resolves.toBeNull();
  });
});

describe('authenticateWs · rejects purpose-scoped tokens', () => {
  // The 2FA tmpToken is minted BEFORE the TOTP code is verified and is signed
  // with the same secret — it must never open a socket, or a password alone
  // would reach collab (read-write on file content).
  it('rejects the 2FA tmpToken', async () => {
    const tmp = jwt.sign({ sub: 'u1', p: '2fa' }, SECRET, { expiresIn: '5m' });
    await expect(authenticateWs(tmp)).resolves.toBeNull();
  });

  it('rejects the video stream token', async () => {
    const stream = jwt.sign({ sub: 'u1', fid: 'f1', p: 'stream' }, SECRET, { expiresIn: '3h' });
    await expect(authenticateWs(stream)).resolves.toBeNull();
  });

  it('rejects a purpose token even if it also carries a valid sid', async () => {
    await expect(authenticateWs(sessionToken({ p: '2fa' }))).resolves.toBeNull();
  });
});

describe('authenticateWs · enforces account state', () => {
  it('rejects a banned user', async () => {
    h.findUser.mockResolvedValue({ ...USER, banned: true });
    await expect(authenticateWs(sessionToken())).resolves.toBeNull();
  });

  it('rejects a deleted user', async () => {
    h.findUser.mockResolvedValue(null);
    await expect(authenticateWs(sessionToken())).resolves.toBeNull();
  });

  it('passes the caller-supplied select through (collab needs role)', async () => {
    const select = { id: true, name: true, email: true, role: true, banned: true };
    await authenticateWs(sessionToken(), select);
    expect(h.findUser).toHaveBeenCalledWith({ where: { id: 'u1' }, select });
  });
});
