// Offline upload queue ("background sync"-lite). When a file is added while the
// browser is offline, it's stored here in IndexedDB (which can hold File/Blob
// objects directly) and uploaded automatically once connectivity returns. We
// keep the queue at the page level rather than replaying from the service
// worker, because uploads are authenticated (the JWT lives in the page, not the
// SW) and chunked uploads are already resumable on flaky links.
const DB_NAME = 'uploader-outbox';
const STORE = 'queue';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// item: { id, file (File), name, folderId, createdAt }
export async function enqueue(item) {
  const db = await openDb();
  await tx(db, 'readwrite', (s) => s.put(item));
  db.close();
}

export async function allItems() {
  const db = await openDb();
  const items = await tx(db, 'readonly', (s) => s.getAll());
  db.close();
  return items || [];
}

export async function removeItem(id) {
  const db = await openDb();
  await tx(db, 'readwrite', (s) => s.delete(id));
  db.close();
}

export async function countItems() {
  const db = await openDb();
  const n = await tx(db, 'readonly', (s) => s.count());
  db.close();
  return n || 0;
}
