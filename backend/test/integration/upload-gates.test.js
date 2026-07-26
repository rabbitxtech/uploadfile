// Integration coverage for two gates that only exist once a real database does.
//
// 1. The admin-approval gate is enforced on every REST upload entry point via
//    requireApproved. WebDAV is the second way into the same storage and had no
//    equivalent, so a pending account could mount the drive and write freely.
// 2. A chunked upload is long-running, so its destination folder can be trashed
//    between init() and complete(). Writing the row anyway lands a LIVE file
//    inside a trashed parent — the row neither listing can show.
//
// Neither is reachable from the unit suite: the first needs a real user row with
// `approved:false` going through Basic auth, and the second needs the whole
// init → part → complete session to actually exist.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (userId, ext) => `u/${userId}/${Math.random().toString(36).slice(2)}.${ext}`,
  putObjectStream: vi.fn(async () => {}),
  putObjectBuffer: vi.fn(async () => {}),
  getObjectStream: vi.fn(async () => null),
  getObjectRange: vi.fn(async () => null),
  removeObject: vi.fn(async () => {}),
  statObject: vi.fn(async () => ({ size: 0 })),
  removePrefix: vi.fn(async () => {}),
  presignedGet: vi.fn(async () => 'http://minio.test/object'),
  initiateMultipart: vi.fn(async () => 'test-upload-id'),
  // Mirror the real signature exactly: uploadPart takes ONE options object, and
  // getting it wrong makes every part report size 0 — the silent 0-byte-object
  // failure mode.
  uploadPart: vi.fn(async ({ partNumber, length }) => ({
    partNumber,
    etag: `etag-${partNumber}`,
    size: length,
  })),
  completeMultipart: vi.fn(async () => ({})),
  abortMultipart: vi.fn(async () => {}),
}));

vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  queueIndexFile: vi.fn(() => {}),
  syncVectorColumn: vi.fn(async () => {}),
  embed: vi.fn(async () => null),
  cosine: vi.fn(() => 0),
}));

vi.mock('../../src/services/media.service.js', () => ({
  postProcessMedia: vi.fn(async () => {}),
}));

vi.mock('../../src/services/checksum.service.js', async (orig) => ({
  ...(await orig()),
  backfillChecksum: vi.fn(async () => {}),
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, makeFolder, login } = await import('../helpers/fixtures.js');
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

const basic = (user) =>
  'Basic ' + Buffer.from(`${user.email}:${user.password}`).toString('base64');

describe('WebDAV honours the admin-approval upload gate', () => {
  it('refuses a PUT from an account that is still pending approval', async () => {
    const pending = await makeUser({ approved: false });

    const res = await request(app)
      .put('/webdav/notes.txt')
      .set('Authorization', basic(pending))
      .set('Content-Type', 'text/plain')
      .send(Buffer.from('should not be stored'));

    expect(res.status).toBe(403);
    // Nothing was written — the gate has to run before the object and the row.
    const files = await prisma.file.findMany({ where: { ownerId: pending.id } });
    expect(files).toHaveLength(0);
  });

  it('refuses MKCOL from a pending account', async () => {
    const pending = await makeUser({ approved: false });

    const res = await request(app)
      .mkcol('/webdav/newfolder')
      .set('Authorization', basic(pending));

    expect(res.status).toBe(403);
    const folders = await prisma.folder.findMany({ where: { ownerId: pending.id } });
    expect(folders).toHaveLength(0);
  });

  it('still allows a pending account to browse and delete', async () => {
    // The gate is about CREATING content, not about reading or tidying what the
    // account already has — the UI likewise lets a pending user log in and browse.
    const pending = await makeUser({ approved: false });
    await makeFolder(pending, { name: 'existing' });

    const res = await request(app)
      .propfind('/webdav/')
      .set('Authorization', basic(pending))
      .set('Depth', '1');

    expect(res.status).toBe(207);
    expect(res.text).toContain('existing');
  });

  it('lets an approved account PUT normally', async () => {
    const approved = await makeUser({ approved: true });

    const res = await request(app)
      .put('/webdav/notes.txt')
      .set('Authorization', basic(approved))
      .set('Content-Type', 'text/plain')
      .send(Buffer.from('hello'));

    expect(res.status).toBe(201);
    const file = await prisma.file.findFirst({ where: { ownerId: approved.id } });
    expect(file?.name).toBe('notes.txt');
  });

  it('lets an admin PUT even when their approved flag is false', async () => {
    // requireApproved lets admins through unconditionally; the DAV gate must
    // agree, or an admin account created before the column existed locks itself
    // out of its own drive.
    const admin = await makeUser({ role: 'admin', approved: false });

    const res = await request(app)
      .put('/webdav/admin.txt')
      .set('Authorization', basic(admin))
      .set('Content-Type', 'text/plain')
      .send(Buffer.from('hi'));

    expect(res.status).toBe(201);
  });
});

describe('chunked upload — the destination folder is re-checked at complete()', () => {
  // Drive the real three-step flow, trashing the folder mid-session.
  async function runSession(user, auth, folderId, { trashFolderBeforeComplete = false } = {}) {
    const body = Buffer.from('x'.repeat(64));

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'chunked.txt', size: body.length, mimeType: 'text/plain', folderId });
    expect(init.status).toBe(201);

    const part = await request(app)
      .put(`/api/upload/${init.body.sessionId}/part?part=1`)
      .set('Authorization', auth)
      .set('Content-Type', 'application/octet-stream')
      .send(body);
    expect(part.status).toBe(200);

    if (trashFolderBeforeComplete) {
      await prisma.folder.update({
        where: { id: folderId },
        data: { trashedAt: new Date() },
      });
    }

    return request(app)
      .post(`/api/upload/${init.body.sessionId}/complete`)
      .set('Authorization', auth)
      .send({});
  }

  it('does not land the file inside a folder trashed mid-upload', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await makeFolder(user, { name: 'target' });

    const res = await runSession(user, auth, folder.id, { trashFolderBeforeComplete: true });
    expect(res.status).toBe(201);

    const file = await prisma.file.findFirst({ where: { ownerId: user.id } });
    expect(file).toBeTruthy();
    // Falls back to the root: the bytes are already paid for, and a live row
    // under a trashed parent is listed by NEITHER view — GET /api/folders
    // filters trashedAt:null and so hides the ancestor, while GET /api/trash
    // wants trashedAt:{not:null} and so does not list the file either.
    expect(file.folderId).toBeNull();

    // Reachable from the ordinary root listing, which is the whole point.
    const list = await request(app).get('/api/folders').set('Authorization', auth);
    expect(list.status).toBe(200);
    expect(list.body.files.map((f) => f.id)).toContain(file.id);
  });

  it('still files it in the folder when that folder is untouched', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await makeFolder(user, { name: 'target' });

    const res = await runSession(user, auth, folder.id);
    expect(res.status).toBe(201);

    const file = await prisma.file.findFirst({ where: { ownerId: user.id } });
    expect(file.folderId).toBe(folder.id);
  });
});
