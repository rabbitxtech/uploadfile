// Chunked / resumable upload client. Sequentially uploads parts (PUT raw).
import { api, apiBase } from './client.js';
import { useAuth } from '../store/auth.js';

export async function chunkedUpload(
  file,
  { folderId = null, onProgress, signal, replaceFileId = null } = {},
) {
  const init = await api
    .post('/upload/init', {
      filename: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      folderId,
      replaceFileId,
    })
    .then((r) => r.data);

  const { sessionId, chunkSize } = init;
  const total = Math.max(1, Math.ceil(file.size / chunkSize));
  let uploaded = 0;
  const token = useAuth.getState().token;

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new Error('aborted');
    const start = i * chunkSize;
    const end = Math.min(file.size, start + chunkSize);
    const blob = file.slice(start, end);
    const partNumber = i + 1;

    const resp = await fetch(
      `${apiBase}/upload/${sessionId}/part?part=${partNumber}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: blob,
        signal,
      },
    );
    if (!resp.ok) {
      let serverError = '';
      try {
        const data = await resp.clone().json();
        serverError = data?.error || '';
      } catch {
        /* non-JSON (e.g. nginx 413 HTML) */
      }
      const err = new Error(serverError || `Part ${partNumber} failed (HTTP ${resp.status})`);
      err.serverError = serverError;
      err.status = resp.status;
      throw err;
    }

    uploaded += blob.size;
    onProgress?.({ uploaded, total: file.size, part: partNumber, parts: total });
  }

  const completed = await api
    .post(`/upload/${sessionId}/complete`)
    .then((r) => r.data);
  return completed;
}
