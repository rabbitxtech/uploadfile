// Task5 #20 — cursor pagination helpers.
import { describe, it, expect } from 'vitest';
import {
  parseListQuery,
  fileOrderBy,
  folderOrderBy,
  filePageArgs,
  pageResult,
  LIST_TAKE_DEFAULT,
  LIST_TAKE_MAX,
} from '../src/utils/listquery.js';

describe('parseListQuery', () => {
  it('defaults to name asc with the default page size', () => {
    expect(parseListQuery({})).toEqual({
      take: LIST_TAKE_DEFAULT,
      cursor: null,
      sort: 'name',
      dir: 'asc',
    });
  });

  it('clamps take and rejects junk values', () => {
    expect(parseListQuery({ take: '50' }).take).toBe(50);
    expect(parseListQuery({ take: '99999' }).take).toBe(LIST_TAKE_MAX);
    expect(parseListQuery({ take: '0' }).take).toBe(1);
    expect(parseListQuery({ take: 'abc' }).take).toBe(LIST_TAKE_DEFAULT);
  });

  it('accepts only known sort keys and directions', () => {
    expect(parseListQuery({ sort: 'size', dir: 'desc' })).toMatchObject({
      sort: 'size',
      dir: 'desc',
    });
    expect(parseListQuery({ sort: 'ownerId', dir: 'up' })).toMatchObject({
      sort: 'name',
      dir: 'asc',
    });
    // Prototype pollution-ish keys must not pass the allowlist.
    expect(parseListQuery({ sort: 'constructor' }).sort).toBe('name');
  });

  it('keeps a non-empty cursor', () => {
    expect(parseListQuery({ cursor: 'abc' }).cursor).toBe('abc');
    expect(parseListQuery({ cursor: '' }).cursor).toBe(null);
  });
});

describe('orderBy mapping', () => {
  it('maps sort keys to prisma fields with an id tiebreaker', () => {
    expect(fileOrderBy('type', 'desc')).toEqual([{ mimeType: 'desc' }, { id: 'asc' }]);
    expect(fileOrderBy('modified', 'asc')).toEqual([{ updatedAt: 'asc' }, { id: 'asc' }]);
  });

  it('folders fall back to name for size/type', () => {
    expect(folderOrderBy('size', 'desc')).toEqual([{ name: 'desc' }, { id: 'asc' }]);
    expect(folderOrderBy('modified', 'desc')).toEqual([{ updatedAt: 'desc' }, { id: 'asc' }]);
  });
});

describe('paging', () => {
  it('fetches take+1 and skips the cursor row itself', () => {
    expect(filePageArgs({ take: 200, cursor: null })).toEqual({ take: 201 });
    expect(filePageArgs({ take: 200, cursor: 'x' })).toEqual({
      take: 201,
      cursor: { id: 'x' },
      skip: 1,
    });
  });

  it('pageResult trims the probe row and exposes nextCursor', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(pageResult(rows, 2)).toEqual({
      files: [{ id: 'a' }, { id: 'b' }],
      nextCursor: 'b',
    });
    expect(pageResult(rows, 3)).toEqual({ files: rows, nextCursor: null });
    expect(pageResult([], 3)).toEqual({ files: [], nextCursor: null });
  });
});
