// Access-control behaviour of files.routes.js against a real database.
//
// This file exists to make the planned split of files.routes.js (1370 lines)
// safe: it pins WHO can reach WHAT before the routes move. Ownership and the
// admin carve-out are enforced by hand at each route, so a route landing in
// the wrong module — or quietly losing its ownership filter — is exactly the
// regression this catches.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (userId, ext) => `u/${userId}/x.${ext}`,
  initiateMultipart: vi.fn(async () => 'up-1'),
  uploadPart: vi.fn(async ({ partNumber, length }) => ({
    partNumber, etag: `e${partNumber}`, size: length ?? 0,
  })),
  completeMultipart: vi.fn(async () => ({})),
  abortMultipart: vi.fn(async () => {}),
  putObjectStream: vi.fn(async () => {}),
  putObjectBuffer: vi.fn(async () => {}),
  getObjectStream: vi.fn(async () => null),
  getObjectRange: vi.fn(async () => null),
  removeObject: vi.fn(async () => {}),
  statObject: vi.fn(async () => ({ size: 0 })),
  removePrefix: vi.fn(async () => {}),
  presignedGet: vi.fn(async () => 'http://minio.test/o'),
}));
vi.mock('../../src/services/media.service.js', () => ({
  postProcessMedia: vi.fn(async () => {}),
}));
vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
}));
vi.mock('../../src/services/thumbnail.service.js', () => ({
  canThumbnail: vi.fn(() => false),
  generateThumbnail: vi.fn(async () => {}),
}));
vi.mock('../../src/services/checksum.service.js', () => ({
  sha: vi.fn(() => 'sum'),
  backfillChecksum: vi.fn(async () => {}),
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, login, makeFile, makeFolder } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');

const app = buildApp();

beforeAll(() => { migrateTestDb(); }, 120_000);
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await disconnect(); });

describe('reading another user\'s file', () => {
  it('a stranger gets 404, not 403 — existence is not disclosed', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const { auth } = await login(stranger);
    const file = await makeFile(owner);

    const res = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('the owner can read it', async () => {
    const owner = await makeUser();
    const { auth } = await login(owner);
    const file = await makeFile(owner, { name: 'mine.txt' });

    const res = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('mine.txt');
  });

  it('an admin can read anyone\'s file (read-only carve-out)', async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const file = await makeFile(owner, { name: 'theirs.txt' });

    const res = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(res.status).toBe(200);
  });
});

describe('writing to another user\'s file', () => {
  // NOTE: admins CAN write to any file. `ownedWhere()` drops the ownerId
  // filter for admins and fileAccessLevel() returns 'admin', by explicit
  // design ("admins act on ANY file/folder" — files.routes.js).
  //
  // .claude/CLAUDE.md claimed the opposite ("write routes keep strict
  // ownership", "admin view-as-user is read-only by design"); the doc was
  // wrong and has been corrected. These tests pin the ACTUAL behaviour so the
  // route split cannot change it silently — if admin writes should ever be
  // removed, that is a deliberate change and these tests are where it starts.
  it('an admin can rename someone else\'s file', async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const file = await makeFile(owner, { name: 'orig.txt' });

    const res = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Authorization', auth)
      .send({ name: 'renamed.txt' });

    expect(res.status).toBe(200);
    const after = await prisma.file.findUnique({ where: { id: file.id } });
    expect(after.name).toBe('renamed.txt');
    expect(after.ownerId).toBe(owner.id); // ownership itself never transfers
  });

  it('an admin can trash someone else\'s file', async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const file = await makeFile(owner);

    const res = await request(app).delete(`/api/files/${file.id}`).set('Authorization', auth);

    expect(res.status).toBe(200);
    const after = await prisma.file.findUnique({ where: { id: file.id } });
    expect(after.trashedAt).not.toBeNull();
  });

  it('a stranger cannot trash a file', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const { auth } = await login(stranger);
    const file = await makeFile(owner);

    await request(app).delete(`/api/files/${file.id}`).set('Authorization', auth);

    const after = await prisma.file.findUnique({ where: { id: file.id } });
    expect(after.trashedAt).toBeNull();
  });

  it('the owner can rename and trash their own file', async () => {
    const owner = await makeUser();
    const { auth } = await login(owner);
    const file = await makeFile(owner, { name: 'a.txt' });

    const renamed = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Authorization', auth)
      .send({ name: 'b.txt' });
    expect(renamed.status).toBe(200);

    const trashed = await request(app)
      .delete(`/api/files/${file.id}`)
      .set('Authorization', auth);
    expect(trashed.status).toBe(200);

    const after = await prisma.file.findUnique({ where: { id: file.id } });
    expect(after.name).toBe('b.txt');
    expect(after.trashedAt).not.toBeNull();
  });
});

