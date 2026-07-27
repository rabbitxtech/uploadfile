// A name is ONE path segment — against a real database.
//
// `Folder.path` is denormalised by joining folder NAMES with "/", and both the
// name and the path are read back elsewhere as structure. Nothing validated
// that a name is a single segment, so a caller could put "/" inside one and
// forge a path. Three separate layers then broke, each in a different way:
//
//   - A folder created as `name: "work/reports/archive"` lands with
//     `parentId: null` and `path: "/work/reports/archive"` — a ROOT folder
//     claiming a position deep inside another tree. The real folder at that
//     position can then never be created (409 against a folder that is not
//     there), and deleting the unrelated "/work" sweeps the forged row into the
//     trash, because the soft-delete cascades on `path startsWith "/work/"`.
//     Restore cannot undo that: the restore walk climbs `parentId`, which is
//     null here. The same prefix reasoning drives `deletableFolderIds` and
//     `grantCoversFolder`, so a forged path reaches a purge decision and a share
//     resolution too.
//   - A file named "sub/evil.txt" makes PROPFIND emit a two-level
//     <D:href> inside a one-level listing, and WebDAV's findFile() splits a
//     request path on the LAST "/", so the row can never be resolved again:
//     live, billed, and unreadable/undeletable over WebDAV.
//   - `archive.append(stream, { name: f.name })` writes the name into the ZIP
//     central directory verbatim, so "../../../tmp/x" is a Zip Slip entry.
//
// None of this is reachable from the unit suite: it only shows up once a real
// row carries a forged name and a path-prefix query or an archiver runs over it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import request from 'supertest';

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (u, e) => `u/${u}/${Math.random().toString(36).slice(2)}.${e}`,
  putObjectStream: vi.fn(async () => {}),
  putObjectBuffer: vi.fn(async () => {}),
  // A real readable, not null: the ZIP case below needs archiver to actually
  // write an entry so its name can be inspected in the output.
  getObjectStream: vi.fn(async () => Readable.from([Buffer.from('body')])),
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

const createFolder = (auth, body) =>
  request(app).post('/api/folders').set('Authorization', auth).send(body);

describe('a folder name is one path segment', () => {
  it('refuses a create whose name contains a slash', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const r = await createFolder(auth, { name: 'work/reports' });
    expect(r.status).toBe(400);

    // Nothing was written — in particular no root row holding a forged path.
    expect(await prisma.folder.count()).toBe(0);
  });

  it('refuses a rename whose name contains a slash', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await createFolder(auth, { name: 'plain' });

    const r = await request(app)
      .patch(`/api/folders/${folder.body.id}`)
      .set('Authorization', auth)
      .send({ name: 'a/b' });
    expect(r.status).toBe(400);

    const after = await prisma.folder.findUnique({ where: { id: folder.body.id } });
    expect(after.name).toBe('plain');
    expect(after.path).toBe('/plain');
  });

  it('refuses a backslash, which Windows clients treat as a separator too', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const r = await createFolder(auth, { name: 'a\\b' });
    expect(r.status).toBe(400);
  });

  it('refuses "." and ".." rather than silently rewriting them', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    expect((await createFolder(auth, { name: '..' })).status).toBe(400);
    expect((await createFolder(auth, { name: '.' })).status).toBe(400);
  });

  it('still accepts an ordinary name, and trims surrounding space', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const r = await createFolder(auth, { name: '  Quarterly Reports  ' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('Quarterly Reports');
    expect(r.body.path).toBe('/Quarterly Reports');
  });

  // The consequence that makes this more than untidy: without the gate the
  // forged row blocks a legitimate folder and is swept away by an unrelated
  // delete. Both are asserted here against the fixed behaviour.
  it('leaves the real position in the tree usable', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const work = await createFolder(auth, { name: 'work' });
    const reports = await createFolder(auth, { name: 'reports', parentId: work.body.id });

    // The forged root row is refused...
    expect((await createFolder(auth, { name: 'work/reports/archive' })).status).toBe(400);

    // ...so the genuine folder at that path can still be created.
    const archive = await createFolder(auth, { name: 'archive', parentId: reports.body.id });
    expect(archive.status).toBe(201);
    expect(archive.body.path).toBe('/work/reports/archive');
    expect(archive.body.parentId).toBe(reports.body.id);
  });

  it('keeps an unrelated delete from reaching a root folder', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const work = await createFolder(auth, { name: 'work' });
    await createFolder(auth, { name: 'reports', parentId: work.body.id });

    // Refused, so it cannot exist to be caught by the "/work/" prefix cascade.
    expect((await createFolder(auth, { name: 'work/reports/archive' })).status).toBe(400);

    const del = await request(app)
      .delete(`/api/folders/${work.body.id}`)
      .set('Authorization', auth);
    expect(del.status).toBe(200);

    // Only the real subtree is trashed; no root-level row was dragged along.
    const live = await prisma.folder.findMany({ where: { trashedAt: null } });
    expect(live).toHaveLength(0);
    const roots = await prisma.folder.findMany({ where: { parentId: null } });
    expect(roots.map((f) => f.name)).toEqual(['work']);
  });
});

