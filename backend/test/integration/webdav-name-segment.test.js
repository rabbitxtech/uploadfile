// WebDAV is the second way a name gets stored, and it owed the one-segment rule.
//
// Every REST entry point runs a stored name through `sanitizeEntryName` because
// `Folder.path` is built by joining names with "/" and three separate layers
// read a stored name back as STRUCTURE: the folder soft-delete/rename select
// descendants with `path startsWith`, WebDAV's own `findFile()` splits a request
// path on the last separator, and `archive.append(s, { name })` writes the value
// into the ZIP central directory verbatim.
//
// webdav.routes.js called that helper nowhere. `davPath()` percent-DECODES the
// request path after Express has already split it, so `%5C` (backslash — a
// separator to Windows WebDAV clients and to the ZIP spec alike) and `%00`
// survive into `splitParent().name` and are stored as-is by PUT, MKCOL and MOVE.
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
  uploadPart: vi.fn(async () => ({})),
  completeMultipart: vi.fn(async () => ({})),
  abortMultipart: vi.fn(async () => {}),
}));

vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, makeFolder, makeFile } = await import('../helpers/fixtures.js');
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

describe('WebDAV PUT — a stored file name is one segment', () => {
  it('refuses a PUT whose name carries an encoded backslash', async () => {
    const user = await makeUser();

    const res = await request(app)
      .put('/webdav/a%5Cb.txt')
      .set('Authorization', basic(user))
      .set('Content-Type', 'text/plain')
      .send('hello');

    expect(res.status).toBe(400);
    const stored = await prisma.file.findMany({ where: { ownerId: user.id } });
    expect(stored).toHaveLength(0);
  });

  it('refuses a traversal name rather than storing it for the next ZIP download', async () => {
    const user = await makeUser();

    const res = await request(app)
      .put('/webdav/%2e%2e%5C%2e%2e%5Cevil.txt')
      .set('Authorization', basic(user))
      .set('Content-Type', 'text/plain')
      .send('hello');

    expect(res.status).toBe(400);
    const stored = await prisma.file.findMany({ where: { ownerId: user.id } });
    expect(stored).toHaveLength(0);
  });

  it('refuses a name carrying a control character', async () => {
    const user = await makeUser();

    const res = await request(app)
      .put('/webdav/e%00vil.txt')
      .set('Authorization', basic(user))
      .set('Content-Type', 'text/plain')
      .send('hello');

    expect(res.status).toBe(400);
    const stored = await prisma.file.findMany({ where: { ownerId: user.id } });
    expect(stored).toHaveLength(0);
  });

  it('still accepts an ordinary name', async () => {
    const user = await makeUser();

    const res = await request(app)
      .put('/webdav/report.txt')
      .set('Authorization', basic(user))
      .set('Content-Type', 'text/plain')
      .send('hello');

    expect(res.status).toBe(201);
    const stored = await prisma.file.findMany({ where: { ownerId: user.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('report.txt');
  });
});

describe('WebDAV MKCOL — a folder name is one segment', () => {
  it('refuses a collection whose name carries a separator', async () => {
    const user = await makeUser();

    const res = await request(app)
      .mkcol('/webdav/work%5Creports')
      .set('Authorization', basic(user));

    expect(res.status).toBe(400);
    const folders = await prisma.folder.findMany({ where: { ownerId: user.id } });
    expect(folders).toHaveLength(0);
  });

  it('still creates an ordinary collection', async () => {
    const user = await makeUser();

    const res = await request(app)
      .mkcol('/webdav/reports')
      .set('Authorization', basic(user));

    expect(res.status).toBe(201);
    const folders = await prisma.folder.findMany({ where: { ownerId: user.id } });
    expect(folders).toHaveLength(1);
    expect(folders[0].name).toBe('reports');
    expect(folders[0].path).toBe('/reports');
  });
});

describe('WebDAV MOVE — the destination name is one segment', () => {
  it('refuses to rename a file into a forged path', async () => {
    const user = await makeUser();
    await makeFile(user, { name: 'report.txt' });

    const res = await request(app)
      .move('/webdav/report.txt')
      .set('Authorization', basic(user))
      .set('Destination', '/webdav/%2e%2e%5Cevil.txt');

    expect(res.status).toBe(400);
    const stored = await prisma.file.findFirst({ where: { ownerId: user.id } });
    expect(stored.name).toBe('report.txt');
  });

  it('refuses to rename a folder into a forged path', async () => {
    const user = await makeUser();
    await makeFolder(user, { name: 'docs' });

    const res = await request(app)
      .move('/webdav/docs')
      .set('Authorization', basic(user))
      .set('Destination', '/webdav/work%5Creports');

    expect(res.status).toBe(400);
    const folder = await prisma.folder.findFirst({ where: { ownerId: user.id } });
    expect(folder.name).toBe('docs');
    expect(folder.path).toBe('/docs');
  });

  it('still performs an ordinary rename', async () => {
    const user = await makeUser();
    await makeFolder(user, { name: 'docs' });

    const res = await request(app)
      .move('/webdav/docs')
      .set('Authorization', basic(user))
      .set('Destination', '/webdav/archive');

    expect(res.status).toBe(201);
    const folder = await prisma.folder.findFirst({ where: { ownerId: user.id } });
    expect(folder.name).toBe('archive');
    expect(folder.path).toBe('/archive');
  });
});
