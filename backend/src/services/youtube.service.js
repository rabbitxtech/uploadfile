// Video import via the `yt-dlp` CLI (installed in the Docker image). yt-dlp
// extracts the real media stream from a watch page (a plain HTTP fetch would
// only get the HTML), merging best video+audio with ffmpeg. No quality or
// duration cap — best available is downloaded.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
// Safety net so a stuck process can't run forever (NOT a duration limit on the
// video itself — long videos just need more time). Override via env.
const DOWNLOAD_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 2 * 60 * 60 * 1000); // 2h

// **Curated allowlist of reputable, mainstream platforms** — intentionally NOT
// "every site yt-dlp supports", so this stays an import tool for legitimate
// sources (your own uploads / officially-distributed / public-domain / CC
// content) rather than a general ripper for piracy sites. Matched by base
// domain (covers subdomains like www./m./player.). Extend with the
// comma-separated `VIDEO_IMPORT_HOSTS` env (e.g. a company video portal).
const BASE_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'dailymotion.com',
  'dai.ly',
  'ted.com',
  'archive.org', // Internet Archive (public domain / CC)
  'wikimedia.org', // Wikimedia Commons (free media)
  'soundcloud.com', // audio
  'twitter.com',
  'x.com',
  'facebook.com',
  'fb.watch',
  'instagram.com',
  'reddit.com',
  'twitch.tv',
];

const ALLOWED_DOMAINS = [
  ...BASE_DOMAINS,
  ...(process.env.VIDEO_IMPORT_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
];

// Human-readable list for the "unsupported source" error message.
export const SUPPORTED_SOURCES =
  'YouTube, Vimeo, Dailymotion, TED, Internet Archive, Wikimedia, SoundCloud, X/Twitter, Facebook, Instagram, Reddit, Twitch';

const EXT_MIME = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
};

function hostAllowed(hostname) {
  const h = hostname.toLowerCase();
  return ALLOWED_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

// True if the URL is http(s) and on the curated allowlist of legit sources.
export function isAllowedSource(raw) {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return false;
    return hostAllowed(u.hostname);
  } catch {
    return false;
  }
}

export function mimeForExt(ext) {
  return EXT_MIME[(ext || '').toLowerCase()] || 'application/octet-stream';
}

const PROGRESS_MARKER = '@@DLP@@';
const PROGRESS_THROTTLE_MS = 400;

// Download a YouTube URL into a fresh temp directory. Returns
// { filePath, name, ext, size, cleanup }. The URL is passed to spawn as an
// argv element (never interpolated into a shell) to avoid command injection.
// `onEvent(evt)` receives live progress: { type:'progress', percent, speed, eta }
// and { type:'status', status:'downloading'|'merging' }.
export function downloadYoutube(url, onEvent = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-'));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});
  const outTmpl = path.join(dir, '%(title).180B [%(id)s].%(ext)s');

  const args = [
    // YouTube now requires solving JS signature challenges; yt-dlp needs a JS
    // runtime for it (otherwise it falls back to a limited client and many
    // videos fail with "This video is not available"). The image is node:20, so
    // Node is always on PATH — point yt-dlp at it.
    '--js-runtimes',
    process.env.YTDLP_JS_RUNTIME || 'node',
    '--no-playlist',
    // Emit progress on its own line (not \r) in a machine-readable template so
    // the route can stream it to the browser.
    '--newline',
    '--progress-template',
    `download:${PROGRESS_MARKER} %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s`,
    '--no-warnings',
    '--restrict-filenames', // ASCII-safe, no spaces/special chars
    '-f',
    process.env.YTDLP_FORMAT || 'bv*+ba/b', // best video + best audio, else best single stream
    // Bias the picker toward broadly-playable codecs: H.264 video + AAC audio.
    // YouTube's "best" is often AV1/VP9 video + Opus audio, which Chrome desktop
    // plays but iOS Safari / most mobile browsers CANNOT decode in <video> — the
    // imported file then "won't play" on phones. Sorting vcodec:h264 first makes
    // yt-dlp prefer the highest H.264 rendition (≤1080p on YT) and only fall back
    // to AV1/VP9 when no H.264 exists; acodec:aac avoids Opus-in-MP4. Override the
    // whole sort via YTDLP_FORMAT_SORT (e.g. "res,vcodec:av1" for max quality).
    '-S',
    process.env.YTDLP_FORMAT_SORT || 'vcodec:h264,acodec:aac,res,fps',
    '--merge-output-format',
    'mp4',
    '-o',
    outTmpl,
    url,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, args, { windowsHide: true });
    let stderr = '';
    let lastProgressAt = 0;

    const handleLine = (raw) => {
      const l = raw.trim();
      if (!l) return;
      if (l.startsWith(PROGRESS_MARKER)) {
        const [percent, speed, eta] = l
          .slice(PROGRESS_MARKER.length)
          .trim()
          .split('|')
          .map((s) => (s || '').trim());
        // Throttle the flood of updates, but always let 100% through.
        const now = Date.now();
        if (now - lastProgressAt >= PROGRESS_THROTTLE_MS || /100(\.0+)?%/.test(percent)) {
          lastProgressAt = now;
          onEvent({ type: 'progress', percent, speed, eta });
        }
      } else if (/^\[Merger\]/.test(l) || /Merging formats/.test(l)) {
        onEvent({ type: 'status', status: 'merging' });
      } else if (/^\[download\] Destination:/.test(l)) {
        onEvent({ type: 'status', status: 'downloading' });
      }
    };

    let outBuf = '';
    let errBuf = '';
    const pump = (chunk, isErr) => {
      const text = chunk.toString();
      if (isErr) stderr += text;
      let buf = (isErr ? errBuf : outBuf) + text;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
      if (isErr) errBuf = buf;
      else outBuf = buf;
    };

    const timer = setTimeout(() => child.kill('SIGKILL'), DOWNLOAD_TIMEOUT_MS);
    child.stdout.on('data', (d) => pump(d, false));
    child.stderr.on('data', (d) => pump(d, true));
    child.on('error', (e) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(e.code === 'ENOENT' ? 'yt-dlp is not installed' : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        cleanup();
        const last = stderr.trim().split('\n').filter(Boolean).pop();
        return reject(new Error(last || `yt-dlp exited with code ${code}`));
      }
      // Pick the produced media file (largest non-temp file in the dir; merge
      // leaves a single final container after deleting fragments).
      let files;
      try {
        files = fs
          .readdirSync(dir)
          .filter((f) => !/\.(part|ytdl|temp|tmp|frag\d*)$/i.test(f))
          .map((f) => {
            const p = path.join(dir, f);
            return { p, name: f, size: fs.statSync(p).size };
          })
          .sort((a, b) => b.size - a.size);
      } catch (e) {
        cleanup();
        return reject(new Error('Could not read downloaded file'));
      }
      const picked = files[0];
      if (!picked || !picked.size) {
        cleanup();
        return reject(new Error('Download produced no file'));
      }
      const ext = picked.name.includes('.') ? picked.name.split('.').pop() : 'mp4';
      resolve({ filePath: picked.p, name: picked.name, ext, size: picked.size, cleanup });
    });
  });
}
