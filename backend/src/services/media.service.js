// Task5 #9/#10 — shared post-upload media pipeline. Faststart remux runs first
// (it rewrites the MinIO object in place; transcoding/transcribing must read
// the final bytes), then HLS renditions and whisper transcription kick off —
// each is gated + queued inside its own service. Fire-and-forget safe.
import { canFaststart, optimizeFileVideo } from './video.service.js';
import { maybeGenerateHls } from './hls.service.js';
import { maybeTranscribe } from './transcribe.service.js';

export function postProcessMedia(fileId, mimeType) {
  const remux = canFaststart(mimeType) ? optimizeFileVideo(fileId) : Promise.resolve();
  remux
    .catch(() => {})
    .then(() => {
      maybeGenerateHls(fileId);
      maybeTranscribe(fileId);
    });
}