describe('trashed files are filtered out of listings', () => {
  it('recent excludes trashed files', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    await makeFile(user, { name: 'live.txt', starred: true });
    const gone = await makeFile(user, { name: 'gone.txt', trashedAt: new Date() });
    // accessedAt drives /recent
    await prisma.file.updateMany({ data: { accessedAt: new Date() } });

    const res = await request(app).get('/api/files/recent').set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.files.map((f) => f.id)).not.toContain(gone.id);
  });

  it('starred excludes trashed files', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const live = await makeFile(user, { starred: true });
    const gone = await makeFile(user, { starred: true, trashedAt: new Date() });

    const res = await request(app).get('/api/files/starred').set('Authorization', auth);

    const ids = res.body.files.map((f) => f.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(gone.id);
  });

  it('another user\'s starred files never appear in yours', async () => {
    const me = await makeUser();
    const them = await makeUser();
    const { auth } = await login(me);
    const theirs = await makeFile(them, { starred: true });

    const res = await request(app).get('/api/files/starred').set('Authorization', auth);

    expect(res.body.files.map((f) => f.id)).not.toContain(theirs.id);
  });
});

describe('star toggle', () => {
  it('flips the flag for the owner and rejects a stranger', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const { auth: ownerAuth } = await login(owner);
    const { auth: strangerAuth } = await login(stranger);
    const file = await makeFile(owner, { starred: false });

    const ok = await request(app)
      .post(`/api/files/${file.id}/star`)
      .set('Authorization', ownerAuth);
    expect(ok.status).toBe(200);
    expect((await prisma.file.findUnique({ where: { id: file.id } })).starred).toBe(true);

    await request(app).post(`/api/files/${file.id}/star`).set('Authorization', strangerAuth);
    // Unchanged by the stranger's attempt.
    expect((await prisma.file.findUnique({ where: { id: file.id } })).starred).toBe(true);
  });
});

describe('session revocation cuts API access', () => {
  it('a revoked session is rejected even though the JWT is still valid', async () => {
    const user = await makeUser();
    const { auth, session } = await login(user);
    const file = await makeFile(user);

    const before = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(before.status).toBe(200);

    await prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    const after = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(after.status).toBe(401);
  });

  it('a banned user is rejected', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    await prisma.user.update({ where: { id: user.id }, data: { banned: true } });

    const res = await request(app).get('/api/files/starred').set('Authorization', auth);
    expect(res.status).toBe(403);
  });
});

describe('upload gating', () => {
  it('an unapproved user cannot start an upload', async () => {
    const user = await makeUser({ approved: false });
    const { auth } = await login(user);

    const res = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'a.txt', size: 10, mimeType: 'text/plain' });

    expect(res.status).toBe(403);
  });

  it('an unapproved admin can (admins always pass)', async () => {
    const admin = await makeUser({ role: 'admin', approved: false });
    const { auth } = await login(admin);

    const res = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'a.txt', size: 10, mimeType: 'text/plain' });

    expect(res.status).toBe(201);
  });
});

describe('folder listing', () => {
  it('does not leak another user\'s folders', async () => {
    const me = await makeUser();
    const them = await makeUser();
    const { auth } = await login(me);
    const mine = await makeFolder(me, { name: 'mine' });
    await makeFolder(them, { name: 'theirs' });

    const res = await request(app).get('/api/folders').set('Authorization', auth);

    expect(res.status).toBe(200);
    const names = res.body.folders.map((f) => f.name);
    expect(names).toContain('mine');
    expect(names).not.toContain('theirs');
    expect(res.body.folders.every((f) => f.ownerId === me.id || f.id === mine.id)).toBe(true);
  });

  it('excludes trashed files from a folder listing', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await makeFolder(user);
    const live = await makeFile(user, { folderId: folder.id });
    const gone = await makeFile(user, { folderId: folder.id, trashedAt: new Date() });

    const res = await request(app)
      .get(`/api/folders?parentId=${folder.id}`)
      .set('Authorization', auth);

    const ids = res.body.files.map((f) => f.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(gone.id);
    expect(res.body.total).toBe(1);
  });
});

