// Offline outbox flush — must upload each queued file exactly once.
//
// A queued item is deleted from IndexedDB only after its upload RESOLVES, so any
// flush that begins while another is still in flight re-reads the same rows. The
// effect re-subscribes whenever `onUploaded` changes identity, and the only
// caller (Files.jsx) passes an inline arrow that ALSO invalidates the folder
// queries — so every completed upload re-renders the parent and restarts the
// flush while the rest of the queue is still uploading. Each pass then re-sent
// files that were already going up, creating duplicates that each cost quota.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

const queue = [];
vi.mock('../lib/outbox.js', () => ({
  enqueue: vi.fn(async (item) => { queue.push(item); }),
  allItems: vi.fn(async () => [...queue]),
  removeItem: vi.fn(async (id) => {
    const i = queue.findIndex((q) => q.id === id);
    if (i >= 0) queue.splice(i, 1);
  }),
  countItems: vi.fn(async () => queue.length),
}));

// Uploads stay pending until released, so a re-render lands mid-flight —
// the exact window the duplicate appeared in.
const uploadCalls = [];
let pending = [];
vi.mock('../api/upload.js', () => ({
  chunkedUpload: vi.fn((file) => {
    uploadCalls.push(file.name);
    return new Promise((resolve) => {
      pending.push(() => resolve({ id: `id-${file.name}`, name: file.name }));
    });
  }),
}));

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock('../api/endpoints.js', () => ({ FileApi: {}, FolderApi: {} }));
vi.mock('../store/auth.js', () => ({ useAuth: { getState: () => ({ token: 'test-token' }) } }));

import Uploader from './Uploader.jsx';

const queued = (name) => ({
  id: `q-${name}`,
  file: new File(['x'], name),
  name,
  folderId: null,
  createdAt: Date.now(),
});

// Re-render with a NEW inline onUploaded each time, as Files.jsx does.
async function rerenderTimes(rerender, n) {
  for (let i = 0; i < n; i++) {
    rerender(<Uploader folderId={null} onUploaded={() => {}} />);
    await act(async () => {});
  }
}

describe('Uploader offline outbox flush', () => {
  beforeEach(() => {
    queue.length = 0;
    uploadCalls.length = 0;
    pending = [];
  });

  it('uploads a queued file once despite repeated parent re-renders', async () => {
    queue.push(queued('queued.txt'));

    const { rerender } = render(<Uploader folderId={null} onUploaded={() => {}} />);
    await act(async () => {});
    await rerenderTimes(rerender, 3);

    expect(uploadCalls).toEqual(['queued.txt']);

    await act(async () => { pending.forEach((r) => r()); });
    expect(queue).toHaveLength(0);
  });

  it('does not restart the queue when a completed upload re-renders the parent', async () => {
    queue.push(queued('a.txt'), queued('b.txt'));

    // onUploaded re-renders the parent exactly as invalidateQueries does.
    let renders = 0;
    const { rerender } = render(
      <Uploader folderId={null} onUploaded={() => { renders += 1; }} />,
    );
    await act(async () => {});

    // First file is in flight; release it, which fires onUploaded mid-flush.
    await act(async () => { pending.shift()(); });
    await rerenderTimes(rerender, 2);
    await act(async () => { pending.forEach((r) => r()); });

    expect(renders).toBeGreaterThan(0);
    // Each file uploaded exactly once, in order.
    expect(uploadCalls).toEqual(['a.txt', 'b.txt']);
    expect(queue).toHaveLength(0);
  });

  it('leaves a failed item queued for the next flush without duplicating it', async () => {
    queue.push(queued('flaky.txt'));

    let attempt = 0;
    const { chunkedUpload } = await import('../api/upload.js');
    chunkedUpload.mockImplementation((file) => {
      uploadCalls.push(file.name);
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ id: 'ok', name: file.name });
    });

    const { rerender } = render(<Uploader folderId={null} onUploaded={() => {}} />);
    await act(async () => {});
    expect(uploadCalls).toEqual(['flaky.txt']);
    expect(queue).toHaveLength(1); // failure keeps it queued

    // A later flush (connectivity returned) retries it exactly once more.
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await rerenderTimes(rerender, 1);
    expect(uploadCalls).toEqual(['flaky.txt', 'flaky.txt']);
    expect(queue).toHaveLength(0);
  });

  it('does not flush at all while the browser is offline', async () => {
    queue.push(queued('later.txt'));
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    render(<Uploader folderId={null} onUploaded={() => {}} />);
    await act(async () => {});

    expect(uploadCalls).toEqual([]);
    expect(queue).toHaveLength(1);
    spy.mockRestore();
  });
});
