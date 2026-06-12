// Task5 #12 — pgvector helpers. Semantic search uses the `embeddingVec`
// vector(384) column + HNSW index on PostgreSQL; mysql/sqlite keep the
// JS-cosine fallback (same DB_PROVIDER gate as ciContains elsewhere).

export const VECTOR_DIM = 384;

export function pgvectorEnabled() {
  return (process.env.DB_PROVIDER || 'postgresql') === 'postgresql';
}

// Render a float[] as a pgvector literal ('[0.1,0.2,...]'). Returns null for
// anything that isn't a clean finite-number array of the expected dimension —
// callers treat null as "skip the vector column", never as an error.
export function toVectorLiteral(vec, dim = VECTOR_DIM) {
  if (!Array.isArray(vec) || vec.length !== dim) return null;
  for (const v of vec) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  }
  return `[${vec.join(',')}]`;
}
