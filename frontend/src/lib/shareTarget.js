// Reads files that the service worker stashed from a Web Share Target POST
// (see public/sw.js → handleShareTarget). Reconstructs real File objects, then
// clears the cache so they're consumed exactly once.
export async function consumeSharedFiles() {
  if (!('caches' in window)) return [];
  try {
    const cache = await caches.open('share-target');
    const keys = await cache.keys();
    const files = [];
    for (const key of keys) {
      const resp = await cache.match(key);
      if (!resp) continue;
      const blob = await resp.blob();
      const name = decodeURIComponent(resp.headers.get('x-filename') || 'shared');
      const type = resp.headers.get('content-type') || blob.type || 'application/octet-stream';
      files.push(new File([blob], name, { type }));
      await cache.delete(key);
    }
    return files;
  } catch {
    return [];
  }
}
