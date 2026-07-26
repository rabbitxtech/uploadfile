import { describe, it, expect } from 'vitest';
import { parseRange } from '../src/utils/range.js';

const SIZE = 1000;

describe('parseRange', () => {
  it('returns null when there is no range to honour', () => {
    expect(parseRange(undefined, SIZE)).toBeNull();
    expect(parseRange('', SIZE)).toBeNull();
    expect(parseRange('bytes=-', SIZE)).toBeNull();
    expect(parseRange('items=0-10', SIZE)).toBeNull();
    // Multi-range needs a multipart body; serving the full entity is correct.
    expect(parseRange('bytes=0-99,200-299', SIZE)).toBeNull();
  });

  it('parses an explicit start-end range', () => {
    expect(parseRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499, length: 500 });
    expect(parseRange('bytes=500-999', SIZE)).toEqual({ start: 500, end: 999, length: 500 });
  });

  it('treats an open-ended range as "to the end"', () => {
    expect(parseRange('bytes=900-', SIZE)).toEqual({ start: 900, end: 999, length: 100 });
  });

  // The bug this module exists for: "bytes=-500" means the LAST 500 bytes.
  // Reading it as start=0 served the FIRST 501 bytes under a Content-Range
  // header claiming otherwise.
  it('parses the suffix form as the last N bytes', () => {
    expect(parseRange('bytes=-500', SIZE)).toEqual({ start: 500, end: 999, length: 500 });
    expect(parseRange('bytes=-1', SIZE)).toEqual({ start: 999, end: 999, length: 1 });
  });

  it('clamps a suffix larger than the resource to the whole resource', () => {
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999, length: 1000 });
  });

  it('clamps an end past the last byte instead of rejecting', () => {
    expect(parseRange('bytes=0-5000', SIZE)).toEqual({ start: 0, end: 999, length: 1000 });
  });

  it('flags out-of-bounds ranges as unsatisfiable', () => {
    expect(parseRange('bytes=1000-', SIZE)).toEqual({ unsatisfiable: true });
    expect(parseRange('bytes=1500-1600', SIZE)).toEqual({ unsatisfiable: true });
    expect(parseRange('bytes=500-400', SIZE)).toEqual({ unsatisfiable: true });
    expect(parseRange('bytes=-0', SIZE)).toEqual({ unsatisfiable: true });
  });

  it('treats any range over an empty resource as unsatisfiable', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ unsatisfiable: true });
  });
});
