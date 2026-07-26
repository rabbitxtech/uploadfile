// HTTP Range header parsing for the authenticated media stream (RFC 7233 §2.1).
//
// Extracted from the stream route so the edge cases are unit-testable: the
// suffix form ("bytes=-500" = the LAST 500 bytes) is easy to get wrong, and
// getting it wrong silently serves the wrong bytes under a Content-Range header
// that claims otherwise — which corrupts seeking rather than failing loudly.

/**
 * Parse a Range header against a known resource size.
 *
 * Returns:
 *   null                     no/unsupported range → caller sends the full 200
 *   { unsatisfiable: true }  syntactically valid but out of bounds → 416
 *   { start, end, length }   inclusive byte range → 206
 */
export function parseRange(header, size) {
  if (!header || typeof header !== 'string') return null;

  // Only the single-range "bytes=" form is supported; a multi-range request
  // would need a multipart/byteranges body, so fall back to the full entity.
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;

  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null; // "bytes=-" is malformed

  // A zero-length resource can satisfy no range at all.
  if (size <= 0) return { unsatisfiable: true };

  let start;
  let end;
  if (rawStart === '') {
    // Suffix form: the last N bytes. N larger than the resource means the whole
    // resource, per RFC 7233 — not an error.
    const suffix = Number(rawEnd);
    if (suffix === 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (start >= size) return { unsatisfiable: true };
    if (end >= size) end = size - 1; // clamp, don't reject
    if (end < start) return { unsatisfiable: true };
  }

  return { start, end, length: end - start + 1 };
}
