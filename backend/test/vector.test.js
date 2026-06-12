// Task5 #12 — pgvector helper tests.
import { describe, it, expect, afterEach } from 'vitest';
import { pgvectorEnabled, toVectorLiteral, VECTOR_DIM } from '../src/utils/vector.js';

const ORIGINAL = process.env.DB_PROVIDER;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DB_PROVIDER;
  else process.env.DB_PROVIDER = ORIGINAL;
});

describe('pgvectorEnabled', () => {
  it('is on for postgresql and when DB_PROVIDER is unset (postgres default)', () => {
    process.env.DB_PROVIDER = 'postgresql';
    expect(pgvectorEnabled()).toBe(true);
    delete process.env.DB_PROVIDER;
    expect(pgvectorEnabled()).toBe(true);
  });

  it('is off for mysql/sqlite (JS cosine fallback)', () => {
    process.env.DB_PROVIDER = 'mysql';
    expect(pgvectorEnabled()).toBe(false);
    process.env.DB_PROVIDER = 'sqlite';
    expect(pgvectorEnabled()).toBe(false);
  });
});

describe('toVectorLiteral', () => {
  const vec = Array.from({ length: VECTOR_DIM }, (_, i) => i / VECTOR_DIM);

  it('renders a pgvector literal for a clean 384-dim array', () => {
    const lit = toVectorLiteral(vec);
    expect(lit.startsWith('[')).toBe(true);
    expect(lit.endsWith(']')).toBe(true);
    expect(lit.split(',').length).toBe(VECTOR_DIM);
  });

  it('rejects wrong dimensions, non-arrays and dirty values', () => {
    expect(toVectorLiteral(vec.slice(0, 100))).toBe(null);
    expect(toVectorLiteral(null)).toBe(null);
    expect(toVectorLiteral('[1,2,3]')).toBe(null);
    expect(toVectorLiteral([...vec.slice(0, VECTOR_DIM - 1), NaN])).toBe(null);
    expect(toVectorLiteral([...vec.slice(0, VECTOR_DIM - 1), Infinity])).toBe(null);
    expect(toVectorLiteral([...vec.slice(0, VECTOR_DIM - 1), '0.5'])).toBe(null);
  });

  it('honors a custom dimension', () => {
    expect(toVectorLiteral([1, 2, 3], 3)).toBe('[1,2,3]');
  });
});
