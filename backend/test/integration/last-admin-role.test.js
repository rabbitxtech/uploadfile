// PATCH /api/users/:id must not be able to demote the LAST admin.
//
// DELETE /api/users/:id already refuses to remove the last admin, and its own
// comment spells out why the consequence is unrecoverable: the bootstrap that
// grants the `admin` role is gated on `prisma.user.count() === 0`, so with any
// user still in the database it can never fire again. Lose the last admin and
// every requireRole('admin') route — user management, groups, the audit log,
// the reindex backfill, approving new sign-ups — is permanently unreachable,
// with no in-app way back. Recovery means hand-editing the database.
//
// The role field on PATCH had no such guard, so the exact state DELETE refuses
// to create was one `{"role":"user"}` away, and reachable by accident: an admin
// tidying up their own account, or two admins demoting each other, gets there
// without touching a delete button. Worse than the delete case, it does not
// even need a second admin to exist — an admin can demote THEMSELVES, which the
// delete route explicitly forbids ("Cannot delete self").
//
// A demotion is refused only when it would take the count to zero, so an
// ordinary demotion among several admins keeps working.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';

const { migrateTestDb, resetDb, disconnect, prisma } = await import('../helpers/db.js');
const { makeUser, login } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');

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

describe('PATCH /api/users/:id — the last admin cannot be demoted', () => {
  it('refuses an admin demoting themselves when they are the only one', async () => {
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);

    const res = await request(app)
      .patch(`/api/users/${admin.id}`)
      .set('Authorization', auth)
      .send({ role: 'user' });

    expect(res.status).toBe(400);
    const after = await prisma.user.findUnique({ where: { id: admin.id } });
    expect(after.role).toBe('admin');
  });

  it('refuses demoting the last admin even when other (non-admin) users exist', async () => {
    const admin = await makeUser({ role: 'admin' });
    await makeUser();
    await makeUser();
    const { auth } = await login(admin);

    const res = await request(app)
      .patch(`/api/users/${admin.id}`)
      .set('Authorization', auth)
      .send({ role: 'user' });

    expect(res.status).toBe(400);
    expect((await prisma.user.findUnique({ where: { id: admin.id } })).role).toBe('admin');
  });

  it('refuses one admin demoting the other down to zero', async () => {
    // Two admins: A demotes B (fine, one left), then B — now an ordinary user —
    // is no longer able to act, so A demoting themselves is what would empty it.
    const a = await makeUser({ role: 'admin' });
    const b = await makeUser({ role: 'admin' });
    const { auth } = await login(a);

    const first = await request(app)
      .patch(`/api/users/${b.id}`)
      .set('Authorization', auth)
      .send({ role: 'user' });
    expect(first.status).toBe(200);
    expect(first.body.user.role).toBe('user');

    const second = await request(app)
      .patch(`/api/users/${a.id}`)
      .set('Authorization', auth)
      .send({ role: 'user' });
    expect(second.status).toBe(400);
    expect((await prisma.user.findUnique({ where: { id: a.id } })).role).toBe('admin');
  });

  // Control cases: the guard must only ever fire on the last one.
  it('allows demoting an admin while another remains', async () => {
    const a = await makeUser({ role: 'admin' });
    const b = await makeUser({ role: 'admin' });
    const { auth } = await login(a);

    const res = await request(app)
      .patch(`/api/users/${b.id}`)
      .set('Authorization', auth)
      .send({ role: 'user' });

    expect(res.status).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: b.id } })).role).toBe('user');
    expect(await prisma.user.count({ where: { role: 'admin' } })).toBe(1);
  });

  it('leaves other fields on the last admin editable', async () => {
    // The guard is about the role field alone — banning is separately refused
    // for self, and a quota change on the last admin must still work.
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);

    const res = await request(app)
      .patch(`/api/users/${admin.id}`)
      .set('Authorization', auth)
      .send({ name: 'Renamed', quotaBytes: '123456' });

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Renamed');
    expect(res.body.user.quotaBytes).toBe('123456');
    expect(res.body.user.role).toBe('admin');
  });

  it('allows a no-op role write on the last admin', async () => {
    // Sending role:'admin' for someone who is already an admin changes nothing,
    // so it must not be caught by the guard.
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);

    const res = await request(app)
      .patch(`/api/users/${admin.id}`)
      .set('Authorization', auth)
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin');
  });
});
