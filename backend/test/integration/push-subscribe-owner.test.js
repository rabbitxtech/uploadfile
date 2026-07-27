// POST /api/push/subscribe must not let one account take over another's push
// endpoint.
//
// `PushSubscription.endpoint` is globally unique, and the route upserted on it
// while WRITING `userId` in the update branch. So the endpoint — not the
// account — decided who a subscription belongs to, and the last caller to
// present it won.
//
// That is a redirect of someone else's notifications. `sendPush(userId)` loads
// every subscription row for the user and pushes the notification's `title` and
// `body` verbatim, and those strings carry real content: a file name on a
// share or a drop-box upload ("New file uploaded to <folder>"), the first 120
// characters of a comment or an @mention, a group name, the fact that an
// account was banned or approved. Once the row's `userId` is flipped, the
// victim's browser silently stops receiving them (their own re-subscribe is
// what would take it back) and the attacker's receives them instead, with no
// notification to either side and nothing in the UI that lists who a
// subscription belongs to.
//
// An endpoint is not a secret on the scale this matters: it travels through
// whatever the client logs or syncs, and a shared device is the ordinary case
// the update branch was written for. The fix keeps the legitimate re-subscribe
// (same user, refreshed keys) and, for a genuinely reassigned browser, still
// lets the row move — but only after the previous owner's claim is gone, which
// is what `POST /unsubscribe` (already scoped to `userId`) exists to do.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';

const { migrateTestDb, resetDb, disconnect, prisma } = await import('../helpers/db.js');
const { makeUser, login } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');

const app = buildApp();

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123-victim-endpoint';
const sub = (endpoint, p256dh = 'p256dh-key', auth = 'auth-key') => ({
  subscription: { endpoint, keys: { p256dh, auth } },
});

beforeAll(() => {
  migrateTestDb();
}, 120_000);

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disconnect();
});

describe('POST /api/push/subscribe — a subscription belongs to one account', () => {
  it('refuses a second user claiming an endpoint another user holds', async () => {
    const victim = await makeUser();
    const attacker = await makeUser();
    const v = await login(victim);
    const a = await login(attacker);

    const first = await request(app)
      .post('/api/push/subscribe')
      .set('Authorization', v.auth)
      .send(sub(ENDPOINT));
    expect(first.status).toBe(201);

    const stolen = await request(app)
      .post('/api/push/subscribe')
      .set('Authorization', a.auth)
      .send(sub(ENDPOINT, 'attacker-p256dh', 'attacker-auth'));
    expect(stolen.status).toBe(409);

    // The row still points at the victim, with the victim's keys.
    const row = await prisma.pushSubscription.findUnique({ where: { endpoint: ENDPOINT } });
    expect(row.userId).toBe(victim.id);
    expect(row.p256dh).toBe('p256dh-key');
  });

  it('still lets the same user re-subscribe with refreshed keys', async () => {
    // The ordinary case the upsert was written for: a browser rotating its keys
    // on the same endpoint must keep working, not 409.
    const user = await makeUser();
    const { auth } = await login(user);

    await request(app).post('/api/push/subscribe').set('Authorization', auth).send(sub(ENDPOINT));
    const again = await request(app)
      .post('/api/push/subscribe')
      .set('Authorization', auth)
      .send(sub(ENDPOINT, 'rotated-p256dh', 'rotated-auth'));

    expect(again.status).toBe(201);
    const row = await prisma.pushSubscription.findUnique({ where: { endpoint: ENDPOINT } });
    expect(row.userId).toBe(user.id);
    expect(row.p256dh).toBe('rotated-p256dh');
    expect(await prisma.pushSubscription.count()).toBe(1);
  });

  it('lets a genuinely handed-over browser re-register after the first user unsubscribes', async () => {
    // A shared device really does change hands. The route to that is the
    // previous owner releasing their claim, which POST /unsubscribe already
    // scopes to their own userId.
    const first = await makeUser();
    const second = await makeUser();
    const f = await login(first);
    const s = await login(second);

    await request(app).post('/api/push/subscribe').set('Authorization', f.auth).send(sub(ENDPOINT));
    const blocked = await request(app)
      .post('/api/push/subscribe')
      .set('Authorization', s.auth)
      .send(sub(ENDPOINT));
    expect(blocked.status).toBe(409);

    const released = await request(app)
      .post('/api/push/unsubscribe')
      .set('Authorization', f.auth)
      .send({ endpoint: ENDPOINT });
    expect(released.status).toBe(200);

    const taken = await request(app)
      .post('/api/push/subscribe')
      .set('Authorization', s.auth)
      .send(sub(ENDPOINT));
    expect(taken.status).toBe(201);
    const row = await prisma.pushSubscription.findUnique({ where: { endpoint: ENDPOINT } });
    expect(row.userId).toBe(second.id);
  });

  it('does not let one user unsubscribe another user\'s endpoint', async () => {
    // The complement of the rule above: if a stranger could release the claim,
    // the 409 would only be a speed bump.
    const victim = await makeUser();
    const attacker = await makeUser();
    const v = await login(victim);
    const a = await login(attacker);

    await request(app).post('/api/push/subscribe').set('Authorization', v.auth).send(sub(ENDPOINT));
    const res = await request(app)
      .post('/api/push/unsubscribe')
      .set('Authorization', a.auth)
      .send({ endpoint: ENDPOINT });

    expect(res.status).toBe(200); // deleteMany matched nothing — no enumeration
    const row = await prisma.pushSubscription.findUnique({ where: { endpoint: ENDPOINT } });
    expect(row).not.toBeNull();
    expect(row.userId).toBe(victim.id);
  });
});
