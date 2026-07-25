// Chunked upload client — the most failure-prone path in the app, and one that
// has already broken silently once (a mis-ordered minio uploadPart argument sent
// empty bodies: every part "succeeded", the assembled object was 0 bytes, and
// nothing was logged). These tests pin the contract that catches that class of
// bug: every byte of the file is sent exactly once, in order, with the part
// numbers the backend expects.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPost, mockToken } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockToken: { current: 'test-jwt' },
}));

vi.mock('./client.js', () => ({
  api: { post: mockPost },
  apiBase: '/api',
}));

vi.mock('../store/auth.js', () => ({
  useAuth: { getState: () => ({ token: mockToken.current }) },
}));

const { chunkedUpload } = await import('./upload.js');

// Blob#slice works in jsdom but Blob#size on a sliced part is what we assert on,
// so build files out of real Blobs rather than stubs.
function makeFile(bytes, { name = 'big.bin', type = 'application/pdf' } = {}) {
  const file = new File([new Uint8Array(bytes)], name, { type });
  return file;
}

/** Collects each PUT so tests can assert on order, part numbers and sizes. */
function installFetch({ failOn = null, status = 500, body = null } = {}) {
  const calls = [];
  global.fetch = vi.fn(async (url, opts) => {
    const part = Number(new URL(url, 'http://x').searchParams.get('part'));
    calls.push({ url, part, size: opts.body.size, headers: opts.headers });
    if (failOn === part) {
      return {
        ok: false,
        status,
        clone: () => ({ json: async () => (body ?? { error: 'quota exceeded' }) }),
      };
    }
    return { ok: true, status: 200 };
  });
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockToken.current = 'test-jwt';
  mockPost.mockImplementation(async (url) => {
    if (url === '/upload/init') {
      return { data: { sessionId: 'sess-1', chunkSize: 100 } };
    }
    return { data: { id: 'file-1', name: 'big.bin' } };
  });
});

describe('chunkedUpload', () => {
  it('sends every byte exactly once, in order, with 1-based part numbers', async () => {
    const calls = installFetch();
    await chunkedUpload(makeFile(250)); // 100 + 100 + 50

    expect(calls.map((c) => c.part)).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.size)).toEqual([100, 100, 50]);
    // The whole file, no gaps and no double-sends — this is the invariant that
    // a 0-byte or truncated upload would violate.
    expect(calls.reduce((n, c) => n + c.size, 0)).toBe(250);
  });

  it('sends a file smaller than one chunk as a single part', async () => {
    const calls = installFetch();
    await chunkedUpload(makeFile(30));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ part: 1, size: 30 });
  });

  it('sends an exact multiple of the chunk size without a trailing empty part', async () => {
    const calls = installFetch();
    await chunkedUpload(makeFile(200)); // exactly 2 chunks

    // A ceil() that mishandles the boundary would add a third, 0-byte part —
    // which the backend would happily accept and then assemble short.
    expect(calls.map((c) => c.size)).toEqual([100, 100]);
  });

  it('still uploads one part for a 0-byte file', async () => {
    const calls = installFetch();
    await chunkedUpload(makeFile(0));

    // total is clamped to >= 1 so an empty file completes rather than skipping
    // straight to complete with no parts at all.
    expect(calls.map((c) => c.size)).toEqual([0]);
  });

  it('forwards filename, size, mime, folder and replaceFileId to init', async () => {
    installFetch();
    const file = makeFile(10, { name: 'report.pdf', type: 'application/pdf' });
    await chunkedUpload(file, { folderId: 'f-9', replaceFileId: 'old-7' });

    expect(mockPost).toHaveBeenCalledWith('/upload/init', {
      filename: 'report.pdf',
      size: 10,
      mimeType: 'application/pdf',
      folderId: 'f-9',
      replaceFileId: 'old-7',
    });
  });

  it('falls back to a generic mime type when the browser reports none', async () => {
    installFetch();
    await chunkedUpload(makeFile(10, { type: '' }));

    expect(mockPost).toHaveBeenCalledWith(
      '/upload/init',
      expect.objectContaining({ mimeType: 'application/octet-stream' }),
    );
  });

  it('authorizes each part with the bearer token', async () => {
    const calls = installFetch();
    await chunkedUpload(makeFile(150));

    for (const call of calls) {
      expect(call.headers.Authorization).toBe('Bearer test-jwt');
      expect(call.headers['Content-Type']).toBe('application/octet-stream');
    }
  });

  it('reports cumulative progress that ends at the full file size', async () => {
    installFetch();
    const seen = [];
    await chunkedUpload(makeFile(250), { onProgress: (p) => seen.push(p) });

    expect(seen.map((p) => p.uploaded)).toEqual([100, 200, 250]);
    expect(seen.at(-1)).toMatchObject({ uploaded: 250, total: 250, part: 3, parts: 3 });
  });

  it('completes the session only after the last part', async () => {
    installFetch();
    await chunkedUpload(makeFile(150));

    const order = mockPost.mock.calls.map((c) => c[0]);
    expect(order).toEqual(['/upload/init', '/upload/sess-1/complete']);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('surfaces the server error message from a failed part', async () => {
    installFetch({ failOn: 2, status: 413, body: { error: 'quota exceeded' } });

    await expect(chunkedUpload(makeFile(250))).rejects.toMatchObject({
      message: 'quota exceeded',
      status: 413,
      serverError: 'quota exceeded',
    });
  });

  it('falls back to a synthetic message when the error body is not JSON', async () => {
    // nginx returns an HTML 413 page, not JSON — the client must not throw
    // while parsing the error and mask the real failure.
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 413,
      clone: () => ({ json: async () => { throw new SyntaxError('not json'); } }),
    }));

    await expect(chunkedUpload(makeFile(50))).rejects.toMatchObject({
      message: 'Part 1 failed (HTTP 413)',
      status: 413,
    });
  });

  it('does not complete the session when a part fails', async () => {
    installFetch({ failOn: 1 });
    await expect(chunkedUpload(makeFile(250))).rejects.toThrow();

    // Completing after a failed part would assemble a short object.
    expect(mockPost.mock.calls.map((c) => c[0])).toEqual(['/upload/init']);
  });

  it('stops before the next part once the signal is aborted', async () => {
    const controller = new AbortController();
    const calls = [];
    global.fetch = vi.fn(async (url, opts) => {
      calls.push(Number(new URL(url, 'http://x').searchParams.get('part')));
      controller.abort(); // abort after the first part lands
      return { ok: true, status: 200 };
    });

    await expect(
      chunkedUpload(makeFile(250), { signal: controller.signal }),
    ).rejects.toThrow('aborted');

    expect(calls).toEqual([1]);
    expect(mockPost.mock.calls.map((c) => c[0])).toEqual(['/upload/init']);
  });

  it('honours the chunk size the server chose, not a hardcoded one', async () => {
    mockPost.mockImplementation(async (url) => {
      if (url === '/upload/init') return { data: { sessionId: 's', chunkSize: 64 } };
      return { data: {} };
    });
    const calls = installFetch();
    await chunkedUpload(makeFile(150));

    expect(calls.map((c) => c.size)).toEqual([64, 64, 22]);
  });

  it('returns the completed file record from the server', async () => {
    installFetch();
    const out = await chunkedUpload(makeFile(10));

    expect(out).toEqual({ id: 'file-1', name: 'big.bin' });
  });
});
