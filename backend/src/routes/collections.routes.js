// H5 — Collections: manual virtual groupings + smart saved searches.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { badRequest, notFound } from '../utils/errors.js';
import { stripIndexFieldsAll } from './files/_shared.js';

const router = Router();
router.use(requireAuth);

const fileInclude = {
  tags: true,
  folder: true,
  owner: { select: { id: true, name: true, email: true } },
};

// Resolve the files belonging to a collection: explicit set for "manual",
// live search for "smart".
async function collectionFiles(collection, ownerId) {
  if (collection.kind === 'smart') {
    let filter = {};
    try {
      filter = JSON.parse(collection.filter || '{}');
    } catch {
      filter = {};
    }
    const q = (filter.q || '').trim();
    const tag = filter.tag || null;
    const PG = (process.env.DB_PROVIDER || 'postgresql') === 'postgresql';
    const nameMatch = PG ? { contains: q, mode: 'insensitive' } : { contains: q };
    return prisma.file.findMany({
      where: {
        ownerId,
        trashedAt: null,
        AND: [q ? { name: nameMatch } : {}, tag ? { tags: { some: { name: tag } } } : {}],
      },
      include: fileInclude,
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  }
  // Scope the read-back to the collection's owner, not just `trashedAt`. The
  // m2m join is the only thing saying a file belongs here, so an unscoped read
  // hands back whatever got connected — and `fileInclude` has no `select`, so
  // that means every scalar column (ocrText, objectKey, checksum, size). The
  // connect sites filter by owner, and this filter is the backstop: two
  // independent checks, because a leak here is a silent cross-tenant read that
  // looks like a perfectly ordinary collection listing.
  const full = await prisma.collection.findUnique({
    where: { id: collection.id },
    include: { files: { where: { ownerId, trashedAt: null }, include: fileInclude } },
  });
  return full?.files || [];
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const collections = await prisma.collection.findMany({
      where: { ownerId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { files: true } } },
    });
    res.json({
      collections: collections.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        filter: c.filter,
        fileCount: c.kind === 'manual' ? c._count.files : null,
        createdAt: c.createdAt,
      })),
    });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(120),
        kind: z.enum(['manual', 'smart']).default('manual'),
        filter: z.object({ q: z.string().optional(), tag: z.string().optional() }).optional(),
        fileIds: z.array(z.string()).optional(),
      })
      .parse(req.body);

    // Only connect files the user owns — same rule as POST /:id/files. A bare
    // `connect` on the supplied ids attaches ANY file in the database, and since
    // the collection itself is owned by the caller, GET /:id then serves those
    // rows as their own: an authenticated cross-tenant read of every File
    // column (ocrText holds the full extracted document text) that needs
    // nothing but a file id.
    const ownedIds =
      data.kind === 'manual' && data.fileIds?.length
        ? await prisma.file.findMany({
            where: { id: { in: data.fileIds }, ownerId: req.user.id, trashedAt: null },
            select: { id: true },
          })
        : [];

    const collection = await prisma.collection.create({
      data: {
        name: data.name,
        kind: data.kind,
        ownerId: req.user.id,
        filter: data.kind === 'smart' ? JSON.stringify(data.filter || {}) : null,
        files: ownedIds.length ? { connect: ownedIds.map((f) => ({ id: f.id })) } : undefined,
      },
    });
    res.status(201).json(collection);
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const collection = await prisma.collection.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!collection) throw notFound('Collection');
    const files = await collectionFiles(collection, req.user.id);
    res.json({
      id: collection.id,
      name: collection.name,
      kind: collection.kind,
      filter: collection.filter ? JSON.parse(collection.filter) : null,
      // fileInclude carries no `select`, so these rows arrive with every scalar
      // column — including the whole of ocrText. See stripIndexFields.
      files: stripIndexFieldsAll(files),
    });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        filter: z.object({ q: z.string().optional(), tag: z.string().optional() }).optional(),
      })
      .parse(req.body);
    const collection = await prisma.collection.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!collection) throw notFound('Collection');
    const updated = await prisma.collection.update({
      where: { id: collection.id },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(data.filter && collection.kind === 'smart'
          ? { filter: JSON.stringify(data.filter) }
          : {}),
      },
    });
    res.json(updated);
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const collection = await prisma.collection.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!collection) throw notFound('Collection');
    await prisma.collection.delete({ where: { id: collection.id } });
    res.json({ ok: true });
  }),
);

// Add files to a manual collection.
router.post(
  '/:id/files',
  asyncHandler(async (req, res) => {
    const { fileIds } = z.object({ fileIds: z.array(z.string()).min(1) }).parse(req.body);
    const collection = await prisma.collection.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!collection) throw notFound('Collection');
    if (collection.kind !== 'manual') throw badRequest('Cannot add files to a smart collection');
    // Only connect files the user owns.
    const owned = await prisma.file.findMany({
      where: { id: { in: fileIds }, ownerId: req.user.id, trashedAt: null },
      select: { id: true },
    });
    await prisma.collection.update({
      where: { id: collection.id },
      data: { files: { connect: owned.map((f) => ({ id: f.id })) } },
    });
    res.json({ added: owned.length });
  }),
);

router.delete(
  '/:id/files/:fileId',
  asyncHandler(async (req, res) => {
    const collection = await prisma.collection.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!collection) throw notFound('Collection');
    await prisma.collection.update({
      where: { id: collection.id },
      data: { files: { disconnect: { id: req.params.fileId } } },
    });
    res.json({ ok: true });
  }),
);

export default router;
