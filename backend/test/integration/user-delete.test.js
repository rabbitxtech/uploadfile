// Deleting a user is a hard delete with a cascade, so it owes what every other
// hard-delete path in this codebase owes: remove the MinIO objects.
//
// `File.owner` is onDelete: Cascade, so the File/FileVersion rows — the ONLY
// record of which object keys exist — vanish with the user. Dropping the rows
// without the objects leaves storage that nothing can ever attribute or reclaim,
// the same unreconcilable drift the version-sum refunds exist to prevent. The
// object keys therefore have to be read BEFORE the delete, which is the part a
// refactor is most likely to undo.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

const removedPrefixes = [];
const removedHls = [];

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (userId, ext) => `u/${userId}/x.${ext}`,
  removePrefix: vi.fn(async (p) => { removedPrefixes.push(p); }),
  removeObject: vi.fn(async () => {}),
  putObjectBuffer: vi.fn(async () => {}),
  putObjectStream: vi.fn(async () => {}),
  getObjectStream: vi.fn(async () => null),
  getObjectRange: vi.fn(async () => null),
  statObject: vi.fn(async () => ({ size: 0 })),
  presignedGet: vi.fn(async () => 'http://minio.test/o'),
}));
vi.mock('../../src/services/hls.service.js', () => ({
  removeHls: vi.fn(async (id) => { removedHls.push(id); }),
  hlsPrefix: (id) => `h/${id}/`,
}));
vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, login, makeFile } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');

const app = buildApp();

beforeAll(() => { migrateTestDb(); }, 120_000);
beforeEach(async () => {
  await resetDb();
  removedPrefixes.length = 0;
  removedHls.length = 0;
});
afterAll(async () => { await disconnect(); });

const makeAdmin = () => makeUser({ role: 'admin' });

// The cleanup is detached (the account is already gone; a storage hiccup must
// not 500 a completed delete), so it can land just after the response.
async function settle() {
  for (let i = 0; i < 20 && removedPrefixes.length < 2; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('deleting a user', () => {
  it('removes the user\'s objects, thumbnails and HLS renditions', async () => {
    const admin = await makeAdmin();
    const { auth } = await login(admin);
    const victim = await makeUser();
    const f1 = await makeFile(victim);
    const f2 = await makeFile(victim);

    const res = await request(app)
      .delete(`/api/users/${victim.id}`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    await settle();

    // Per-user prefixes cover the objects and their thumbnails (`t/` mirrors `u/`).
    expect(removedPrefixes).toContain(`u/${victim.id}/`);
    expect(removedPrefixes).toContain(`t/${victim.id}/`);
    // HLS is keyed by fileId, so the ids must have been read before the cascade
    // destroyed the rows — this is what fails if the lookup moves after delete.
    expect(removedHls.sort()).toEqual([f1.id, f2.id].sort());
  });

  it('still deletes the rows (the cascade is not disturbed)', async () => {
    const admin = await makeAdmin();
    const { auth } = await login(admin);
    const victim = await makeUser();
    await makeFile(victim);

    await request(app).delete(`/api/users/${victim.id}`).set('Authorization', auth);

    expect(await prisma.user.findUnique({ where: { id: victim.id } })).toBeNull();
    expect(await prisma.file.count({ where: { ownerId: victim.id } })).toBe(0);
  });

  it('does not touch a bystander\'s objects or rows', async () => {
    const admin = await makeAdmin();
    const { auth } = await login(admin);
    const victim = await makeUser();
    const bystander = await makeUser();
    await makeFile(victim);
    await makeFile(bystander);

    await request(app).delete(`/api/users/${victim.id}`).set('Authorization', auth);
    await settle();

    expect(removedPrefixes).not.toContain(`u/${bystander.id}/`);
    expect(removedPrefixes).not.toContain(`t/${bystander.id}/`);
    expect(await prisma.file.count({ where: { ownerId: bystander.id } })).toBe(1);
  });

  it('a user with no files deletes cleanly', async () => {
    const admin = await makeAdmin();
    const { auth } = await login(admin);
    const victim = await makeUser();

    const res = await request(app)
      .delete(`/api/users/${victim.id}`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    await settle();

    // The prefix sweep still runs (cheap, and covers objects whose rows were
    // already gone); there is simply no HLS work.
    expect(removedHls).toEqual([]);
  });

  it('404s on an unknown id instead of sweeping a prefix', async () => {
    const admin = await makeAdmin();
    const { auth } = await login(admin);

    const res = await request(app)
      .delete('/api/users/00000000-0000-0000-0000-000000000000')
      .set('Authorization', auth);
    expect(res.status).toBe(404);
    expect(removedPrefixes).toEqual([]);
  });
});