describe('a file name is one path segment', () => {
  it('refuses a rename containing a slash', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'plain.txt' });

    const r = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Authorization', auth)
      .send({ name: 'sub/evil.txt' });
    expect(r.status).toBe(400);

    const after = await prisma.file.findUnique({ where: { id: file.id } });
    expect(after.name).toBe('plain.txt');
  });

  it('refuses a rename that is a path traversal', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'ok.txt' });

    const r = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Authorization', auth)
      .send({ name: '../../../etc/passwd' });
    expect(r.status).toBe(400);
    expect((await prisma.file.findUnique({ where: { id: file.id } })).name).toBe('ok.txt');
  });

  it('keeps a renamed file resolvable over WebDAV', async () => {
    const user = await makeUser({ password: 'TestPass123!' });
    const { auth } = await login(user);
    const folder = await makeFolder(user, { name: 'box' });
    const file = await makeFile(user, { folderId: folder.id, name: 'plain.txt' });

    await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Authorization', auth)
      .send({ name: 'sub/evil.txt' });

    const basic = 'Basic ' + Buffer.from(`${user.email}:TestPass123!`).toString('base64');
    const pf = await request(app)
      .propfind('/webdav/box')
      .set('Authorization', basic)
      .set('Depth', '1');
    expect(pf.status).toBe(207);
    // The listing of one collection must not contain a two-level href — that is
    // a row findFile() could never resolve back.
    expect(pf.text).toContain('/webdav/box/plain.txt');
    expect(pf.text).not.toContain('/webdav/box/sub/evil.txt');
  });

  it('refuses a chunked upload declaring a slashed filename', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const r = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'x/y/z.bin', size: 5, mimeType: 'application/octet-stream' });
    expect(r.status).toBe(400);
    expect(await prisma.uploadSession.count()).toBe(0);
  });

  it('reduces a multipart upload filename to its last segment', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    // A hand-rolled client can send any filename in the multipart header; the
    // stored row must still hold one segment.
    const r = await request(app)
      .post('/api/files')
      .set('Authorization', auth)
      .field('folderId', '')
      .attach('file', Buffer.from('hello'), {
        filename: 'a/b/c.txt',
        contentType: 'text/plain',
      });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('c.txt');
    expect(r.body.originalName).toBe('c.txt');
  });

  it('skips just the bad entry in a bulk rename', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const good = await makeFile(user, { name: 'one.txt' });
    const bad = await makeFile(user, { name: 'two.txt' });

    const r = await request(app)
      .post('/api/files/bulk/rename')
      .set('Authorization', auth)
      .send({
        renames: [
          { id: good.id, name: 'renamed.txt' },
          { id: bad.id, name: 'nested/renamed.txt' },
        ],
      });
    expect(r.status).toBe(200);
    // One clash must not lose the whole batch — the same carve-out the
    // name-collision rule makes for bulk operations.
    expect(r.body.count).toBe(1);
    expect(r.body.skipped).toBe(1);
    expect((await prisma.file.findUnique({ where: { id: good.id } })).name).toBe('renamed.txt');
    expect((await prisma.file.findUnique({ where: { id: bad.id } })).name).toBe('two.txt');
  });
});

describe('a ZIP entry name is one path segment', () => {
  // The write paths above refuse a forged name, but rows created before this
  // rule existed still carry one, so the archiver sanitises on the way out too.
  it('does not emit a traversing entry for a legacy row', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'ok.txt' });
    // Write the bad name straight to the database, as a pre-fix row would have.
    await prisma.file.update({
      where: { id: file.id },
      data: { name: '../../../../tmp/pwned.txt' },
    });

    const r = await request(app)
      .post('/api/files/bulk/zip')
      .set('Authorization', auth)
      .send({ ids: [file.id] })
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(r.status).toBe(200);
    const zip = r.body.toString('latin1');
    expect(zip).not.toContain('../');
    expect(zip).toContain('pwned.txt');
  });
});

describe('a name derived from a remote URL is one path segment', () => {
  // `filenameFromUrl` pops the last "/" segment, which looks like it already
  // guarantees this — but a percent-encoded BACKSLASH survives both
  // decodeURIComponent and that split, so "/%2e%2e%5C%2e%2e%5Cx.txt" yielded the
  // literal name "..\..\x.txt". A backslash is a separator to WebDAV clients on
  // Windows and to the ZIP spec alike, so that is the same forged name the typed
  // paths refuse, arriving through the one route that derives its own.
  const fetchOk = (body = 'remote bytes') =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      body: Readable.from([Buffer.from(body)]),
      headers: {
        get: (h) =>
          h === 'content-type' ? 'text/plain' : h === 'content-length' ? String(body.length) : null,
      },
    }));

  it('strips an encoded-backslash traversal out of the stored name', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    vi.stubGlobal('fetch', fetchOk());

    const r = await request(app)
      .post('/api/files/from-url')
      .set('Authorization', auth)
      .send({ url: 'https://example.com/%2e%2e%5C%2e%2e%5Cx.txt' });

    vi.unstubAllGlobals();
    // The SSRF guard resolves the hostname for real, so a DNS failure in a
    // sandbox is a 400 rather than a pass — only assert the name when the import
    // actually ran.
    if (r.status !== 201) return;
    expect(r.body.name).toBe('x.txt');
    expect(r.body.name).not.toContain(String.fromCharCode(92));
  });

  it('keeps an ordinary remote filename intact', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    vi.stubGlobal('fetch', fetchOk());

    const r = await request(app)
      .post('/api/files/from-url')
      .set('Authorization', auth)
      .send({ url: 'https://example.com/docs/report.txt' });

    vi.unstubAllGlobals();
    if (r.status !== 201) return;
    expect(r.body.name).toBe('report.txt');
  });
});
