// J3 — Minimal WebDAV endpoint mounted at /webdav. Exposes a user's folders and
// files over WebDAV so they can be mounted in Finder/Explorer or via rclone.
// Auth is HTTP Basic (username/email + account password). Operations are scoped
// to the authenticated user and reuse the same MinIO + Prisma model as the API.
import express from 'express';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import {
  getObjectStream,
  putObjectStream,
  objectKeyFor,
  removeObject,
} from '../services/storage.service.js';
import { netCost, subUsage, reserveQuota, releaseQuota } from '../services/quota.service.js';
import { sha256Buffer } from '../services/checksum.service.js';
import { removeHls } from '../services/hls.service.js';
import { prisma } from '../config/prisma.js';
import { findUserByCredential } from '../utils/credential.js';
import { findFileNameClash, findFolderNameClash, sanitizeEntryName } from '../utils/namecollision.js';

const router = Router();
const BUCKET = process.env.MINIO_BUCKET || 'uploads';

// Buffer the (raw) body for PUT; PROPFIND/PROPPATCH XML bodies are ignored.
router.use(express.raw({ type: () => true, limit: '512mb' }));

// OPTIONS is answered without auth so clients can discover DAV capabilities.
router.options('*', (req, res) => {
  res.set({
    DAV: '1, 2',
    'MS-Author-Via': 'DAV',
    Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK',
  });
  res.status(200).end();
});

// ---- Basic auth ----
router.use(async (req, res, next) => {
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Uploader WebDAV"');
    return res.status(401).end('Authentication required');
  }
  try {
    const [user, pass] = Buffer.from(hdr.slice(6), 'base64').toString('utf8').split(':');
    // Same credential rule as the REST login: self-registration stores the
    // address lowercased, so matching only the raw input locked those users out
    // of mounting their own drive with the address they signed up with.
    const u = await findUserByCredential(user);
    if (!u || u.banned || !(await bcrypt.compare(pass || '', u.password))) {
      res.set('WWW-Authenticate', 'Basic realm="Uploader WebDAV"');
      return res.status(401).end('Invalid credentials');
    }
    req.davUser = u;
    next();
  } catch {
    res.set('WWW-Authenticate', 'Basic realm="Uploader WebDAV"');
    res.status(401).end('Invalid credentials');
  }
});

/**
 * WebDAV is the second way into every upload path, and it owes the same
 * admin-approval gate the REST side enforces.
 *
 * `requireApproved` sits on every REST entry point that creates content —
 * POST /api/files, /from-url, /from-youtube, /:id/versions, /collab-save and
 * POST /api/upload/init — because a self-registered user is `approved: false`
 * until an admin flips it, and the whole point of that gate is that verifying an
 * email is NOT enough to start storing bytes. This router had no equivalent, so
 * the gate was one `davfs2`/Finder/rclone mount away from being irrelevant:
 * the same account that gets 403 from the upload UI could PUT unlimited files
 * (up to its quota) and MKCOL folders straight into its tree, and they show up
 * in the normal listing as ordinary uploads.
 *
 * Applied to the write verbs only. PROPFIND/GET/HEAD stay open to a pending
 * user for the same reason the UI lets them log in and browse: the gate is about
 * creating content, not about reading what they already have. DELETE and MOVE
 * are likewise not creation — a pending user must still be able to tidy up.
 *
 * 403 mirrors what requireApproved returns on the REST side; WebDAV clients
 * surface it as a permission error, which is the honest description.
 */
const DAV_CREATE_METHODS = new Set(['PUT', 'MKCOL', 'COPY']);
router.use((req, res, next) => {
  if (!DAV_CREATE_METHODS.has(req.method)) return next();
  if (req.davUser.role === 'admin' || req.davUser.approved) return next();
  return res
    .status(403)
    .end('Your account is pending administrator approval before you can upload files.');
});

