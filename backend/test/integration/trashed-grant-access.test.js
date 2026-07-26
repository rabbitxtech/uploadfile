// Trashing a shared item must REVOKE the access a grant gives, on the read side.
//
// Trashing is the user's "un-share it" action, and the rest of the codebase
// already treats it that way from both ends:
//
//   - a public share link 404s the moment its target is trashed
//     (assertShareTargetLive in shares.routes.js), and
//   - GET /api/grants/shared-with-me filters trashed rows out, so the item
//     vanishes from the grantee's "Shared with me" list as soon as the owner
//     deletes it.
//
// Nothing enforced it on the file/folder routes themselves, so the ACCESS simply
// outlived the LISTING. A grantee who still had the id — ids travel in links and
// pasted URLs, so keeping one takes no attack — could go on calling:
//
//   GET /api/files/:id           → 200, the whole row INCLUDING ocrText, which is
//                                  the file's entire extracted text (a full PDF,
//                                  a video transcript)
//   GET /api/files/:id/download  → 200, the real bytes
//   GET /api/files/:id/preview   → 200, the real bytes
//   GET /api/files/:id/url       → 200, a presigned MinIO URL for the object
//   GET /api/folders/:id/breadcrumb → 200, the deleted folder's NAME
//
// ...while the owner watched the file sit in their trash, with every reason to
// believe deleting it had stopped the sharing.
//
// The gate lives in access.service.js (fileAccessLevel / folderAccessLevel),
// below the owner/admin returns and above the grant lookups, so it restricts
// only what a GRANT reaches. The OWNER deliberately keeps full access to their
// own trashed items — the Trash page reads the row to list it, and
// restore-then-download is the ordinary flow — and so does an admin. That
// asymmetry is the whole point of the fix, so it is asserted here too: a gate
// that also locked the owner out would break the trash view instead.
//
// Needs a real database: these are where-clause/branch changes, so they either
// filter the row or they don't.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (u, e) => `u/${u}/${Math.random().toString(36).slice(2)}.${e}`,
  putObjectStream: vi.fn(async () => {}),
  putObjectBuffer: vi.fn(async () => {}),
  // A real stream: the point of the download/preview cases is that the BYTES
  // came back, so a null-returning stub would "pass" against the unfixed code.
  getObjectStream: vi.fn(async () => {
    const { Readable } = await import('node:stream');
    return Readable.from([Buffer.from('SECRET-BYTES')]);
  }),
  getObjectRange: vi.fn(async () => null),
  removeObject: vi.fn(async () => {}),
  statObject: vi.fn(async () => ({ size: 0 })),
  removePrefix: vi.fn(async () => {}),
  presignedGet: vi.fn(async () => 'http://minio.test/SIGNED-URL'),
}));
vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  queueIndexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, login, makeFile, makeFolder } = await import('../helpers/fixtures.js');
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

const trash = (id) =>
  prisma.file.update({ where: { id }, data: { trashedAt: new Date() } });

