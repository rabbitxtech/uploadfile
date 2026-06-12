import { lazy, Suspense, useEffect, useState } from 'react';
import { X, Download, MessageSquare, Send, Trash2, Play, SkipForward } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FileApi, CommentApi } from '../api/endpoints.js';
import { api, apiBase } from '../api/client.js';
import { useAuth } from '../store/auth.js';
import { formatDate } from '../lib/format.js';
import { usePresence } from '../lib/presence.js';
import VideoPlayer from './VideoPlayer.jsx';
import AudioPlayer from './AudioPlayer.jsx';
// Lazy-loaded so their heavy deps (exifr / marked + highlight.js + dompurify)
// load only when an image or text/code file is actually previewed.
const ImageLightbox = lazy(() => import('./ImageLightbox.jsx'));
const TextPreview = lazy(() => import('./TextPreview.jsx'));

const previewLoading = (
  <div className="p-12 text-center text-sm text-slate-500 dark:text-slate-400">Loading…</div>
);

// Files we can render as markdown/code/plain text (G6), even when the stored
// MIME is application/* rather than text/*.
const TEXTUAL_EXTS = new Set([
  'md', 'markdown', 'txt', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less', 'html', 'htm',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'sql', 'swift', 'dart', 'vue', 'dockerfile', 'makefile', 'env', 'conf',
]);
function isTextual(file) {
  const mime = file.mimeType || '';
  if (mime.startsWith('text/')) return true;
  if (['application/json', 'application/javascript', 'application/xml', 'application/x-yaml'].includes(mime))
    return true;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return TEXTUAL_EXTS.has(ext);
}

const AVATAR_COLORS = [
  'bg-rose-500',
  'bg-orange-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-teal-500',
  'bg-sky-500',
  'bg-indigo-500',
  'bg-violet-500',
  'bg-fuchsia-500',
];

function avatarFor(user) {
  const label = user?.name || user?.email || '?';
  const initials = label
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return { initials: initials || label[0]?.toUpperCase() || '?', color: AVATAR_COLORS[hash % AVATAR_COLORS.length] };
}

function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return formatDate(iso);
}

