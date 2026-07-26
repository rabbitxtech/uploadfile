// A public share must die with its target — folders included.
//
// `assertShareTargetLive()` was written for the single-FILE case (trashing a
// file is the user's "un-share it" action) and returned early for a folder
// share, on the reasoning that the listing already filters trashed files out.
// That reasoning covers the file list and nothing else:
//
//   - the link kept RESOLVING. GET /public/:token answered 200 and handed back
//     the folder's name and path — metadata about a folder the owner deleted,
//     to anyone holding the token.
//   - worse, an `allowUpload` drop-box kept ACCEPTING anonymous uploads into it.
//     The new File row is created live (trashedAt: null) inside a trashed
//     parent, so GET /api/folders hides it (that view filters trashedAt: null
//     and there is no path to browse through the dead ancestor) and GET
//     /api/trash does not list it either (that view wants trashedAt != null).
//     The row is billed against the owner's quota and reachable from neither
//     screen — the same unreachable state the restore-ancestor walk exists to
//     prevent, except here an anonymous stranger creates it on demand.
//
// Trashing is the owner's revoke gesture and it has to mean the same thing for
// both share kinds. 404 (not 403) matches how the rest of the public surface
// refuses to confirm what a token points at.
//
// Needs a real database: the fix is a liveness query, so it either finds the
// trashed row or it doesn't.
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
}));
vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  queueIndexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
// No `login` here on purpose — every case in this file drives the PUBLIC,
// unauthenticated share surface, which is the whole point of the gate.
const { makeUser, makeFile, makeFolder } = await import('../helpers/fixtures.js');
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

// Create a share link the way the authenticated route does.
async function makeShare(owner, { folderId = null, fileId = null, allowUpload = false } = {}) {
  return prisma.share.create({
    data: {
      token: `tok-${Math.random().toString(36).slice(2, 12)}`,
      ownerId: owner.id,
      folderId,
      fileId,
      allowUpload,
    },
  });
}

describe('a public folder share dies with the folder', () => {
  it('404s the metadata endpoint once the folder is trashed', async () => {
    const owner = await makeUser();
    const folder = await makeFolder(owner, { name: 'docs' });
    const share = await makeShare(owner, { folderId: folder.id });

    // Live: the link resolves and names the folder.
    const before = await request(app).get(`/api/shares/public/${share.token}`);
    expect(before.status).toBe(200);
    expect(before.body.folder.name).toBe('docs');

    await prisma.folder.update({
      where: { id: folder.id },
      data: { trashedAt: new Date() },
    });

    const after = await request(app).get(`/api/shares/public/${share.token}`);
    expect(after.status).toBe(404);
    // And it discloses nothing about what the token pointed at.
    expect(JSON.stringify(after.body)).not.toContain('docs');
  });

  it('404s the download endpoint once the folder is trashed', async () => {
    const owner = await makeUser();
    const folder = await makeFolder(owner, { name: 'docs' });
    const share = await makeShare(owner, { folderId: folder.id });

    await prisma.folder.update({
      where: { id: folder.id },
      data: { trashedAt: new Date() },
    });

    const res = await request(app).post(`/api/shares/public/${share.token}/download`).send({});
    expect(res.status).toBe(404);
  });

  // The drop-box already 404'd here via its own `trashedAt: null` folder
  // lookup — but that check sits AFTER the password comparison and the
  // per-share upload caps, so a dead link still did bcrypt work and a
  // shareAccess count for anyone poking at it. The shared assertion now runs
  // first. This case pins the refusal itself so a future reordering of that
  // route cannot quietly drop it.
  it('refuses an anonymous drop-box upload into a trashed folder', async () => {
    const owner = await makeUser();
    const folder = await makeFolder(owner, { name: 'inbox' });
    const share = await makeShare(owner, { folderId: folder.id, allowUpload: true });

    await prisma.folder.update({
      where: { id: folder.id },
      data: { trashedAt: new Date() },
    });

    const res = await request(app)
      .post(`/api/shares/public/${share.token}/upload`)
      .attach('file', Buffer.from('hello'), 'note.txt');
    expect(res.status).toBe(404);

    // Nothing was created, and the owner was not charged.
    expect(await prisma.file.count({ where: { folderId: folder.id } })).toBe(0);
    const after = await prisma.user.findUnique({ where: { id: owner.id } });
    expect(after.usedBytes).toBe(0n);
  });

  // The gate must not break the ordinary case.
  it('still serves a live folder share, listing only its live files', async () => {
    const owner = await makeUser();
    const folder = await makeFolder(owner, { name: 'docs' });
    await makeFile(owner, { name: 'live.txt', folderId: folder.id });
    await makeFile(owner, { name: 'gone.txt', folderId: folder.id, trashedAt: new Date() });
    const share = await makeShare(owner, { folderId: folder.id });

    const res = await request(app).get(`/api/shares/public/${share.token}`);
    expect(res.status).toBe(200);
    expect(res.body.files.map((f) => f.name)).toEqual(['live.txt']);
  });

  it('still accepts a drop-box upload into a live folder', async () => {
    const owner = await makeUser();
    const folder = await makeFolder(owner, { name: 'inbox' });
    const share = await makeShare(owner, { folderId: folder.id, allowUpload: true });

    const res = await request(app)
      .post(`/api/shares/public/${share.token}/upload`)
      .attach('file', Buffer.from('hello'), 'note.txt');
    expect(res.status).toBe(201);
    expect(await prisma.file.count({ where: { folderId: folder.id } })).toBe(1);
  });

  // The pre-existing file-share rule must keep working — the folder branch was
  // added in front of it, so this pins that it did not shadow the file case.
  it('still 404s a file share whose file is trashed', async () => {
    const owner = await makeUser();
    const file = await makeFile(owner, { name: 'secret.txt', trashedAt: new Date() });
    const share = await makeShare(owner, { fileId: file.id });

    const res = await request(app).get(`/api/shares/public/${share.token}`);
    expect(res.status).toBe(404);
  });

  it('still serves a live file share', async () => {
    const owner = await makeUser();
    const file = await makeFile(owner, { name: 'ok.txt' });
    const share = await makeShare(owner, { fileId: file.id });

    const res = await request(app).get(`/api/shares/public/${share.token}`);
    expect(res.status).toBe(200);
    expect(res.body.file.name).toBe('ok.txt');
  });
});