// `ocrText` is a file's ENTIRE extracted text (a whole PDF, or a video's
// transcript) and `embedding` is a 384-float JSON string. Both are index-only:
// searched against server-side, never read by any client code. They ride along
// by default because these routes use `include` with no `select`, so a single
// added relation silently reinstates them — which is why this is pinned rather
// than left to review. Listings are where it hurts: 200 files a page.
describe('list responses omit the index-only columns', () => {
  const OCR = 'the full extracted text of the document';
  const EMBEDDING = JSON.stringify(Array.from({ length: 384 }, () => 0.5));

  async function seed() {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await makeFolder(user);
    const file = await makeFile(user, {
      name: 'indexed.txt',
      folderId: folder.id,
      starred: true,
      ocrText: OCR,
      embedding: EMBEDDING,
    });
    await prisma.file.update({ where: { id: file.id }, data: { accessedAt: new Date() } });
    return { user, auth, folder, file };
  }

  const listings = [
    ['folder listing', (folder) => `/api/folders?parentId=${folder.id}`],
    ['recent', () => '/api/files/recent'],
    ['starred', () => '/api/files/starred'],
    // Matches on the OCR text itself — the row is found BY ocrText and must
    // still not return it.
    ['search', () => `/api/files/search?q=${encodeURIComponent('extracted text')}`],
  ];

  for (const [label, url] of listings) {
    it(`${label} returns neither ocrText nor embedding`, async () => {
      const { auth, folder, file } = await seed();

      const res = await request(app).get(url(folder)).set('Authorization', auth);

      expect(res.status).toBe(200);
      const row = res.body.files.find((f) => f.id === file.id);
      expect(row).toBeDefined(); // the row is still returned…
      expect(row.name).toBe('indexed.txt'); // …with the fields the UI needs…
      expect(row).not.toHaveProperty('ocrText'); // …and without the payload.
      expect(row).not.toHaveProperty('embedding');
    });
  }

  it('a single-file read still carries its own indexed text', async () => {
    const { auth, file } = await seed();

    const res = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.ocrText).toBe(OCR);
  });
});

// I3 — @mentions in comments. The mention token cannot contain '@' (that is
// what ends it), so matching User.email exactly only ever resolved
// username-style accounts; self-registered users all have real addresses.
describe('comment @mentions', () => {
  it('notifies a user mentioned by the local part of their email', async () => {
    const owner = await makeUser();
    const mentioned = await makeUser();
    const { auth } = await login(owner);
    const file = await makeFile(owner);

    const local = mentioned.email.split('@')[0];
    const res = await request(app)
      .post(`/api/files/${file.id}/comments`)
      .set('Authorization', auth)
      .send({ body: `hey @${local} look at this` });
    expect(res.status).toBe(201);

    // notify() is fire-and-forget; give it a tick to land.
    await new Promise((r) => setTimeout(r, 200));
    const n = await prisma.notification.findMany({ where: { userId: mentioned.id } });
    expect(n.some((x) => x.type === 'mention')).toBe(true);
  });

  it('does not notify the commenter for mentioning themselves', async () => {
    const owner = await makeUser();
    const { auth } = await login(owner);
    const file = await makeFile(owner);

    const local = owner.email.split('@')[0];
    await request(app)
      .post(`/api/files/${file.id}/comments`)
      .set('Authorization', auth)
      .send({ body: `note to self @${local}` });

    await new Promise((r) => setTimeout(r, 200));
    const n = await prisma.notification.findMany({ where: { userId: owner.id } });
    expect(n.some((x) => x.type === 'mention')).toBe(false);
  });
});