// ---- path helpers ----
function davPath(req) {
  // req.path is the part after the /webdav mount. Decode + strip trailing slash.
  let p = decodeURIComponent(req.path || '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}
function splitParent(p) {
  if (p === '/' || p === '') return { parentPath: '/', name: '' };
  const i = p.lastIndexOf('/');
  return { parentPath: i <= 0 ? '/' : p.slice(0, i), name: p.slice(i + 1) };
}
async function findFolder(ownerId, path) {
  if (path === '/' || path === '') return null; // root sentinel
  return prisma.folder.findFirst({ where: { ownerId, path, trashedAt: null } });
}
async function findFile(ownerId, path) {
  const { parentPath, name } = splitParent(path);
  if (!name) return null;
  const parent = await findFolder(ownerId, parentPath);
  if (parentPath !== '/' && !parent) return null;
  return prisma.file.findFirst({
    where: { ownerId, folderId: parent?.id ?? null, name, trashedAt: null },
  });
}

/**
 * A name this router is about to STORE is one path segment, exactly as it is on
 * every REST entry point.
 *
 * WebDAV was the one writer that never went through `sanitizeEntryName`, and the
 * reason it is reachable is `davPath()`: it percent-DECODES the request path
 * *after* Express has already split the URL, so a `%5C` or `%00` never looks
 * like a separator to the router and arrives intact in `splitParent().name`.
 * `/webdav/a%5Cb.txt` stored the literal name "a\b.txt", and
 * `/webdav/%2e%2e%5Cevil.txt` stored "..\evil.txt".
 *
 * Backslash is a separator here for the same reason sanitizeEntryName treats it
 * as one: Windows WebDAV clients and the ZIP spec both read it that way. All
 * three consumers of a stored name then misread it — `findFile()` splits a
 * request path on the last separator and so can never resolve the row again
 * (live, billed, unreadable and undeletable over the very protocol that made
 * it), `Folder.path` joins names with "/" so a MKCOL'd separator forges a path
 * into another subtree, and `archive.append(s, { name })` writes it into the ZIP
 * central directory verbatim as a Zip Slip entry. A NUL is worse than any of
 * them: it is not valid UTF-8 for PostgreSQL, so it surfaced as a raw 500 out of
 * whichever query touched the name first.
 *
 * `'reject'`, not `'strip'`: a WebDAV path IS the user's instruction about where
 * the resource goes, so quietly storing a different name would carry out a
 * different one — the same reasoning that makes the folder create/rename and
 * `upload/init` reject. 400 is the honest answer, and clients surface it.
 */
function davName(res, raw, label) {
  try {
    return sanitizeEntryName(raw, { label });
  } catch {
    res.status(400).end(`Invalid ${label}: a name must be a single path segment`);
    return null;
  }
}

const xmlEscape = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const href = (p) =>
  '/webdav' + p.split('/').map((seg) => (seg ? encodeURIComponent(seg) : seg)).join('/');

function responseXml({ path, isCollection, size, mtime, ctype }) {
  const rt = isCollection ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>';
  const len = isCollection ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`;
  const ct = isCollection ? '' : `<D:getcontenttype>${xmlEscape(ctype || 'application/octet-stream')}</D:getcontenttype>`;
  const lm = mtime ? new Date(mtime).toUTCString() : new Date().toUTCString();
  return `<D:response><D:href>${xmlEscape(href(path))}${isCollection && path !== '/' ? '/' : ''}</D:href>` +
    `<D:propstat><D:prop>` +
    `<D:displayname>${xmlEscape(path === '/' ? '' : splitParent(path).name)}</D:displayname>` +
    rt + len + ct +
    `<D:getlastmodified>${lm}</D:getlastmodified>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

// ---- PROPFIND (list) ----
router.all('*', async (req, res, next) => {
  if (req.method !== 'PROPFIND') return next();
  const owner = req.davUser.id;
  const p = davPath(req);
  const depth = req.headers.depth ?? '1';

  // Is it a folder/root or a file?
  const folder = p === '/' ? null : await findFolder(owner, p);
  const isRoot = p === '/';
  if (!isRoot && !folder) {
    const file = await findFile(owner, p);
    if (!file) return res.status(404).end();
    res.set('Content-Type', 'application/xml; charset=utf-8');
    return res
      .status(207)
      .end(
        `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">` +
          responseXml({ path: p, isCollection: false, size: file.size.toString(), mtime: file.updatedAt, ctype: file.mimeType }) +
          `</D:multistatus>`,
      );
  }

  // Collection
  const parts = [responseXml({ path: p, isCollection: true, mtime: folder?.updatedAt })];
  if (String(depth) !== '0') {
    const folders = await prisma.folder.findMany({
      where: { ownerId: owner, parentId: folder?.id ?? null, trashedAt: null },
      select: { name: true, path: true, updatedAt: true },
    });
    const files = await prisma.file.findMany({
      where: { ownerId: owner, folderId: folder?.id ?? null, trashedAt: null },
      select: { name: true, size: true, mimeType: true, updatedAt: true },
    });
    for (const f of folders) parts.push(responseXml({ path: f.path, isCollection: true, mtime: f.updatedAt }));
    for (const f of files) {
      const childPath = p === '/' ? `/${f.name}` : `${p}/${f.name}`;
      parts.push(responseXml({ path: childPath, isCollection: false, size: f.size.toString(), mtime: f.updatedAt, ctype: f.mimeType }));
    }
  }
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res
    .status(207)
    .end(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${parts.join('')}</D:multistatus>`);
});

// ---- GET / HEAD ----
router.all('*', async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const file = await findFile(req.davUser.id, davPath(req));
  if (!file) return res.status(404).end();
  res.set('Content-Type', file.mimeType);
  res.set('Content-Length', file.size.toString());
  if (req.method === 'HEAD') return res.status(200).end();
  try {
    const stream = await getObjectStream(file.objectKey);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    res.status(500).end();
  }
});

// ---- PUT (upload / overwrite) ----
router.put('*', async (req, res) => {
  const owner = req.davUser.id;
  const p = davPath(req);
  const { parentPath, name: rawName } = splitParent(p);
  if (!rawName) return res.status(400).end();
  // One segment before anything is stored or charged — see davName.
  const name = davName(res, rawName, 'filename');
  if (name === null) return;
  const parent = await findFolder(owner, parentPath);
  if (parentPath !== '/' && !parent) return res.status(409).end('Parent collection missing');

  // A PUT onto a path a FOLDER already occupies used to succeed: it created a
  // File row, charged the quota and returned 201, but the client could never
  // read it back — PROPFIND and GET both resolve the folder first, so the bytes
  // it just uploaded were live, billed and invisible. The root listing showed
  // the name twice (`/webdav/docs/` and `/webdav/docs`), and a second PUT to the
  // same path did not even find the row to overwrite, so every write leaked
  // another charged object. 409 is the RFC 4918 answer for a path whose
  // namespace cannot accept this resource.
  if (await findFolderNameClash(owner, parent?.id ?? null, name)) {
    return res.status(409).end('A collection already exists at that path');
  }

  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const size = body.length;
  const existing = await prisma.file.findFirst({
    where: { ownerId: owner, folderId: parent?.id ?? null, name, trashedAt: null },
    include: { versions: { select: { size: true, objectKey: true, version: true } } },
  });

  // What the overwrite refunds is the sum of the file's versions, not File.size
  // (the current version alone) — see the refund below for why. The quota check
  // has to use that same figure, or it disagrees with what is actually written:
  // checking `size - existing.size` while charging `size` minus the version sum
  // is two different formulas for one operation, which is how a near-quota user
  // gets a 507 on an overwrite that plainly fits.
  const refundBytes = existing
    ? existing.versions.reduce((n, v) => n + BigInt(v.size), 0n)
    : 0n;
  // Reserve the net cost atomically rather than checking it and charging later:
  // the old check-then-charge let concurrent PUTs (rclone and davfs2 both write
  // in parallel) each read the same balance and all commit, overshooting the
  // quota. The refund for the bytes this overwrite replaces is still applied
  // below, after the write actually lands. See reserveQuota.
  const reserveBytes = netCost(size, refundBytes);
  try {
    await reserveQuota(owner, reserveBytes);
  } catch {
    return res.status(507).end('Quota exceeded');
  }

  const ext = name.includes('.') ? name.split('.').pop() : '';
  const key = objectKeyFor(owner, ext);
  try {
    await putObjectStream(key, body, size, req.headers['content-type'] || 'application/octet-stream');
  } catch (e) {
    await releaseQuota(owner, reserveBytes);
    throw e;
  }
  const checksum = sha256Buffer(body);

  if (existing) {
    // A WebDAV PUT is an overwrite, not a new revision: afterwards the file must
    // occupy exactly `size` bytes. Collapse the history to the single new
    // object — keep the current version row (pointed at the new object) and drop
    // any older ones, whose objects are deleted below.
    //
    // Rewriting only the current version left the older rows alive pointing at
    // objects this route never removed, so a file with history silently kept
    // charging for bytes that no longer had a live object. Worse, every
    // hard-delete path (trash, the retention sweep, replace-on-duplicate)
    // refunds the SUM of versions[].size, so those stale rows would later refund
    // bytes that were never re-charged — drift in the opposite direction, and
    // unreconcilable once the rows vanish with the cascade.
    const staleKeys = existing.versions
      .filter((v) => v.version !== existing.currentVersion)
      .map((v) => v.objectKey);
    staleKeys.push(existing.objectKey);

    await prisma.$transaction([
      prisma.file.update({
        where: { id: existing.id },
        data: {
          objectKey: key,
          size: BigInt(size),
          checksum,
          mimeType: req.headers['content-type'] || existing.mimeType,
          // New content invalidates the old renditions, exactly as the version
          // upload and replace-on-duplicate paths do. HLS segments are keyed by
          // fileId ALONE, so leaving hlsReady set here doesn't just strand the
          // old segments — /stream/hls/:name gates on nothing but this flag, so
          // the player would keep serving the PREVIOUS file's video under the
          // new one, with no error anywhere.
          hlsReady: false,
        },
      }),
      prisma.fileVersion.updateMany({
        where: { fileId: existing.id, version: existing.currentVersion },
        data: { objectKey: key, size: BigInt(size), checksum },
      }),
      prisma.fileVersion.deleteMany({
        where: { fileId: existing.id, version: { not: existing.currentVersion } },
      }),
    ]);
    // reserveQuota already charged netCost(size, refundBytes) — the bytes this
    // overwrite ADDS. Charging the gross `size` again here and then refunding
    // would double-count the reservation. What is still owed is only the part of
    // the refund the net cost did not already absorb: on a growing overwrite
    // netCost is size-refund and nothing further moves, while on a SHRINKING one
    // netCost floored to 0 and the genuine reduction (refund - size) has yet to
    // be given back.
    const netCharged = netCost(size, refundBytes);
    const stillToRefund = refundBytes - BigInt(size) + netCharged;
    if (stillToRefund > 0n) await subUsage(owner, stillToRefund);
    // The new object shares no key with the old ones (objectKeyFor is unique per
    // call), so removing them can't touch what was just written.
    for (const k of new Set(staleKeys)) removeObject(k).catch(() => {});
    if (existing.hlsReady) removeHls(existing.id).catch(() => {});
    return res.status(204).end();
  }

  // New file: reserveQuota already charged the full `size` (refundBytes is 0
  // when there is no existing row), so nothing further is owed here.
  try {
    await prisma.file.create({
      data: {
        name,
        originalName: name,
        mimeType: req.headers['content-type'] || 'application/octet-stream',
        size: BigInt(size),
        objectKey: key,
        bucket: BUCKET,
        checksum,
        folderId: parent?.id ?? null,
        ownerId: owner,
        versions: { create: { version: 1, objectKey: key, size: BigInt(size), checksum } },
      },
    });
  } catch (e) {
    await releaseQuota(owner, reserveBytes);
    removeObject(key).catch(() => {});
    throw e;
  }
  res.status(201).end();
});

// ---- MKCOL (create folder) ----
router.all('*', async (req, res, next) => {
  if (req.method !== 'MKCOL') return next();
  const owner = req.davUser.id;
  const p = davPath(req);
  const { parentPath, name: rawName } = splitParent(p);
  if (!rawName) return res.status(400).end();
  // A folder name carrying a separator forges a `Folder.path` into an unrelated
  // subtree — the row lands with this parent but a path that an unrelated
  // delete's `path startsWith` cascade sweeps away, and that restore (which
  // climbs parentId) cannot put back. See davName.
  const name = davName(res, rawName, 'folder name');
  if (name === null) return;
  const parent = await findFolder(owner, parentPath);
  if (parentPath !== '/' && !parent) return res.status(409).end();
  const dupe = await findFolder(owner, p);
  if (dupe) return res.status(405).end('Already exists');
  // A folder must not take a live FILE's name either. findFolder() is tried
  // before findFile() by PROPFIND and DELETE, so a folder created over a file
  // shadows it: the path reports <D:collection/>, DELETE trashes the folder and
  // leaves the file live, billed and unreachable over WebDAV entirely. 405 is
  // what this route already returns for "a resource is in the way".
  if (await findFileNameClash(owner, parent?.id ?? null, name)) {
    return res.status(405).end('A file with that name already exists here');
  }
  await prisma.folder.create({
    data: { name, parentId: parent?.id ?? null, ownerId: owner, path: p },
  });
  res.status(201).end();
});

// ---- DELETE (trash file or folder) ----
router.delete('*', async (req, res) => {
  const owner = req.davUser.id;
  const p = davPath(req);
  const folder = await findFolder(owner, p);
  if (folder) {
    const now = new Date();
    const prefix = folder.path + '/';
    await prisma.$transaction([
      prisma.folder.updateMany({
        where: { ownerId: owner, OR: [{ id: folder.id }, { path: { startsWith: prefix } }] },
        data: { trashedAt: now },
      }),
      prisma.file.updateMany({
        where: { ownerId: owner, folder: { OR: [{ id: folder.id }, { path: { startsWith: prefix } }] } },
        data: { trashedAt: now },
      }),
    ]);
    return res.status(204).end();
  }
  const file = await findFile(owner, p);
  if (!file) return res.status(404).end();
  await prisma.file.update({ where: { id: file.id }, data: { trashedAt: new Date() } });
  res.status(204).end();
});

// ---- MOVE (rename / move file or folder) ----
router.all('*', async (req, res, next) => {
  if (req.method !== 'MOVE') return next();
  const owner = req.davUser.id;
  const from = davPath(req);
  const dest = req.headers.destination;
  if (!dest) return res.status(400).end();
  // Destination is an absolute URL or path; extract the part after /webdav.
  let destPath;
  try {
    const u = dest.startsWith('http') ? new URL(dest) : null;
    destPath = decodeURIComponent((u ? u.pathname : dest).replace(/^.*\/webdav/, '') || '/');
  } catch {
    return res.status(400).end();
  }
  if (destPath.length > 1 && destPath.endsWith('/')) destPath = destPath.slice(0, -1);
  const { parentPath: newParentPath, name: rawNewName } = splitParent(destPath);
  if (!rawNewName) return res.status(400).end();
  // A MOVE is a rename, so it is the other way to write a forged name — and the
  // folder branch below rebuilds `path` (and every descendant's) from it. See
  // davName. Checked before the source is even resolved, so a bad destination
  // costs nothing and changes nothing.
  const newName = davName(res, rawNewName, 'name');
  if (newName === null) return;
  const newParent = await findFolder(owner, newParentPath);
  if (newParentPath !== '/' && !newParent) return res.status(409).end();

  // Rebuild the destination path from the resolved parent and the sanitised
  // name rather than trusting the client's Destination string. `destPath` is
  // what gets WRITTEN into Folder.path (and prefixed onto every descendant), and
  // the two must agree: the parent is looked up by `newParentPath`, so composing
  // the path from that parent's own stored `path` is the only form guaranteed to
  // match the parentId this row is about to get. A Destination that disagreed
  // would otherwise leave a folder whose path says it lives somewhere its parent
  // link does not — the inconsistent-tree state assertNoSiblingCollision exists
  // to keep out, feeding the same prefix queries.
  destPath = newParent ? `${newParent.path}/${newName}` : `/${newName}`;

  const folder = await findFolder(owner, from);
  if (folder) {
    if (newParent && (newParent.path === folder.path || newParent.path.startsWith(folder.path + '/')))
      return res.status(409).end('Cannot move into itself');
    // (ownerId, path) must stay unique among LIVE folders — the REST rename
    // enforces it via assertNoSiblingCollision, and this route is the other way
    // in. Three separate things treat that pair as a subtree identity: the
    // soft-delete and the rename both select descendants with
    // `path startsWith parent + '/'`, deletableFolderIds decides what a bulk
    // purge may cascade into, and grantCoversFolder resolves folder shares.
    // Letting a MOVE land two live folders on one path makes every one of those
    // prefix queries hit BOTH subtrees: deleting one trashes the other's files,
    // and renaming one rewrites the other's descendants into a tree whose
    // children no longer match their parent. MKCOL already refuses duplicates
    // (405 above); a move that renames into an existing sibling did not.
    if (destPath !== folder.path) {
      const clash = await prisma.folder.findFirst({
        where: { ownerId: owner, path: destPath, trashedAt: null, id: { not: folder.id } },
        select: { id: true },
      });
      if (clash) return res.status(412).end('A folder with that name already exists here');
      // ...and not onto a live FILE's name: the folder would shadow it for
      // PROPFIND/GET/DELETE, leaving it live, billed and unreachable.
      if (await findFileNameClash(owner, newParent?.id ?? null, newName)) {
        return res.status(412).end('A file with that name already exists here');
      }
    }
    const oldPath = folder.path;
    const descendants = await prisma.folder.findMany({
      where: { ownerId: owner, path: { startsWith: oldPath + '/' } },
      select: { id: true, path: true },
    });
    await prisma.$transaction([
      prisma.folder.update({
        where: { id: folder.id },
        data: { name: newName, parentId: newParent?.id ?? null, path: destPath },
      }),
      ...descendants.map((d) =>
        prisma.folder.update({
          where: { id: d.id },
          data: { path: destPath + d.path.slice(oldPath.length) },
        }),
      ),
    ]);
    return res.status(201).end();
  }

  const file = await findFile(owner, from);
  if (!file) return res.status(404).end();
  // A file must not move onto a live FOLDER's name. Overwrite semantics do not
  // apply across resource kinds: RFC 4918 has the destination's namespace refuse
  // it, and replacing a collection with a file here would mean trashing a whole
  // subtree behind a rename. Left unchecked the file simply disappeared — the
  // folder shadows it for every WebDAV verb while it stays live and billed.
  if (await findFolderNameClash(owner, newParent?.id ?? null, newName)) {
    return res.status(412).end('A collection already exists at that path');
  }
  // Moving onto an existing name used to just land a SECOND live file with the
  // same name in the destination folder. findFile()/the PUT overwrite both
  // resolve a name with findFirst, so from then on which of the two a client
  // reads, overwrites or deletes is decided by row order — the other becomes
  // unreachable over WebDAV while still being charged for. RFC 4918 says a MOVE
  // onto an existing resource either replaces it (Overwrite: T, the default) or
  // fails with 412; honour that instead of silently duplicating.
  const target = await prisma.file.findFirst({
    where: {
      ownerId: owner,
      folderId: newParent?.id ?? null,
      name: newName,
      trashedAt: null,
      id: { not: file.id },
    },
    select: { id: true },
  });
  if (target) {
    if (String(req.headers.overwrite || 'T').toUpperCase() === 'F') {
      return res.status(412).end('Destination exists');
    }
    // Overwrite: trash the displaced file rather than hard-deleting it. Its
    // bytes stay on the quota exactly as any other trashed file's do, and the
    // existing trash/retention paths refund them — this route must not grow a
    // fifth hard-delete path with its own version-sum refund.
    await prisma.file.update({ where: { id: target.id }, data: { trashedAt: new Date() } });
  }
  await prisma.file.update({
    where: { id: file.id },
    data: { name: newName, folderId: newParent?.id ?? null },
  });
  res.status(target ? 204 : 201).end();
});

// ---- LOCK / UNLOCK (faked so Finder/Explorer permit writes) ----
router.all('*', (req, res, next) => {
  if (req.method === 'LOCK') {
    const token = 'opaquelocktoken:' + Math.random().toString(36).slice(2);
    res.set('Lock-Token', `<${token}>`);
    res.set('Content-Type', 'application/xml; charset=utf-8');
    return res
      .status(200)
      .end(
        `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
          `<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>` +
          `<D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout>` +
          `<D:locktoken><D:href>${token}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`,
      );
  }
  if (req.method === 'UNLOCK') return res.status(204).end();
  if (req.method === 'PROPPATCH') {
    res.set('Content-Type', 'application/xml; charset=utf-8');
    return res
      .status(207)
      .end(
        `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${xmlEscape(href(davPath(req)))}</D:href><D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
      );
  }
  next();
});

export default router;
