// Fixture builders for the integration suite. Everything returns real rows, so
// tests exercise the same access-control paths production does.
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from './db.js';

let seq = 0;
const uniq = (p) => `${p}-${Date.now().toString(36)}-${seq++}`;

export async function makeUser({
  role = 'user',
  approved = true,
  emailVerified = true,
  banned = false,
  quotaBytes = 5n * 1024n * 1024n * 1024n,
  password = 'TestPass123!',
} = {}) {
  const email = uniq('user') + '@test.local';
  const user = await prisma.user.create({
    data: {
      email,
      name: email,
      password: await bcrypt.hash(password, 4), // low cost: tests, not prod
      role,
      approved,
      emailVerified,
      banned,
      quotaBytes,
    },
  });
  return { ...user, password };
}

/**
 * Creates a real Session row and signs a token carrying its `sid`, exactly as
 * session.service does — requireAuth rejects tokens without a live session, so
 * a hand-rolled JWT would 401.
 */
export async function login(user, { expiresInMs = 7 * 24 * 3600 * 1000 } = {}) {
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      userAgent: 'vitest',
      ip: '127.0.0.1',
      expiresAt: new Date(Date.now() + expiresInMs),
    },
  });
  const token = jwt.sign(
    { sub: user.id, role: user.role, sid: session.id },
    process.env.JWT_SECRET,
    { expiresIn: '7d' },
  );
  return { token, session, auth: `Bearer ${token}` };
}

export async function makeFolder(owner, { name = uniq('folder'), parentId = null } = {}) {
  const parent = parentId ? await prisma.folder.findUnique({ where: { id: parentId } }) : null;
  return prisma.folder.create({
    data: {
      name,
      path: parent ? `${parent.path}/${name}` : `/${name}`,
      parentId,
      ownerId: owner.id,
    },
  });
}

/**
 * A file as the app actually stores one — including its `version: 1` row.
 *
 * Every production path that creates a File creates that first FileVersion
 * alongside it (single-shot upload, chunked complete, from-url, WebDAV PUT), and
 * every hard-delete path refunds the SUM of versions[].size rather than
 * File.size, because each version upload charges the owner separately and leaves
 * the previous object in MinIO. A fixture file with no version rows is a shape
 * that cannot exist in production, and it makes those refunds silently read as
 * zero — so the tests would pass against code that never refunds anything.
 */
export async function makeFile(owner, {
  name = uniq('file') + '.txt',
  folderId = null,
  size = 1024,
  mimeType = 'text/plain',
  trashedAt = null,
  starred = false,
} = {}) {
  const objectKey = `u/${owner.id}/${uniq('obj')}`;
  return prisma.file.create({
    data: {
      name,
      originalName: name,
      mimeType,
      size: BigInt(size),
      objectKey,
      bucket: process.env.MINIO_BUCKET || 'uploads',
      ownerId: owner.id,
      folderId,
      trashedAt,
      starred,
      versions: { create: { version: 1, objectKey, size: BigInt(size) } },
    },
  });
}