// Folder grants match by Folder.path prefix, but paths are NOT namespaced per
// owner — two users can each own "/docs". A grant on one user's /docs must not
// leak the identically-named folder (or its files) belonging to someone else.
describe('folder grants are scoped to the granting owner', () => {
  it('does not leak a same-path folder owned by a different user', async () => {
    const granter = await makeUser();
    const victim = await makeUser();
    const grantee = await makeUser();
    const { auth } = await login(grantee);

    // Both owners have a folder at the very same path.
    const shared = await makeFolder(granter, { name: 'docs' });
    const theirs = await makeFolder(victim, { name: 'docs' });
    expect(shared.path).toBe(theirs.path);

    const secret = await makeFile(victim, { folderId: theirs.id });
    const intended = await makeFile(granter, { folderId: shared.id });

    await prisma.folderGrant.create({
      data: { folderId: shared.id, userId: grantee.id, permission: 'view' },
    });

    // The granted file is readable...
    const ok = await request(app).get(`/api/files/${intended.id}`).set('Authorization', auth);
    expect(ok.status).toBe(200);

    // ...the identically-pathed one from another owner is NOT.
    const leak = await request(app).get(`/api/files/${secret.id}`).set('Authorization', auth);
    expect(leak.status).toBe(404);
  });
});

// A public share link on a single file never checked File.trashedAt, so
// trashing a file left its link live: the metadata endpoint kept describing it
// and the download endpoint kept serving the bytes. Folder shares already
// filtered trashed files out of the listing, so this was inconsistent too.
describe('public share links respect the trash', () => {
  it('stops serving a file once it is trashed', async () => {
    const owner = await makeUser();
    const file = await makeFile(owner);
    await prisma.share.create({
      data: { token: 'tok-trash-test', fileId: file.id, ownerId: owner.id },
    });

    // Live file: the link works.
    const before = await request(app).get('/api/shares/public/tok-trash-test');
    expect(before.status).toBe(200);
    expect(before.body.file?.id).toBe(file.id);

    await prisma.file.update({ where: { id: file.id }, data: { trashedAt: new Date() } });

    const after = await request(app).get('/api/shares/public/tok-trash-test');
    expect(after.status).toBe(404);

    const dl = await request(app).post('/api/shares/public/tok-trash-test/download').send({});
    expect(dl.status).toBe(404);
  });
});

// Same cascade hazard the retention sweep guards against, in the manual path.
// Folder.parent is onDelete: Cascade, and restore un-trashes only the ids it is
// handed — so a trashed parent whose child was restored is still sitting in the
// trash, and deleting every trashed folder takes the restored child with it.
// The files under it are worse off than deleted: File.folder is SetNull, so they
// silently relocate to the root, and their bytes are never refunded because they
// were untrashed and so were never in the delete set.
describe('emptying the trash respects restored descendants', () => {
  it('keeps a restored child of a still-trashed parent, and its files', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const parent = await prisma.folder.create({
      data: { name: 'old', path: '/old', ownerId: user.id, trashedAt: new Date() },
    });
    // The child was restored out of the trashed parent, so it is live again.
    const restored = await prisma.folder.create({
      data: { name: 'keep', path: '/old/keep', parentId: parent.id, ownerId: user.id },
    });
    const keptFile = await makeFile(user, { folderId: restored.id, size: 500 });

    const res = await request(app).post('/api/trash/empty').set('Authorization', auth);
    expect(res.status).toBe(200);

    // The restored folder survives, still parented where it was...
    const child = await prisma.folder.findUnique({ where: { id: restored.id } });
    expect(child).not.toBeNull();
    expect(child.parentId).toBe(parent.id);
    // ...and its file is neither deleted nor orphaned to the root.
    const file = await prisma.file.findUnique({ where: { id: keptFile.id } });
    expect(file).not.toBeNull();
    expect(file.folderId).toBe(restored.id);
  });

  it('still deletes a fully trashed subtree', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const now = new Date();

    const parent = await prisma.folder.create({
      data: { name: 'gone', path: '/gone', ownerId: user.id, trashedAt: now },
    });
    const child = await prisma.folder.create({
      data: {
        name: 'sub',
        path: '/gone/sub',
        parentId: parent.id,
        ownerId: user.id,
        trashedAt: now,
      },
    });

    const res = await request(app).post('/api/trash/empty').set('Authorization', auth);
    expect(res.status).toBe(200);

    expect(await prisma.folder.findUnique({ where: { id: parent.id } })).toBeNull();
    expect(await prisma.folder.findUnique({ where: { id: child.id } })).toBeNull();
  });
});
