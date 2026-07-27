// A single-use Token is consumed with a compare-and-set, not a read-modify-write.
//
// `Token` backs both the password RESET and the email VERIFICATION link, and
// `usedAt` is the whole of what makes either one single-use. Both routes read
// the row, check `usedAt`, and only then write it — two statements, with the
// bcrypt hash of the new password sitting in between on the reset path, which
// makes the window comfortably wide.
//
// Under concurrency every caller reads the same un-used row, every caller
// decides the token is fresh, and every caller commits. Measured against a real
// PostgreSQL: five concurrent resets on ONE token all returned 200, and the
// LAST writer decided the account's final password — while each of the other
// four was told its reset had succeeded.
//
// That is the same defect class this codebase has already fixed twice, and
// CLAUDE.md records the rule: `UploadSession.parts`, `User.recoveryCodes`,
// `reserveQuota` and `upload/complete` all use a conditional `updateMany`
// precisely because a check and a commit written as two statements is not a
// claim. A reset token is the credential that overrides the password, so it
// owes at least what a recovery code owes.
//
// The fix must not make an ORDINARY reset flaky: the control cases below pin
// that a first use still works and a genuine replay is still refused.
//
// Needs a real database — the defect only exists between two concurrent
// statements, so nothing short of real row-level serialisation reproduces it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

vi.mock('../../src/services/mail.service.js', () => ({
  sendPasswordReset: vi.fn(async () => {}),
  sendVerifyEmail: vi.fn(async () => {}),
  looksLikeEmail: () => true,
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');

const app = buildApp();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

beforeAll(() => {
  migrateTestDb();
}, 120_000);

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disconnect();
});

// Issue a reset token the way POST /auth/forgot-password does.
async function issueReset(user, { ttlMs = 60 * 60 * 1000 } = {}) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await prisma.token.create({
    data: {
      userId: user.id,
      type: 'reset',
      hash: sha256(raw),
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
  return raw;
}

describe('POST /auth/reset-password — the token is single-use under concurrency', () => {
  it('accepts exactly ONE of several concurrent resets on the same token', async () => {
    const user = await makeUser({ password: 'OriginalPass1!' });
    const token = await issueReset(user);

    // Each caller asks for a different password, so the winner is identifiable.
    const candidates = ['AlphaPass1!', 'BravoPass1!', 'CharliePass1!', 'DeltaPass1!', 'EchoPass1!'];
    const results = await Promise.all(
      candidates.map((password) =>
        request(app).post('/api/auth/reset-password').send({ token, password }),
      ),
    );

    const accepted = results.filter((r) => r.status === 200);
    expect(accepted).toHaveLength(1);
    // The losers must be told plainly, not silently ignored.
    for (const r of results.filter((r) => r.status !== 200)) {
      expect(r.status).toBe(400);
    }

    // Exactly one of the candidate passwords is live, and it is the one whose
    // request was accepted — not simply whichever statement committed last.
    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    const working = [];
    for (const p of candidates) {
      if (await bcrypt.compare(p, fresh.password)) working.push(p);
    }
    expect(working).toHaveLength(1);

    const row = await prisma.token.findFirst({ where: { userId: user.id, type: 'reset' } });
    expect(row.usedAt).not.toBeNull();
  });

  it('burns the token so a later replay is refused', async () => {
    const user = await makeUser({ password: 'OriginalPass1!' });
    const token = await issueReset(user);

    const first = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'FirstPass1!' });
    expect(first.status).toBe(200);

    const replay = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'SecondPass1!' });
    expect(replay.status).toBe(400);

    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare('FirstPass1!', fresh.password)).toBe(true);
    expect(await bcrypt.compare('SecondPass1!', fresh.password)).toBe(false);
  });

  it('still revokes sessions and API keys on the reset that wins', async () => {
    const user = await makeUser({ password: 'OriginalPass1!' });
    await prisma.session.create({
      data: {
        userId: user.id,
        userAgent: 'old device',
        ip: '10.0.0.1',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await prisma.apiKey.create({
      data: { userId: user.id, name: 'script', prefix: 'uk_abc123', hash: sha256('uk_secret') },
    });

    const token = await issueReset(user);
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'BrandNewPass1!' });
    expect(res.status).toBe(200);

    // The whole premise of a reset is that older credentials stop working.
    expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    expect(await prisma.apiKey.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });

  it('refuses an expired token', async () => {
    const user = await makeUser({ password: 'OriginalPass1!' });
    const token = await issueReset(user, { ttlMs: -1000 });

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'NopePass1!' });
    expect(res.status).toBe(400);

    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare('OriginalPass1!', fresh.password)).toBe(true);
  });

  it('refuses a verify-email token presented to the reset route', async () => {
    const user = await makeUser({ password: 'OriginalPass1!' });
    const raw = crypto.randomBytes(32).toString('base64url');
    await prisma.token.create({
      data: {
        userId: user.id,
        type: 'verify',
        hash: sha256(raw),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });

    // The two kinds are discriminated by `type` on one table, so the claim has
    // to check it — otherwise a verification link doubles as a password reset.
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: raw, password: 'WrongWayPass1!' });
    expect(res.status).toBe(400);

    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare('OriginalPass1!', fresh.password)).toBe(true);
    const row = await prisma.token.findFirst({ where: { userId: user.id, type: 'verify' } });
    expect(row.usedAt).toBeNull();
  });
});

describe('POST /auth/verify-email — the token is single-use under concurrency', () => {
  it('accepts exactly ONE of several concurrent verifications', async () => {
    const user = await makeUser({ emailVerified: false, approved: false });
    const raw = crypto.randomBytes(32).toString('base64url');
    await prisma.token.create({
      data: {
        userId: user.id,
        type: 'verify',
        hash: sha256(raw),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });

    const results = await Promise.all(
      [1, 2, 3, 4].map(() => request(app).post('/api/auth/verify-email').send({ token: raw })),
    );

    // Each success mints a real Session, so a token consumed N times hands out N
    // logins from one emailed link.
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);

    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(fresh.emailVerified).toBe(true);
  });
});