describe('a file grant dies with the file', () => {
  it('closes every read route for the grantee once the file is trashed', async () => {
    const owner = await makeUser();
    const grantee = await makeUser();
    const { auth } = await login(grantee);
    const file = await makeFile(owner, { name: 'secret.txt', ocrText: 'CONFIDENTIAL' });
    await prisma.fileGrant.create({
      data: { fileId: file.id, userId: grantee.id, permission: 'view' },
    });

    // While it is live the grant works — otherwise the assertions below would
    // pass against a grant that never resolved in the first place.
    const live = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(live.status).toBe(200);

    await trash(file.id);

    for (const path of ['', '/download', '/preview', '/url', '/stream-token', '/progress', '/comments']) {
      const res = await request(app)
        .get(`/api/files/${file.id}${path}`)
        .set('Authorization', auth);
      expect(res.status, `GET /api/files/:id${path}`).toBe(404);
    }
  });

  it('does not hand the grantee the bytes or a presigned URL', async () => {
    const owner = await makeUser();
    const grantee = await makeUser();
    const { auth } = await login(grantee);
    const file = await makeFile(owner, { name: 'bytes.txt' });
    await prisma.fileGrant.create({
      data: { fileId: file.id, userId: grantee.id, permission: 'view' },
    });
    await trash(file.id);

    const dl = await request(app).get(`/api/files/${file.id}/download`).set('Authorization', auth);
    expect(dl.text).not.toContain('SECRET-BYTES');

    const url = await request(app).get(`/api/files/${file.id}/url`).set('Authorization', auth);
    expect(url.body.url).toBeUndefined();
  });

  it('revokes a GROUP grant too — group access resolves through the same helper', async () => {
    const owner = await makeUser();
    const member = await makeUser();
    const { auth } = await login(member);
    const group = await prisma.group.create({ data: { name: `team-${Date.now()}` } });
    await prisma.groupMember.create({ data: { groupId: group.id, userId: member.id } });
    const file = await makeFile(owner, { name: 'team.txt' });
    await prisma.fileGrant.create({
      data: { fileId: file.id, groupId: group.id, permission: 'view' },
    });

    const live = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(live.status).toBe(200);

    await trash(file.id);
    const dead = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(dead.status).toBe(404);
  });

  it('still lets the OWNER read their own trashed file (the Trash page needs it)', async () => {
    const owner = await makeUser();
    const { auth } = await login(owner);
    const file = await makeFile(owner, { name: 'mine.txt', trashedAt: new Date() });

    const get = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(get.status).toBe(200);
    const dl = await request(app).get(`/api/files/${file.id}/download`).set('Authorization', auth);
    expect(dl.status).toBe(200);
  });

  it('still lets an ADMIN read another user’s trashed file', async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const file = await makeFile(owner, { name: 'theirs.txt', trashedAt: new Date() });

    const get = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(get.status).toBe(200);
  });
});

describe('a folder grant dies with the folder', () => {
  it('stops the breadcrumb disclosing a trashed folder’s name', async () => {
    const owner = await makeUser();
    const grantee = await makeUser();
    const { auth } = await login(grantee);
    const parent = await makeFolder(owner, { name: 'CONFIDENTIAL-PARENT' });
    const folder = await makeFolder(owner, { name: 'granted-child', parentId: parent.id });
    await prisma.folderGrant.create({
      data: { folderId: folder.id, userId: grantee.id, permission: 'view' },
    });

    const live = await request(app)
      .get(`/api/folders/${folder.id}/breadcrumb`)
      .set('Authorization', auth);
    expect(live.status).toBe(200);

    await prisma.folder.update({ where: { id: folder.id }, data: { trashedAt: new Date() } });

    const dead = await request(app)
      .get(`/api/folders/${folder.id}/breadcrumb`)
      .set('Authorization', auth);
    expect(dead.status).toBe(403);
    expect(JSON.stringify(dead.body)).not.toContain('CONFIDENTIAL-PARENT');
  });

  it('stops a grant on a trashed folder reaching the files inside it', async () => {
    const owner = await makeUser();
    const grantee = await makeUser();
    const { auth } = await login(grantee);
    const folder = await makeFolder(owner, { name: 'shared-folder' });
    // The file itself stays live: trashing a folder normally stamps its files
    // too, but restore un-trashes only the ids it is handed, so the two can
    // diverge — and it is the GRANT that must stop reaching, on its own.
    const file = await makeFile(owner, { name: 'inside.txt', folderId: folder.id });
    await prisma.folderGrant.create({
      data: { folderId: folder.id, userId: grantee.id, permission: 'view' },
    });

    const live = await request(app).get(`/api/files/${file.id}/url`).set('Authorization', auth);
    expect(live.status).toBe(200);

    await prisma.folder.update({ where: { id: folder.id }, data: { trashedAt: new Date() } });

    const dead = await request(app).get(`/api/files/${file.id}/url`).set('Authorization', auth);
    expect(dead.status).toBe(404);
  });

  it('still lets the owner browse their own folder after trashing it elsewhere', async () => {
    // The owner branch never consults a grant, so trashing must not affect it.
    const owner = await makeUser();
    const { auth } = await login(owner);
    const folder = await makeFolder(owner, { name: 'own' });

    const res = await request(app)
      .get(`/api/folders/${folder.id}/breadcrumb`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
  });
});