// Highlight @username mentions in a comment body (I3).
function renderMentions(text) {
  return (text || '').split(/(@[a-zA-Z0-9._-]+)/g).map((part, i) =>
    /^@[a-zA-Z0-9._-]+$/.test(part) ? (
      <span key={i} className="font-medium text-brand-600 dark:text-brand-400">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function CommentsPanel({ fileId, ownerId }) {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const [body, setBody] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['comments', fileId],
    queryFn: () => CommentApi.list(fileId),
  });
  const comments = data?.comments || [];

  const submit = async (e) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBody('');
    try {
      await CommentApi.add(fileId, text);
      qc.invalidateQueries({ queryKey: ['comments', fileId] });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to comment');
      setBody(text);
    }
  };

  const remove = async (c) => {
    try {
      await CommentApi.remove(fileId, c.id);
      qc.invalidateQueries({ queryKey: ['comments', fileId] });
    } catch {
      toast.error('Failed to delete');
    }
  };

  const myAvatar = avatarFor(me);

  return (
    <div className="flex w-80 shrink-0 flex-col border-l border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <MessageSquare className="h-4 w-4 text-brand-600 dark:text-brand-400" />
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Comments</span>
        {comments.length > 0 && (
          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300">
            {comments.length}
          </span>
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-auto px-4 py-4">
        {isLoading && (
          <div className="py-6 text-center text-xs text-slate-400">Loading…</div>
        )}
        {!isLoading && comments.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800">
              <MessageSquare className="h-5 w-5 text-slate-400 dark:text-slate-500" />
            </div>
            <div className="text-sm font-medium text-slate-500 dark:text-slate-400">No comments yet</div>
            <div className="text-xs text-slate-400 dark:text-slate-500">Be the first to comment</div>
          </div>
        )}
        {comments.map((c) => {
          const canDelete = c.userId === me?.id || ownerId === me?.id || me?.role === 'admin';
          const isMine = c.userId === me?.id;
          const av = avatarFor(c.user);
          return (
            <div key={c.id} className="group flex gap-2.5">
              <div
                className={
                  'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ' +
                  av.color
                }
              >
                {av.initials}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {isMine ? 'You' : c.user?.name || c.user?.email}
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-400 dark:text-slate-500">
                    {timeAgo(c.createdAt)}
                  </span>
                  {canDelete && (
                    <button
                      onClick={() => remove(c)}
                      className="ml-auto shrink-0 rounded p-0.5 text-slate-400 opacity-0 transition hover:bg-slate-200 hover:text-red-600 group-hover:opacity-100 dark:hover:bg-slate-700"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="mt-1 rounded-lg rounded-tl-sm bg-white px-3 py-2 text-sm leading-relaxed text-slate-700 shadow-sm ring-1 ring-slate-200/70 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700/60">
                  <span className="whitespace-pre-wrap break-words">{renderMentions(c.body)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <form
        onSubmit={submit}
        className="flex items-center gap-2 border-t border-slate-200 p-3 dark:border-slate-800"
      >
        <div
          className={
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ' +
            myAvatar.color
          }
        >
          {myAvatar.initials}
        </div>
        <input
          className="input rounded-full py-1.5 text-sm"
          placeholder="Add a comment…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <button
          type="submit"
          disabled={!body.trim()}
          className="btn-primary shrink-0 rounded-full px-2.5 py-2"
          title="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}

const AUTOPLAY_SECONDS = 10;

// Convert SubRip (.srt) to WebVTT (browsers only play VTT in <track>).
function srtToVtt(srt) {
  const body = srt
    .replace(/\r+/g, '')
    // 00:00:01,000 --> 00:00:04,000  =>  use dots for ms
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + body;
}

// Guess a language label from a subtitle filename, e.g. "Movie.vi.srt" -> "vi".
function subtitleLabel(videoName, subName) {
  const vBase = videoName.replace(/\.[^.]+$/, '');
  let mid = subName.replace(/\.(srt|vtt)$/i, '');
  if (mid.toLowerCase().startsWith(vBase.toLowerCase())) {
    mid = mid.slice(vBase.length).replace(/^[.\-_ ]+/, '');
  }
  return mid || 'Subtitle';
}

function UpNextOverlay({ next, seconds, onPlay, onCancel }) {
  const pct = ((AUTOPLAY_SECONDS - seconds) / AUTOPLAY_SECONDS) * 100;
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-slate-900/90 p-5 text-slate-100 shadow-2xl">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-brand-400">
          <SkipForward className="h-4 w-4" /> Up next
        </div>
        <div className="mt-2 line-clamp-2 text-base font-semibold">{next.name}</div>
        <div className="mt-1 text-sm text-slate-400">
          Playing in {seconds}s
        </div>
        <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-white/15">
          <div className="h-full bg-brand-500 transition-all duration-1000 ease-linear" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button onClick={onPlay} className="btn-primary flex-1 justify-center">
            <Play className="h-4 w-4" /> Play now
          </button>
          <button
            onClick={onCancel}
            className="rounded-md border border-white/15 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/10"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PreviewModal({ file, onClose, siblings = [], onNavigate }) {
  const me = useAuth((s) => s.user);
  const viewers = usePresence(file?.id); // I4 — who else is viewing this file
  const [inlineUrl, setInlineUrl] = useState(null);

  // Esc closes the modal (but let Esc exit fullscreen first if active).
  useEffect(() => {
    if (!file) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.fullscreenElement) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file, onClose]);
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [error, setError] = useState(null);
  const [showComments, setShowComments] = useState(false);
  const [countdown, setCountdown] = useState(null); // seconds left, or null
  const [subtitles, setSubtitles] = useState([]); // [{ id, label, lang, url }]

  // Image siblings in the folder — drives the lightbox prev/next (G4).
  const imageSiblings = siblings.filter((f) => (f.mimeType || '').startsWith('image/'));

  // Next playable media of the SAME class (video→video, audio→audio) in the
  // folder, after the current file — drives the up-next autoplay for both players.
  const nextVideo = (() => {
    if (!file || !onNavigate) return null;
    const mime = file.mimeType || '';
    const cls = mime.startsWith('video/') ? 'video/' : mime.startsWith('audio/') ? 'audio/' : null;
    if (!cls) return null;
    const list = siblings.filter((f) => (f.mimeType || '').startsWith(cls));
    const idx = list.findIndex((f) => f.id === file.id);
    if (idx === -1) return null;
    return list[idx + 1] || null;
  })();

  // Sibling subtitle files (.srt/.vtt) whose name matches the video's base name,
  // e.g. "Movie.mp4" ↔ "Movie.srt" / "Movie.vi.srt" / "Movie.en.vtt".
  const subtitleSiblings = (() => {
    if (!file || !(file.mimeType || '').startsWith('video/')) return [];
    const base = file.name.replace(/\.[^.]+$/, '').toLowerCase();
    return siblings.filter((f) => {
      const n = (f.name || '').toLowerCase();
      const isSub = n.endsWith('.srt') || n.endsWith('.vtt');
      return isSub && (n.startsWith(base) || base.startsWith(n.replace(/\.(srt|vtt)$/, '')));
    });
  })();

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let createdBlobUrl = null;
    setInlineUrl(null);
    setDownloadUrl(null);
    setError(null);
    setCountdown(null); // reset autoplay when switching files

    const mime = file.mimeType || '';
    const useBlob = mime === 'application/pdf' || isTextual(file);
    const isVideo = mime.startsWith('video/');

    const loadDownload = FileApi.presignedUrl(file.id).then((r) => {
      if (!cancelled) setDownloadUrl(r.url);
    });

    // Video plays through the authenticated /stream endpoint (no raw presigned
    // MinIO URL exposed). streamToken sets an HttpOnly cookie scoped to this
    // file's stream path; the <video> sends it automatically (same-origin), so
    // the URL stays credential-free and unusable when logged out.
    const loadInline = useBlob
      ? api.get(`/files/${file.id}/preview`, { responseType: 'blob' }).then((r) => {
          if (cancelled) return;
          createdBlobUrl = URL.createObjectURL(r.data);
          setInlineUrl(createdBlobUrl);
        })
      : isVideo
      ? FileApi.streamToken(file.id).then(() => {
          if (!cancelled) setInlineUrl(`${apiBase}/files/${file.id}/stream`);
        })
      : FileApi.presignedUrl(file.id, { inline: true }).then((r) => {
          if (!cancelled) setInlineUrl(r.url);
        });

    Promise.all([loadInline, loadDownload]).catch((e) => {
      if (!cancelled) setError(e?.response?.data?.error || e?.message || 'Preview failed');
    });

    return () => {
      cancelled = true;
      if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl);
    };
  }, [file]);

  // Load matching subtitle files for a video and expose them as VTT blob URLs.
  useEffect(() => {
    setSubtitles([]);
    if (!subtitleSiblings.length) return;
    let cancelled = false;
    const created = [];
    Promise.all(
      subtitleSiblings.map(async (sub) => {
        const r = await api.get(`/files/${sub.id}/preview`, { responseType: 'text' });
        const text = typeof r.data === 'string' ? r.data : await r.data.text?.();
        const vtt = sub.name.toLowerCase().endsWith('.srt') ? srtToVtt(text) : text;
        const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
        created.push(url);
        return { id: sub.id, label: subtitleLabel(file.name, sub.name), url };
      }),
    )
      .then((tracks) => {
        if (cancelled) {
          created.forEach((u) => URL.revokeObjectURL(u));
        } else {
          setSubtitles(tracks);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  // Autoplay countdown — when active, tick down once a second and advance at 0.
  useEffect(() => {
    if (countdown == null) return;
    if (countdown <= 0) {
      if (nextVideo) onNavigate?.(nextVideo);
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c == null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, nextVideo, onNavigate]);

  if (!file) return null;
  const mime = file.mimeType || '';

  const onVideoEnded = () => {
    if (nextVideo) setCountdown(AUTOPLAY_SECONDS);
  };
  const cancelAutoplay = () => setCountdown(null);
  const playNext = () => {
    setCountdown(null);
    if (nextVideo) onNavigate?.(nextVideo);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="card flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 p-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="truncate font-medium text-slate-900 dark:text-slate-100">{file.name}</div>
            {(() => {
              const others = viewers.filter((v) => v.id !== me?.id);
              if (!others.length) return null;
              return (
                <div className="flex shrink-0 items-center gap-1" title={`${others.map((o) => o.name || o.email).join(', ')} viewing now`}>
                  <div className="flex -space-x-2">
                    {others.slice(0, 4).map((v) => {
                      const a = avatarFor(v);
                      return (
                        <span
                          key={v.id}
                          className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-white dark:ring-slate-900 ${a.color}`}
                        >
                          {a.initials}
                        </span>
                      );
                    })}
                  </div>
                  {others.length > 4 && (
                    <span className="text-xs text-slate-400">+{others.length - 4}</span>
                  )}
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                </div>
              );
            })()}
          </div>
          <div className="flex items-center gap-2">
            <button
              className={
                'btn-secondary ' + (showComments ? 'bg-slate-100 dark:bg-slate-700' : '')
              }
              onClick={() => setShowComments((x) => !x)}
              title="Comments"
            >
              <MessageSquare className="h-4 w-4" /> Comments
            </button>
            {downloadUrl && (
              <a href={downloadUrl} className="btn-secondary" download>
                <Download className="h-4 w-4" /> Download
              </a>
            )}
            <button
              className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex-1 overflow-auto bg-slate-100 dark:bg-slate-800 p-4">
            {error ? (
              <div className="p-12 text-center text-red-600 dark:text-red-400">{error}</div>
            ) : !inlineUrl ? (
              <div className="p-12 text-center text-slate-500 dark:text-slate-400">Loading...</div>
            ) : mime.startsWith('image/') ? (
              <Suspense fallback={previewLoading}>
                <ImageLightbox
                  file={file}
                  src={inlineUrl}
                  images={imageSiblings}
                  onNavigate={onNavigate}
                />
              </Suspense>
            ) : mime.startsWith('video/') ? (
              <div className="relative">
                <VideoPlayer
                  src={inlineUrl}
                  hlsSrc={
                    file.hlsReady ? `${apiBase}/files/${file.id}/stream/hls/master.m3u8` : undefined
                  }
                  name={file.name}
                  resumeKey={file.id}
                  subtitles={subtitles}
                  onEnded={onVideoEnded}
                />
                {countdown != null && nextVideo && (
                  <UpNextOverlay
                    next={nextVideo}
                    seconds={countdown}
                    onPlay={playNext}
                    onCancel={cancelAutoplay}
                  />
                )}
              </div>
            ) : mime.startsWith('audio/') ? (
              <div className="relative py-8">
                <AudioPlayer
                  src={inlineUrl}
                  name={file.name}
                  resumeKey={file.id}
                  onEnded={onVideoEnded}
                />
                {countdown != null && nextVideo && (
                  <div className="mx-auto mt-3 flex w-full max-w-xl items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 text-slate-700 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
                    <SkipForward className="h-5 w-5 shrink-0 text-brand-500" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium uppercase tracking-wide text-brand-500">Up next · {countdown}s</div>
                      <div className="truncate text-sm font-semibold">{nextVideo.name}</div>
                    </div>
                    <button onClick={playNext} className="btn-primary shrink-0">Play</button>
                    <button onClick={cancelAutoplay} className="btn-secondary shrink-0">Cancel</button>
                  </div>
                )}
              </div>
            ) : mime === 'application/pdf' ? (
              <iframe src={inlineUrl} title={file.name} className="h-[72vh] w-full rounded-lg" />
            ) : isTextual(file) ? (
              <Suspense fallback={previewLoading}>
                <TextPreview file={file} />
              </Suspense>
            ) : (
              <div className="p-12 text-center text-slate-500 dark:text-slate-400">
                No preview available for this file type.
                <br />
                Use the Download button above.
              </div>
            )}
          </div>
          {showComments && <CommentsPanel fileId={file.id} ownerId={file.ownerId} />}
        </div>
      </div>
    </div>
  );
}
