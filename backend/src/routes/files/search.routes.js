// Plain + semantic search, and the reindex backfill.
//
// Mounted AFTER requireAuth. These paths are static, so they must be registered
// before the `/:id` routes or Express matches "search" as an id.
import { Router } from 'express';
import { prisma } from '../../config/prisma.js';
import { asyncHandler } from '../../utils/async.js';
import { queueIndexFile, embed, cosine } from '../../services/ai.service.js';
import { requireRole } from '../../middleware/auth.js';
import { pgvectorEnabled, toVectorLiteral } from '../../utils/vector.js';
import { ciContains, stripIndexFields, stripIndexFieldsAll } from './_shared.js';

export const searchRouter = Router();

searchRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const tag = req.query.tag ? String(req.query.tag) : null;
    if (!q && !tag) return res.json({ files: [] });

    const rows = await prisma.file.findMany({
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
    // Searched against, never rendered — see stripIndexFields. Returning them for
    // up to 100 rows turned a search-as-you-type into a multi-megabyte response.
    res.json({ files: stripIndexFieldsAll(rows) });
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
          return [{ ...stripIndexFields(f), score: Number(Number(h.score).toFixed(3)) }];
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
        // Parse the embedding BEFORE stripping it — this branch ranks in JS.
        return { file: stripIndexFields(f), score: cosine(qvec, v) };
      })
      .filter((x) => x.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
    res.json({ files: ranked.map((x) => ({ ...x.file, score: Number(x.score.toFixed(3)) })) });
  }),
);

// K1/K4 — (re)index the caller's files that have no embedding yet (background).
//
// Admin-only, which is how the README, the routing map and the OpenAPI spec have
// always described it; the role check was simply missing. It only ever queues
// the CALLER's own files, so this was never a privilege-escalation hole — it is
// a resource one. Each queued file shells out to tesseract (and pdftoppm for a
// PDF, rasterising up to 8 pages) and then runs a transformers.js embedding, so
// a single call can start up to 1000 CPU-heavy jobs. Nothing stopped an ordinary
// user from firing it repeatedly, and because the backfill loop lived inside the
// request handler, every call started its OWN loop: the jobs stacked instead of
// queueing, which is exactly the pile-up that hls.service and transcribe.service
// each avoid with a module-level queue. indexFile is now serialised the same way
// (see ai.service.js), so overlapping calls share one worker rather than
// multiplying ffmpeg/tesseract processes.
searchRouter.post(
  '/reindex',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const files = await prisma.file.findMany({
      where: { ownerId: req.user.id, trashedAt: null, embedding: null },
      select: { id: true },
      take: 1000,
    });
    for (const f of files) queueIndexFile(f.id);
    res.json({ queued: files.length });
  }),
);
