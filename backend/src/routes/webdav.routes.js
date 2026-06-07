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
import { assertQuota, addUsage, subUsage } from '../services/quota.service.js';
import { sha256Buffer } from '../services/checksum.service.js';
import { prisma } from '../config/prisma.js';

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
    const u = await prisma.user.findUnique({ where: { email: user } });
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
  const { parentPath, name } = splitParent(p);
  if (!name) return res.status(400).end();
  const parent = await findFolder(owner, parentPath);
  if (parentPath !== '/' && !parent) return res.status(409).end('Parent collection missing');

  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const size = body.length;
  const existing = await prisma.file.findFirst({
    where: { ownerId: owner, folderId: parent?.id ?? null, name, trashedAt: null },
  });
  try {
    if (existing) await assertQuota(owner, size - Number(existing.size));
    else await assertQuota(owner, size);
  } catch {
    return res.status(507).end('Quota exceeded');
  }

  const ext = name.includes('.') ? name.split('.').pop() : '';
  const key = objectKeyFor(owner, ext);
  await putObjectStream(key, body, size, req.headers['content-type'] || 'application/octet-stream');
  const checksum = sha256Buffer(body);

  if (existing) {
    const oldKey = existing.objectKey;
    await prisma.file.update({
      where: { id: existing.id },
      data: { objectKey: key, size: BigInt(size), checksum, mimeType: req.headers['content-type'] || existing.mimeType },
    });
    await addUsage(owner, size);
    await subUsage(owner, Number(existing.size));
    removeObject(oldKey).catch(() => {});
    return res.status(204).end();
  }

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
  await addUsage(owner, size);
  res.status(201).end();
});

// ---- MKCOL (create folder) ----
router.all('*', async (req, res, next) => {
  if (req.method !== 'MKCOL') return next();
  const owner = req.davUser.id;
  const p = davPath(req);
  const { parentPath, name } = splitParent(p);
  if (!name) return res.status(400).end();
  const parent = await findFolder(owner, parentPath);
  if (parentPath !== '/' && !parent) return res.status(409).end();
  const dupe = await findFolder(owner, p);
  if (dupe) return res.status(405).end('Already exists');
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
  const { parentPath: newParentPath, name: newName } = splitParent(destPath);
  const newParent = await findFolder(owner, newParentPath);
  if (newParentPath !== '/' && !newParent) return res.status(409).end();

  const folder = await findFolder(owner, from);
  if (folder) {
    if (newParent && (newParent.path === folder.path || newParent.path.startsWith(folder.path + '/')))
      return res.status(409).end('Cannot move into itself');
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
  await prisma.file.update({
    where: { id: file.id },
    data: { name: newName, folderId: newParent?.id ?? null },
  });
  res.status(201).end();
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
