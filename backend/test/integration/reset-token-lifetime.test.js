// A password-RESET link must not outlive the password it overrides.
//
// `claimToken` (fixed in an earlier pass) makes ONE link single-use. It says
// nothing about how many links exist, and nothing ever spent the siblings: each
// `forgot-password` mints a fresh Token row and leaves the previous ones
// `usedAt: null` for the rest of their hour. So the flow was single-use per
// link but multi-use per REQUEST, and that breaks in two directions:
//
//   1. Ask for the reset mail twice because the first was slow, use the second,
//      and the first still resets the account for the remainder of its TTL.
//   2. Worse: a live reset link SURVIVES the password change it is competing
//      with. `PATCH /users/me {password}` already revokes every other session on
//      the premise that older credentials are no longer trusted, and an admin's
//      `PATCH /users/:id {password}` additionally drops every API key on the
//      premise that it is taking control back from whoever holds the current
//      password. A reset link is the one credential that OUTRANKS a password,
//      and it was the only one left alive through both.
//
// The scenario needs no attack: a shared inbox, a forwarded mail, or a device
// that was briefly not the owner's is enough for someone to have seen the link
// once, and the owner's natural reaction — setting a new password — did nothing
// about it.
//
// Needs a real database: every assertion here is about which rows the route
// leaves live, and the routes are driven over real HTTP.
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
const { makeUser, login } = await import('../helpers/fixtures.js');
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

// Issue a reset token exactly the way POST /auth/forgot-password does.
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

async function issueVerify(user, { ttlMs = 24 * 60 * 60 * 1000 } = {}) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await prisma.token.create({
    data: {
      userId: user.id,
      type: 'verify',
      hash: sha256(raw),
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
  return raw;
}

describe('a completed reset spends the OTHER live reset links', () => {
  it('refuses an earlier link once a later one has been used', async () => {
    const user = await makeUser({ password: 'OriginalPass1!' });
    // Two mails requested — the ordinary "the first one was slow" case.
    const first = await issueReset(user);
    const second = await issueReset(user);

    const used = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: second, password: 'SecondPass1!' });
    expect(used.status).toBe(200);

    // The link the user never used must not still be able to override the
    // password they just set.
    const stale = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: first, password: 'AttackerPass1!' });
    expect(stale.status).toBe(400);

    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare('SecondPass1!', fresh.password)).toBe(true);
    expect(await bcrypt.compare('AttackerPass1!', fresh.password)).toBe(false);
  });

  it('leaves no live reset token behind at all', async () => {
    const user = await makeUser({ password: 'OriginalPass1!' });
    await issueReset(user);
    await issueReset(user);
    const last = await issueReset(user);

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: last, password: 'FinalPass1!' });
    expect(res.status).toBe(200);

    const live = await prisma.token.count({
      where: { userId: user.id, type: 'reset', usedAt: null },
    });
    expect(live).toBe(0);
  });

  it('does not touch another user’s reset links', async () => {
    const victim = await makeUser({ password: 'VictimPass1!' });
    const other = await makeUser({ password: 'OtherPass1!' });
    const otherToken = await issueReset(other);
    const victimToken = await issueReset(victim);

    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: victimToken, password: 'NewVictimPass1!' });

    // The bystander's link is untouched and still works.
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: otherToken, password: 'NewOtherPass1!' });
    expect(res.status).toBe(200);
  });
});

describe('changing the password by hand spends the live reset links', () => {
  it('kills a reset link the user never used', async () => {
    const user = await makeUser({ password: 'OriginalPass1!' });
    // Someone (or the user) triggered a reset mail; the link is out there.
    const leaked = await issueReset(user);

    const { auth } = await login(user);
    const changed = await request(app)
      .patch('/api/users/me')
      .set('Authorization', auth)
      .send({ password: 'ChosenByOwner1!' });
    expect(changed.status).toBe(200);

    // The owner's reaction to a suspicious reset mail is to change their
    // password. That must actually close the door.
    const stale = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: leaked, password: 'AttackerPass1!' });
    expect(stale.status).toBe(400);

    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare('ChosenByOwner1!', fresh.password)).toBe(true);
  });

  it('still keeps the caller signed in (this route is rotation, not recovery)', async () => {
    const user = await makeUser({ password: 'OriginalPass1!' });
    await issueReset(user);
    const { auth } = await login(user);

    await request(app)
      .patch('/api/users/me')
      .set('Authorization', auth)
      .send({ password: 'ChosenByOwner1!' });

    // Control: the existing behaviour must not regress. A password CHANGE keeps
    // the current session (and, deliberately, the user's API keys).
    const me = await request(app).get('/api/auth/me').set('Authorization', auth);
    expect(me.status).toBe(200);
  });
});

describe('an admin password reset spends the live reset links too', () => {
  it('kills the target user’s outstanding reset link', async () => {
    const admin = await makeUser({ role: 'admin', password: 'AdminPass1!' });
    const target = await makeUser({ password: 'TargetPass1!' });
    const leaked = await issueReset(target);

    const { auth } = await login(admin);
    const res = await request(app)
      .patch(`/api/users/${target.id}`)
      .set('Authorization', auth)
      .send({ password: 'SetByAdmin1!' });
    expect(res.status).toBe(200);

    // An admin resets a password to take control back from whoever holds the
    // current one. A live link would hand it straight back.
    const stale = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: leaked, password: 'AttackerPass1!' });
    expect(stale.status).toBe(400);
  });
});

describe('verification links', () => {
  it('spends the sibling links once the address is verified', async () => {
    const user = await makeUser({ emailVerified: false, approved: false });
    const first = await issueVerify(user);
    const second = await issueVerify(user);

    const ok = await request(app).post('/api/auth/verify-email').send({ token: second });
    expect(ok.status).toBe(200);

    // The address is proven; a second link proves nothing and is just a live
    // token sitting in an inbox.
    const stale = await request(app).post('/api/auth/verify-email').send({ token: first });
    expect(stale.status).toBe(400);

    // ...and it must not have minted a second session from one registration.
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it('does not spend a reset link when an address is verified', async () => {
    const user = await makeUser({ emailVerified: false, approved: false });
    const resetToken = await issueReset(user);
    const verifyToken = await issueVerify(user);

    await request(app).post('/api/auth/verify-email').send({ token: verifyToken });

    // The two kinds share one table and are discriminated only by `type`;
    // verifying an address says nothing about the password.
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: resetToken, password: 'StillValid1!' });
    expect(res.status).toBe(200);
  });
});
