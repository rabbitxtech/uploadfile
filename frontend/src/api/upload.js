// Chunked / resumable upload client. Sequentially uploads parts (PUT raw).
import { api, apiBase } from './client.js';
import { useAuth } from '../store/auth.js';

/**
 * Upload a file in chunks.
 *
 * Pass `resumeSessionId` to continue an interrupted upload: the server is asked
 * which parts it already holds and those are skipped. Without it a fresh
 * session is created. The part route de-duplicates by partNumber, so re-sending
 * a part is safe — resuming is an optimisation, never a correctness requirement.
 */
export async function chunkedUpload(
  file,
  {
    folderId = null,
    onProgress,
    signal,
    replaceFileId = null,
    resumeSessionId = null,
  } = {},
) {
  let sessionId;
  let chunkSize;
  // Part numbers the server already holds; skipped in the loop below.
  let done = new Set();

  if (resumeSessionId) {
    // Best-effort: an expired/completed/foreign session must not strand the
    // upload, so any failure here falls back to starting over.
    try {
      const info = await api.get(`/upload/${resumeSessionId}`).then((r) => r.data);
      if (!info.completed) {
        sessionId = info.sessionId;
        chunkSize = info.chunkSize;
        done = new Set(info.uploaded || []);
      }
    } catch {
      /* fall through to a fresh init */
    }
  }

  if (!sessionId) {
    const init = await api
      .post('/upload/init', {
        filename: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        folderId,
        replaceFileId,
      })
      .then((r) => r.data);
    sessionId = init.sessionId;
    chunkSize = init.chunkSize;
    done = new Set();
  }

  // An empty file has NO parts, not one empty part. S3/MinIO multipart cannot
  // store a zero-byte part, so the backend rejects an empty body outright
  // ("Empty chunk") — clamping this to 1 sent exactly that and made a 0-byte
  // file impossible to upload, since every file goes through this flow.
  const total = Math.ceil(file.size / chunkSize);
  const token = useAuth.getState().token;

  // Count already-held parts as transferred so a resumed upload does not report
  // progress restarting from 0%. Out-of-range numbers (a stale session for a
  // different file) are ignored rather than inflating the total.
  let uploaded = 0;
  for (const part of done) {
    if (part >= 1 && part <= total) {
      const start = (part - 1) * chunkSize;
      uploaded += Math.min(file.size, start + chunkSize) - start;
    }
  }

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) {
      // Carry the session so a paused upload resumes instead of restarting.
      const err = new Error('aborted');
      err.sessionId = sessionId;
      throw err;
    }
    const partNumber = i + 1;
    const start = i * chunkSize;
    const end = Math.min(file.size, start + chunkSize);
    if (done.has(partNumber)) continue;
    const blob = file.slice(start, end);

    let resp;
    try {
      resp = await fetch(`${apiBase}/upload/${sessionId}/part?part=${partNumber}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: blob,
        signal,
      });
    } catch (e) {
      // Network drop or an abort mid-request: both land here, and both are
      // exactly when resuming matters. Tag the session and re-throw.
      e.sessionId = sessionId;
      throw e;
    }
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
      // Lets the caller retry with resumeSessionId instead of re-sending
      // everything that already landed.
      err.sessionId = sessionId;
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
