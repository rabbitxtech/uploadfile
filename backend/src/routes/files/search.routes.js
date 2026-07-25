// Plain + semantic search, and the reindex backfill.
//
// Mounted AFTER requireAuth. These paths are static, so they must be registered
// before the `/:id` routes or Express matches "search" as an id.
import { Router } from 'express';
import { prisma } from '../../config/prisma.js';
import { asyncHandler } from '../../utils/async.js';
import { indexFile, embed, cosine } from '../../services/ai.service.js';
import { pgvectorEnabled, toVectorLiteral } from '../../utils/vector.js';
import { ciContains } from './_shared.js';

export const searchRouter = Router();

searchRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const tag = req.query.tag ? String(req.query.tag) : null;
    if (!q && !tag) return res.json({ files: [] });

    const files = await prisma.file.findMany({
      where: {
        ownerId: req.user.id,
        trashedAt: null,
        AND: [
          // K1 — match the file name OR its OCR-extracted text (case-insensitive).
          q ? { OR: [{ name: ciContains(q) }, { ocrText: ciContains(q) }] } : {},
          tag ? { tags: { some: { name: tag } } } : {},
        ],
      },
      include: {
        tags: true,
        folder: true,
        owner: { select: { id: true, name: true, email: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    res.json({ files });
  }),
);

// K4 — semantic search: embed the query and rank files by cosine similarity.
// Task5 #12 — on PostgreSQL the ranking runs in the database against the
// pgvector `embeddingVec` column (HNSW index: `ORDER BY <=> LIMIT 30` is an
// ANN index scan, no full load into Node). mysql/sqlite keep the JS fallback.
searchRouter.get(
  '/semantic-search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ files: [] });
    const qvec = await embed(q).catch(() => null);
    if (!qvec) return res.json({ files: [], error: 'Embedding unavailable' });

    const lit = pgvectorEnabled() ? toVectorLiteral(qvec) : null;
    if (lit) {
      // Pure ORDER BY … LIMIT keeps the HNSW index scan; the score floor is
      // applied afterwards in JS so it can't break the index usage.
      const hits = (
        await prisma.$queryRaw`
          SELECT "id", 1 - ("embeddingVec" <=> ${lit}::vector) AS score
          FROM "File"
          WHERE "ownerId" = ${req.user.id} AND "trashedAt" IS NULL AND "embeddingVec" IS NOT NULL
          ORDER BY "embeddingVec" <=> ${lit}::vector
          LIMIT 30`
      ).filter((h) => Number(h.score) > 0.2);
      if (!hits.length) return res.json({ files: [] });
      const rows = await prisma.file.findMany({
        where: { id: { in: hits.map((h) => h.id) } },
        include: { tags: true, folder: true, owner: { select: { id: true, name: true, email: true } } },
      });
      const byId = new Map(rows.map((f) => [f.id, f]));
      return res.json({
        files: hits.flatMap((h) => {
          const f = byId.get(h.id);
          if (!f) return [];
          const { embedding, ocrText, ...rest } = f;
          return [{ ...rest, score: Number(Number(h.score).toFixed(3)) }];
        }),
      });
    }

    const files = await prisma.file.findMany({
      where: { ownerId: req.user.id, trashedAt: null, embedding: { not: null } },
      include: { tags: true, folder: true, owner: { select: { id: true, name: true, email: true } } },
    });
    const ranked = files
      .map((f) => {
        let v = null;
        try {
          v = JSON.parse(f.embedding);
        } catch {
          v = null;
        }
        const { embedding, ocrText, ...rest } = f;
        return { file: rest, score: cosine(qvec, v) };
      })
      .filter((x) => x.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
    res.json({ files: ranked.map((x) => ({ ...x.file, score: Number(x.score.toFixed(3)) })) });
  }),
);

// K1/K4 — (re)index the caller's files that have no embedding yet (background).
// NOTE: despite being described as admin-only in the docs, there is no role
// check here — but it only ever queues the CALLER's own files, so it is not a
// privilege issue; it is a "this user can start a background job" one.
searchRouter.post(
  '/reindex',
  asyncHandler(async (req, res) => {
    const files = await prisma.file.findMany({
      where: { ownerId: req.user.id, trashedAt: null, embedding: null },
      select: { id: true },
      take: 1000,
    });
    (async () => {
      for (const f of files) await indexFile(f.id);
    })().catch(() => {});
    res.json({ queued: files.length });
  }),
);
