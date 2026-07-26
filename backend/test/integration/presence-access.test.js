// Integration coverage for the presence room's read-access gate.
//
// A presence room is not a neutral channel: the server broadcasts every member's
// { id, name, email } to every other member. Joining used to be gated on nothing
// but "the socket authenticated" — no check on the file at all — so any logged-in
// user holding a file id could join that file's room and be handed the names and
// email addresses of everyone viewing it, for a file they cannot read.
//
// This needs a real database: the whole point is that the decision runs through
// access.service.js against real File/FolderGrant/GroupMember rows, which is
// exactly what a mocked unit test would paper over.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { WebSocket } from 'ws';

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
  queueIndexFile: vi.fn(() => {}),
  syncVectorColumn: vi.fn(async () => {}),
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, makeFolder, makeFile, login } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');
const { attachPresence } = await import('../../src/realtime/presence.js');

const { createServer } = await import('node:http');

let server;
let port;

beforeAll(async () => {
  migrateTestDb();
  server = createServer(buildApp());
  attachPresence(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
}, 120_000);

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await disconnect();
});

/**
 * Open a presence socket, send a join for `fileId`, and report whether the
 * server put us in the room.
 *
 * A refused join is silent by design (the server simply does not add the socket),
 * so "refused" is observed as the absence of a presence broadcast. A joined room
 * always broadcasts immediately — join() calls broadcast() synchronously — so a
 * short wait distinguishes the two reliably without racing.
 */
function tryJoin(token, fileId, { waitMs = 600 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    let presence = null;
    const done = () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(presence);
    };
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', fileId }));
      setTimeout(done, waitMs);
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'presence' && msg.fileId === fileId) presence = msg;
    });
    ws.on('error', () => resolve(null));
  });
}

describe('presence rooms require read access to the file', () => {
  it('refuses a join on a stranger\'s file', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const file = await makeFile(owner);
    const { token } = await login(stranger);

    // No presence broadcast at all — the stranger never entered the room, so
    // they never learn who else is in it.
    expect(await tryJoin(token, file.id)).toBeNull();
  });

  it('lets the owner join their own file', async () => {
    const owner = await makeUser();
    const file = await makeFile(owner);
    const { token } = await login(owner);

    const presence = await tryJoin(token, file.id);
    expect(presence).toBeTruthy();
    expect(presence.viewers.map((v) => v.id)).toContain(owner.id);
  });

  it('lets a view-only grantee join', async () => {
    // Presence is a read-side feature — a view grant is enough, and a read-only
    // grantee should still see co-viewers.
    const owner = await makeUser();
    const guest = await makeUser();
    const file = await makeFile(owner);
    await prisma.fileGrant.create({
      data: { fileId: file.id, userId: guest.id, permission: 'view' },
    });
    const { token } = await login(guest);

    const presence = await tryJoin(token, file.id);
    expect(presence).toBeTruthy();
    expect(presence.viewers.map((v) => v.id)).toContain(guest.id);
  });

  it('lets a folder grantee join a file inside the granted folder', async () => {
    const owner = await makeUser();
    const guest = await makeUser();
    const folder = await makeFolder(owner, { name: 'shared' });
    const file = await makeFile(owner, { folderId: folder.id });
    await prisma.folderGrant.create({
      data: { folderId: folder.id, userId: guest.id, permission: 'view' },
    });
    const { token } = await login(guest);

    expect(await tryJoin(token, file.id)).toBeTruthy();
  });

  it('lets an admin join any file', async () => {
    // fileAccessLevel returns 'admin' for any file — the handshake therefore has
    // to select `role`, or every admin is evaluated as an ordinary user and
    // refused a room they can plainly open in the UI.
    const owner = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const file = await makeFile(owner);
    const { token } = await login(admin);

    expect(await tryJoin(token, file.id)).toBeTruthy();
  });

  it('refuses a join on a trashed file', async () => {
    const owner = await makeUser();
    const file = await makeFile(owner, { trashedAt: new Date() });
    const { token } = await login(owner);

    expect(await tryJoin(token, file.id)).toBeNull();
  });

  it('refuses a join on a file id that does not exist', async () => {
    const user = await makeUser();
    const { token } = await login(user);

    expect(await tryJoin(token, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('does not broadcast a role field to the room', async () => {
    // `role` is selected for the access check but must not reach the wire —
    // viewersOf() sends ws.user verbatim to every member of the room.
    const owner = await makeUser({ role: 'admin' });
    const file = await makeFile(owner);
    const { token } = await login(owner);

    const presence = await tryJoin(token, file.id);
    expect(presence).toBeTruthy();
    for (const v of presence.viewers) {
      expect(Object.keys(v).sort()).toEqual(['email', 'id', 'name']);
    }
  });
});
