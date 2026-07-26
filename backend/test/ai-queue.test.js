// queueIndexFile serialises indexing jobs.
//
// indexFile shells out to tesseract (and pdftoppm for a PDF, rasterising up to
// 8 pages) and then runs a transformers.js embedding, so it is as CPU-heavy as
// the HLS and Whisper jobs — both of which are serialised through a
// module-level queue. Indexing was not: POST /files/reindex looped over up to
// 1000 files inside the request handler, and every concurrent call started its
// own loop, so the jobs stacked instead of queueing.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = { concurrent: 0, max: 0, order: [] };

// Stub everything indexFile touches so the test exercises the QUEUE, not OCR.
vi.mock('../src/config/prisma.js', () => ({
  prisma: {
    file: {
      findUnique: vi.fn(async ({ where }) => {
        state.concurrent += 1;
        state.max = Math.max(state.max, state.concurrent);
        state.order.push(where.id);
        // Hold the "job" open so an unserialised caller would overlap here.
        await new Promise((r) => setTimeout(r, 5));
        return { id: where.id, name: 'f.txt', mimeType: 'text/plain', objectKey: 'k' };
      }),
      update: vi.fn(async () => {
        state.concurrent -= 1;
        return {};
      }),
    },
  },
}));

vi.mock('../src/services/storage.service.js', () => ({
  getObjectStream: vi.fn(async () => null),
}));

vi.mock('../src/utils/vector.js', () => ({
  pgvectorEnabled: () => false,
  toVectorLiteral: () => null,
}));

const { queueIndexFile } = await import('../src/services/ai.service.js');

beforeEach(() => {
  state.concurrent = 0;
  state.max = 0;
  state.order = [];
});

describe('queueIndexFile', () => {
  it('runs at most one indexing job at a time', async () => {
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => queueIndexFile(id)));
    expect(state.max).toBe(1);
    expect(state.order).toHaveLength(5);
  });

  it('preserves submission order', async () => {
    await Promise.all(['1', '2', '3'].map((id) => queueIndexFile(id)));
    expect(state.order).toEqual(['1', '2', '3']);
  });

  it('keeps draining after a job throws', async () => {
    const { prisma } = await import('../src/config/prisma.js');
    prisma.file.findUnique.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    // The failure must not wedge the queue for everything queued behind it.
    await Promise.all([queueIndexFile('bad'), queueIndexFile('good')]);
    expect(state.order).toContain('good');
  });
});
