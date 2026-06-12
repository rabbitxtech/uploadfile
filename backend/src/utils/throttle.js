// Task 15 — bandwidth throttle. A pass-through Transform that releases at most
// `bytesPerSec` per second, smoothing data into ~10 slices/sec so a download
// can't saturate the uplink. Pure Node (no extra dependency).
//
// It slices large chunks and paces them with setTimeout; backpressure from the
// destination still applies normally. `kbps <= 0` callers should skip this and
// pipe directly (see makeThrottle).
import { Transform } from 'node:stream';

const TICKS_PER_SEC = 10; // release a budget slice 10×/sec for smooth pacing

function throttleStream(bytesPerSec) {
  const sliceBytes = Math.max(1, Math.floor(bytesPerSec / TICKS_PER_SEC));
  const sliceMs = 1000 / TICKS_PER_SEC;

  return new Transform({
    transform(chunk, _enc, cb) {
      let offset = 0;
      const pump = () => {
        if (offset >= chunk.length) return cb();
        const end = Math.min(offset + sliceBytes, chunk.length);
        this.push(chunk.subarray(offset, end));
        offset = end;
        if (offset >= chunk.length) cb();
        else setTimeout(pump, sliceMs);
      };
      pump();
    },
  });
}

// Returns a throttle Transform for `kbps` KB/s, or null when throttling is off
// (kbps <= 0) so callers can `pipe` directly without an extra hop.
export function makeThrottle(kbps) {
  if (!kbps || kbps <= 0) return null;
  return throttleStream(kbps * 1024);
}
