// A password RESET must kill every bearer credential on the account — including
// API keys.
//
// `requireAuth` accepts two completely different credentials:
//
//   - a JWT carrying a `sid`, which resolves to a `Session` row. Revoking that
//     row is what makes "log out everywhere" work.
//   - an API key (`Authorization: Bearer uk_…` or `X-API-Key: uk_…`), which
//     resolves straight to `req.user`. It carries no `sid`, so NOTHING in the
//     session machinery touches it, and `ApiKey` has a `revokedAt` but no
//     `expiresAt` — it never lapses on its own.
//
// That made a key strictly more durable than a login: it survived logout,
// "revoke other sessions", a password change and a password reset alike. A
// password reset exists for exactly one situation — the account may be
// compromised — and its whole promise is that whoever held the old credentials
// stops being able to act. An attacker who reached the account for a moment can
// call POST /api/keys, and that key then outlived the recovery with full
// read/write access to every file, while the owner had just been told they were
// safe. Nothing in the reset flow surfaces that a key exists, so they would have
// no reason to go looking for it.
//
// Both credential-reset paths are covered: the self-serve /reset-password (the
// user recovering their own account) and an admin setting another user's
// password (an admin does that to take control back from whoever holds the
// current one).
//
// Deliberately NOT covered, because it is deliberately not the behaviour:
// PATCH /users/me with a new password. That is routine hygiene rather than
// recovery — it keeps the caller's own session alive on purpose — and destroying
// the user's scripts and integrations every time they rotate a password would be
// a different, worse bug.
//
// Needs a real database: this is a row-state change, so the key either still
// authenticates or it doesn't.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (u, e) => `u/${u}/${Math.random().toString(36).slice(2)}.${e}`,
  putObjectStream: vi.fn(async () => {}),
  putObjectBuffer: vi.fn(async () => {}),
  getObjectStream: vi.fn(async () => null),
  getObjectRange: vi.fn(async () => null),
  removeObject: vi.fn(async () => {}),
  statObject: vi.fn(async () => ({ size: 0 })),
  removePrefix: vi.fn(async () => {}),
  presignedGet: vi.fn(async () => 'http://minio.test/SIGNED'),
}));
vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  queueIndexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
}));
vi.mock('../../src/services/mail.service.js', () => ({
  sendPasswordReset: vi.fn(async () => {}),
  sendVerifyEmail: vi.fn(async () => {}),
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, login } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');
const { API_KEY_PREFIX, hashApiKey } = await import('../../src/middleware/auth.js');

const app = buildApp();

beforeAll(() => {
  migrateTestDb();
}, 120_000);

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disconnect();
});

/** Mint a real API key row and return the plaintext secret, as POST /keys does. */
async function makeApiKey(user, name = 'ci-key') {
  const secret = API_KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
  await prisma.apiKey.create({
    data: { userId: user.id, name, prefix: secret.slice(0, 10), hash: hashApiKey(secret) },
  });
  return secret;
}

/** Issue a real reset token the way POST /forgot-password does. */
async function makeResetToken(user) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await prisma.token.create({
    data: {
      userId: user.id,
      type: 'reset',
      hash: crypto.createHash('sha256').update(raw).digest('hex'),
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return raw;
}

describe('password reset revokes API keys', () => {
  it('stops a key that was working right before the reset', async () => {
    const user = await makeUser();
    const key = await makeApiKey(user);

    // The key authenticates before the reset — otherwise the assertion after it
    // would pass against a key that never worked at all.
    const before = await request(app).get('/api/auth/me').set('X-API-Key', key);
    expect(before.status).toBe(200);
    expect(before.body.user.id).toBe(user.id);

    const token = await makeResetToken(user);
    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'BrandNewPass123!' });
    expect(reset.status).toBe(200);

    // This is the whole point: the credential the attacker minted is dead.
    const after = await request(app).get('/api/auth/me').set('X-API-Key', key);
    expect(after.status).toBe(401);
  });

  it('revokes it via the Bearer form too — same credential, different header', async () => {
    const user = await makeUser();
    const key = await makeApiKey(user);
    const token = await makeResetToken(user);
    await request(app).post('/api/auth/reset-password').send({ token, password: 'BrandNewPass123!' });

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${key}`);
    expect(res.status).toBe(401);
  });

  it('marks the row revoked rather than deleting it, so the key stays listed', async () => {
    // The user should be able to SEE that the key was cut off — a silently
    // vanished key looks like it was never there, which is the opposite of the
    // reassurance a recovery flow owes.
    const user = await makeUser();
    await makeApiKey(user, 'the-attackers-key');
    const token = await makeResetToken(user);
    await request(app).post('/api/auth/reset-password').send({ token, password: 'BrandNewPass123!' });

    const rows = await prisma.apiKey.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('the-attackers-key');
    expect(rows[0].revokedAt).not.toBeNull();
  });

  it('leaves another user’s keys alone', async () => {
    const victim = await makeUser();
    const bystander = await makeUser();
    const bystanderKey = await makeApiKey(bystander);

    const token = await makeResetToken(victim);
    await request(app).post('/api/auth/reset-password').send({ token, password: 'BrandNewPass123!' });

    const res = await request(app).get('/api/auth/me').set('X-API-Key', bystanderKey);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(bystander.id);
  });

  it('revokes sessions as well — the reset must not trade one gap for another', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const token = await makeResetToken(user);
    await request(app).post('/api/auth/reset-password').send({ token, password: 'BrandNewPass123!' });

    const res = await request(app).get('/api/auth/me').set('Authorization', auth);
    expect(res.status).toBe(401);
  });
});

describe('an admin resetting a password revokes that user’s API keys', () => {
  it('cuts off the key an admin is resetting the password to take back', async () => {
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser();
    const key = await makeApiKey(target);
    const { auth } = await login(admin);

    const before = await request(app).get('/api/auth/me').set('X-API-Key', key);
    expect(before.status).toBe(200);

    const patch = await request(app)
      .patch(`/api/users/${target.id}`)
      .set('Authorization', auth)
      .send({ password: 'AdminSetPass123!' });
    expect(patch.status).toBe(200);

    const after = await request(app).get('/api/auth/me').set('X-API-Key', key);
    expect(after.status).toBe(401);
  });

  it('does not touch the keys when the admin edits something other than the password', async () => {
    // Approving a user, changing their quota or renaming them is not a
    // credential event, and revoking their integrations there would be a
    // surprise with no security argument behind it.
    const admin = await makeUser({ role: 'admin' });
    const target = await makeUser({ approved: false });
    const key = await makeApiKey(target);
    const { auth } = await login(admin);

    const patch = await request(app)
      .patch(`/api/users/${target.id}`)
      .set('Authorization', auth)
      .send({ approved: true, quotaBytes: '99999999' });
    expect(patch.status).toBe(200);

    const after = await request(app).get('/api/auth/me').set('X-API-Key', key);
    expect(after.status).toBe(200);
  });
});

describe('routine password changes keep API keys alive', () => {
  it('PATCH /users/me does not revoke the caller’s keys', async () => {
    // Documented, deliberate asymmetry — see the header comment. Pinned so a
    // later "make it consistent" edit has to be a decision rather than a slip.
    const user = await makeUser();
    const key = await makeApiKey(user);
    const { auth } = await login(user);

    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', auth)
      .send({ password: 'RotatedPass123!' });
    expect(res.status).toBe(200);

    const after = await request(app).get('/api/auth/me').set('X-API-Key', key);
    expect(after.status).toBe(200);
  });
});
