// The whisper transcript's `.vtt` sibling is a real File row, and it is the one
// remaining path that creates one without obeying the two rules every other
// upload path in this codebase follows.
//
// 1. QUOTA IS RESERVED, NOT CHECKED-THEN-CHARGED.
//
//    `createVttSibling` read `usedBytes`, compared it to `quotaBytes`, wrote the
//    object, created the row, and only then called `addUsage`. That is exactly
//    the read-modify-write `reserveQuota` exists to replace: the balance it
//    decided against is stale by the time it commits. Transcription is
//    serialised against itself (one whisper job at a time), so the race is not
//    with another transcript — it is with the owner's ordinary uploads, which
//    run concurrently and reserve atomically. The transcript reads the balance
//    before those land and charges after, so the sibling lands on top of a quota
//    that was already full.
//
//    The failure is also unbalanced in the wrong direction: the object is put
//    into MinIO BEFORE the row is created, with no release on the way out, so a
//    failure between the two strands a billed-to-nobody object that nothing
//    reconciles.
//
// 2. A FILE MUST NOT TAKE A LIVE FOLDER'S NAME.
//
//    The sibling's name is derived (`clip.mp4` → `clip.vtt`), so the owner never
//    types it and cannot see the collision coming. It checked only for an
//    existing FILE of that name, never a folder — and a folder shadows a file
//    outright over WebDAV: PROPFIND tries findFolder first and answers
//    <D:collection/>, DELETE takes the folder branch. The transcript is then
//    live, billed against the owner, and neither readable nor deletable there —
//    the same unreachable-row state the trashed-parent gates, the
//    restore-ancestor walk and findFolderNameClash all exist to prevent.
//
// Only reachable against a real database: both rules are enforced by what the
// row lands next to and what the counter says afterwards.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const putObjectBuffer = vi.fn(async () => {});
vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (userId, ext) => `u/${userId}/${Math.random().toString(36).slice(2)}.${ext}`,
  getObjectStream: vi.fn(async () => null),
  putObjectBuffer: (...a) => putObjectBuffer(...a),
  removeObject: vi.fn(async () => {}),
  removePrefix: vi.fn(async () => {}),
}));
vi.mock('../../src/services/ai.service.js', () => ({
  embed: vi.fn(async () => null),
  syncVectorColumn: vi.fn(async () => {}),
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, makeFile, makeFolder } = await import('../helpers/fixtures.js');
const { createVttSibling } = await import('../../src/services/transcribe.service.js');

const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nhello there\n';

beforeAll(() => {
  migrateTestDb();
}, 120_000);

beforeEach(async () => {
  await resetDb();
  putObjectBuffer.mockClear();
});

afterAll(async () => {
  await disconnect();
});

describe('the transcript .vtt sibling', () => {
  it('charges the owner exactly the bytes it stores', async () => {
    const user = await makeUser({ quotaBytes: 100_000n });
    const media = await makeFile(user, { name: 'clip.mp4', mimeType: 'video/mp4', size: 1000 });
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 1000n } });

    await createVttSibling(media, VTT);

    const vtt = await prisma.file.findFirst({ where: { ownerId: user.id, name: 'clip.vtt' } });
    expect(vtt).not.toBeNull();
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(1000n + BigInt(Buffer.byteLength(VTT, 'utf8')));
  });

  it('refuses to push the owner past their quota', async () => {
    // The reservation is what makes this hold: the bound and the increment are
    // one statement, so a balance that moved after the read cannot be
    // overshot.
    const size = BigInt(Buffer.byteLength(VTT, 'utf8'));
    const user = await makeUser({ quotaBytes: 1000n });
    const media = await makeFile(user, { name: 'clip.mp4', mimeType: 'video/mp4', size: 1000 });
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 1000n } });

    await createVttSibling(media, VTT);

    // No row, and the counter untouched — a full quota skips the sibling (the
    // transcript itself still lives in ocrText).
    const vtt = await prisma.file.findFirst({ where: { ownerId: user.id, name: 'clip.vtt' } });
    expect(vtt).toBeNull();
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(1000n);
    expect(size).toBeGreaterThan(0n);
  });

  it('does not land on a live folder of the same name', async () => {
    // The name is derived from the media file, so the owner never chose it and
    // has no way to avoid the clash. A folder shadows the file for every WebDAV
    // verb, leaving it live, billed, unreadable and undeletable there.
    const user = await makeUser({ quotaBytes: 100_000n });
    const folder = await makeFolder(user, { name: 'box' });
    await prisma.folder.create({
      data: { name: 'clip.vtt', path: `${folder.path}/clip.vtt`, parentId: folder.id, ownerId: user.id },
    });
    const media = await makeFile(user, {
      name: 'clip.mp4', mimeType: 'video/mp4', size: 1000, folderId: folder.id,
    });
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 1000n } });

    await createVttSibling(media, VTT);

    const vtt = await prisma.file.findFirst({ where: { ownerId: user.id, name: 'clip.vtt' } });
    expect(vtt).toBeNull();
    // ...and nothing was charged or stored for a row that was never created.
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(1000n);
    expect(putObjectBuffer).not.toHaveBeenCalled();
  });

  it('releases the reservation when the write fails', async () => {
    // The bytes are reserved before anything is stored, so any failure on the
    // way to the File row has to give them back. This runs detached from a
    // request — nobody sees an error and nothing retries — so a leak here is
    // invisible and permanent, and it shrinks the owner's usable quota for good.
    const user = await makeUser({ quotaBytes: 100_000n });
    const media = await makeFile(user, { name: 'clip.mp4', mimeType: 'video/mp4', size: 1000 });
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 1000n } });

    putObjectBuffer.mockRejectedValueOnce(new Error('minio down'));
    await createVttSibling(media, VTT);

    // No row, and the reservation handed back.
    const vtt = await prisma.file.findFirst({ where: { ownerId: user.id, name: 'clip.vtt' } });
    expect(vtt).toBeNull();
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(1000n);
  });

  it('falls back to the root when the media file\'s folder was trashed mid-job', async () => {
    // Transcription is minutes of whisper, and it runs detached: the folder the
    // media file sits in can be trashed from another tab (or by an admin) in
    // between. Writing the sibling into it anyway lands a LIVE file inside a
    // trashed parent — the state both listings are blind to (GET /api/folders
    // filters trashedAt: null and hides the ancestor, GET /api/trash wants
    // trashedAt: { not: null } and does not list the file), so it is live,
    // billed and reachable from neither view with no error anywhere.
    //
    // Root rather than refusal, for the same reason upload/complete falls back:
    // the transcript is done and the bytes are worth keeping, and landing
    // somewhere visible is fixable while landing nowhere is not.
    const user = await makeUser({ quotaBytes: 100_000n });
    const folder = await makeFolder(user, { name: 'box' });
    const media = await makeFile(user, {
      name: 'clip.mp4', mimeType: 'video/mp4', size: 1000, folderId: folder.id,
    });
    await prisma.folder.update({ where: { id: folder.id }, data: { trashedAt: new Date() } });
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 1000n } });

    await createVttSibling(media, VTT);

    const vtt = await prisma.file.findFirst({ where: { ownerId: user.id, name: 'clip.vtt' } });
    expect(vtt).not.toBeNull();
    expect(vtt.folderId).toBeNull();
  });

  it('still skips a sibling that already exists', async () => {
    const user = await makeUser({ quotaBytes: 100_000n });
    const media = await makeFile(user, { name: 'clip.mp4', mimeType: 'video/mp4', size: 1000 });
    await makeFile(user, { name: 'clip.vtt', mimeType: 'text/vtt', size: 10 });
    const before = await prisma.user.findUnique({ where: { id: user.id } });

    await createVttSibling(media, VTT);

    const all = await prisma.file.findMany({ where: { ownerId: user.id, name: 'clip.vtt' } });
    expect(all).toHaveLength(1);
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(before.usedBytes);
  });
});
