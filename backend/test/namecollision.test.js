// A stored name is ONE path segment — unit coverage for the rule itself.
//
// The integration suite (test/integration/name-segment.test.js) proves the
// routes apply it. These cases pin the helper's own edges, which are easy to get
// subtly wrong and are consumed by three layers that each read a name back as
// structure: Folder.path is built by joining names with "/", WebDAV's findFile()
// splits a request path on the last "/", and archiver writes the name straight
// into the ZIP central directory.
import { describe, it, expect } from 'vitest';
import { sanitizeEntryName, zipEntryName } from '../src/utils/namecollision.js';

// Built from a char code so no source-level or shell escaping can turn this into
// something else — reading a literal backslash wrong is exactly how a "\b" in a
// test ends up asserting on U+0008 instead.
const BS = String.fromCharCode(92);

describe('sanitizeEntryName — reject mode (a name a person typed)', () => {
  it('passes an ordinary name through unchanged', () => {
    expect(sanitizeEntryName('report.pdf')).toBe('report.pdf');
    expect(sanitizeEntryName('  spaced.txt  ')).toBe('spaced.txt');
  });

  it('refuses a forward slash', () => {
    expect(() => sanitizeEntryName('work/reports')).toThrow();
  });

  it('refuses a backslash', () => {
    // WebDAV clients on Windows and the ZIP spec both treat "\" as a separator,
    // so allowing it would move the same forgery one encoding away.
    expect(() => sanitizeEntryName('work' + BS + 'reports')).toThrow();
  });

  it('refuses traversal segments outright', () => {
    expect(() => sanitizeEntryName('..')).toThrow();
    expect(() => sanitizeEntryName('.')).toThrow();
  });

  it('refuses an empty or whitespace-only name', () => {
    expect(() => sanitizeEntryName('')).toThrow();
    expect(() => sanitizeEntryName('   ')).toThrow();
  });

  it('refuses control characters', () => {
    // NUL and the C0 range terminate strings in filesystems, HTTP headers and
    // the ZIP directory alike, so a name carrying one means something different
    // downstream than it does here.
    expect(() => sanitizeEntryName('a' + String.fromCharCode(0) + 'b.txt')).toThrow();
    expect(() => sanitizeEntryName('a' + String.fromCharCode(31) + 'b.txt')).toThrow();
    expect(() => sanitizeEntryName('a' + String.fromCharCode(127) + 'b.txt')).toThrow();
  });

  it('carries the caller-supplied label into the message', () => {
    expect(() => sanitizeEntryName('a/b', { label: 'folder name' })).toThrow(/folder name/);
  });
});

describe('sanitizeEntryName — strip mode (a name that arrived with content)', () => {
  it('reduces a path to its last segment', () => {
    expect(sanitizeEntryName('sub/evil.txt', { mode: 'strip' })).toBe('evil.txt');
    expect(sanitizeEntryName('../../../tmp/x.txt', { mode: 'strip' })).toBe('x.txt');
  });

  it('treats a backslash as a separator too', () => {
    expect(sanitizeEntryName('a' + BS + 'b.txt', { mode: 'strip' })).toBe('b.txt');
    // A Windows client's full path is the realistic shape here.
    expect(
      sanitizeEntryName('C:' + BS + 'Users' + BS + 'me' + BS + 'a.txt', { mode: 'strip' }),
    ).toBe('a.txt');
  });

  it('still refuses what has no usable last segment', () => {
    // "." and ".." are traversal rather than a name, and there is nothing to
    // fall back to — so strip mode refuses them as well.
    expect(() => sanitizeEntryName('..', { mode: 'strip' })).toThrow();
    expect(() => sanitizeEntryName('a/..', { mode: 'strip' })).toThrow();
    expect(() => sanitizeEntryName('/', { mode: 'strip' })).toThrow();
  });
});

describe('zipEntryName — sanitising a stored name on the way out', () => {
  it('reduces a legacy traversing name to its last segment', () => {
    // Rows created before the write paths enforced the rule still carry these,
    // and a stored "../../../tmp/x" becomes a Zip Slip entry the moment it is
    // archived.
    expect(zipEntryName('../../../tmp/x.txt')).toBe('x.txt');
    expect(zipEntryName('sub/evil.txt')).toBe('evil.txt');
    expect(zipEntryName('a' + BS + 'b.txt')).toBe('b.txt');
  });

  it('never throws — a bulk download must not 500 over one bad row', () => {
    expect(zipEntryName('..')).toBe('file');
    expect(zipEntryName('')).toBe('file');
    expect(zipEntryName(null)).toBe('file');
    expect(zipEntryName('a' + String.fromCharCode(0) + 'b')).toBe('file');
  });

  it('honours a caller-supplied fallback', () => {
    expect(zipEntryName('..', 'unnamed.bin')).toBe('unnamed.bin');
  });

  it('leaves an ordinary name alone', () => {
    expect(zipEntryName('holiday photo.jpg')).toBe('holiday photo.jpg');
  });
});
