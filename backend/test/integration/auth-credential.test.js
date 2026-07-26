// Credential lookup: the address a user typed must resolve to their account.
//
// Self-registration lowercases the address before storing it (registerSchema),
// but every lookup matched the RAW input — so a user who registered
// "Bob@Example.com" got a 201, and that same string then got 401 at login. Only
// the all-lowercase spelling worked, which the user has no way to guess.
// forgot-password was worse: it answers 200 either way (no enumeration), so
// recovery silently did nothing.
//
// Not reachable from the unit suite — it needs a real User row whose stored
// email differs in case from what the request carries.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (u, e) => `u/${u}/${Math.random().toString(36).slice(2)}.${e}`,
  putObjectStream: vi.fn(async () => {}),
  putObjectBuffer: vi.fn(async () => {}),
  getObjectStream: vi.fn(async () => null),
  getObjectRange: vi.fn(async () => null),
  removeObject: vi.fn(async () => {}),
  statObject: vi.fn(async () => ({ size: 0 })),
  removePrefix: vi.fn(async () => {}),
  presignedGet: vi.fn(async () => 'http://minio.test/object'),
  initiateMultipart: vi.fn(async () => 'test-upload-id'),
  uploadPart: vi.fn(async () => ({})),
  completeMultipart: vi.fn(async () => ({})),
  abortMultipart: vi.fn(async () => {}),
}));

vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
}));

const sentResets = [];
const sentVerifications = [];
vi.mock('../../src/services/mail.service.js', () => ({
  sendPasswordReset: vi.fn(async (to) => { sentResets.push(to); }),
  sendVerifyEmail: vi.fn(async (to) => { sentVerifications.push(to); }),
  looksLikeEmail: () => true,
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');

const app = buildApp();
const PASSWORD = 'TestPass123!';

beforeAll(() => {
  migrateTestDb();
}, 120_000);

beforeEach(async () => {
  await resetDb();
  sentResets.length = 0;
  sentVerifications.length = 0;
  // The first registered user becomes admin and is auto-verified; seed one so
  // the accounts under test follow the ordinary self-registration path.
  await makeUser({ role: 'admin' });
});

afterAll(async () => {
  await disconnect();
});

const register = (email) =>
  request(app).post('/api/auth/register').send({ email, password: PASSWORD });
const login = (email) =>
  request(app).post('/api/auth/login').send({ email, password: PASSWORD });

describe('credential lookup is case-tolerant for stored emails', () => {
  it('logs in with the exact string used to register', async () => {
    const typed = 'Bob.Smith@Example.COM';
    expect((await register(typed)).status).toBe(201);

    // Registration stores it lowercased and requires verification first.
    const stored = await prisma.user.findUnique({ where: { email: typed.toLowerCase() } });
    expect(stored).not.toBeNull();
    await prisma.user.update({ where: { id: stored.id }, data: { emailVerified: true } });

    // The spelling the user actually typed must work...
    expect((await login(typed)).status).toBe(200);
    // ...and so must the canonical one.
    expect((await login(typed.toLowerCase())).status).toBe(200);
  });

  it('sends a password reset for the address as the user spells it', async () => {
    const typed = 'Carol@Example.com';
    await register(typed);
    sentVerifications.length = 0;

    const res = await request(app).post('/api/auth/forgot-password').send({ identifier: typed });
    expect(res.status).toBe(200); // always 200 — no account enumeration
    // The silent failure this test exists for: 200 with no mail sent at all.
    expect(sentResets).toEqual([typed.toLowerCase()]);
  });

  it('resends verification for the address as the user spells it', async () => {
    const typed = 'Dave@Example.com';
    await register(typed);
    sentVerifications.length = 0;

    const res = await request(app).post('/api/auth/resend-verification').send({ identifier: typed });
    expect(res.status).toBe(200);
    expect(sentVerifications).toEqual([typed.toLowerCase()]);
  });

  it('still rejects a genuinely wrong password and an unknown account', async () => {
    const typed = 'Erin@Example.com';
    await register(typed);
    const stored = await prisma.user.findUnique({ where: { email: typed.toLowerCase() } });
    await prisma.user.update({ where: { id: stored.id }, data: { emailVerified: true } });

    const wrong = await request(app).post('/api/auth/login')
      .send({ email: typed, password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect((await login('nobody@example.com')).status).toBe(401);
  });

  // Admin-created accounts may be plain usernames and are NOT lowercased, so
  // the exact match has to win: "Bob" and "bob" stay separate accounts and each
  // must still resolve to itself rather than collapsing onto one row.
  it('prefers an exact username match over the lowercased one', async () => {
    const upper = await prisma.user.create({
      data: {
        email: 'Bob', name: 'upper',
        password: await (await import('bcryptjs')).default.hash(PASSWORD, 4),
        role: 'user', emailVerified: true, approved: true,
      },
    });
    const lower = await prisma.user.create({
      data: {
        email: 'bob', name: 'lower',
        password: await (await import('bcryptjs')).default.hash(PASSWORD, 4),
        role: 'user', emailVerified: true, approved: true,
      },
    });

    const asUpper = await login('Bob');
    expect(asUpper.status).toBe(200);
    expect(asUpper.body.user.id).toBe(upper.id);

    const asLower = await login('bob');
    expect(asLower.status).toBe(200);
    expect(asLower.body.user.id).toBe(lower.id);
  });

  // WebDAV authenticates the same credential, so it owed the same rule —
  // otherwise a self-registered user cannot mount their own drive.
  it('authenticates WebDAV with the address as the user spells it', async () => {
    const typed = 'Frank@Example.com';
    await register(typed);
    const stored = await prisma.user.findUnique({ where: { email: typed.toLowerCase() } });
    await prisma.user.update({ where: { id: stored.id }, data: { emailVerified: true } });

    const basic = 'Basic ' + Buffer.from(`${typed}:${PASSWORD}`).toString('base64');
    const res = await request(app).propfind('/webdav/').set('Authorization', basic).set('Depth', '0');
    expect(res.status).toBe(207);

    const bad = 'Basic ' + Buffer.from(`${typed}:wrong`).toString('base64');
    expect((await request(app).propfind('/webdav/').set('Authorization', bad)).status).toBe(401);
  });
});
