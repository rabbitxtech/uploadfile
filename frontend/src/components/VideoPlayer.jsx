import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  PictureInPicture2,
  Repeat,
  RotateCcw,
  RotateCw,
  Camera,
  Gauge,
  Subtitles,
} from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { FileApi } from '../api/endpoints.js';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function fmt(t) {
  if (!isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Custom video player with its own control bar (skip ±10s, speed, loop, PiP,
// fullscreen, frame screenshot) and keyboard shortcuts. The frequently-updating
// bits (progress fill, buffered fill, time label, thumb) are written straight
// to the DOM via refs inside a requestAnimationFrame loop — not React state —
// so playback never triggers a re-render. The seek bar is pointer-driven with
// seek-on-release (no actual seeking until the pointer is let go) so scrubbing
// doesn't fire a burst of overlapping seeks.
// resumeKey is the file id; watch progress is stored server-side (synced across
// devices) via FileApi, keyed to the current user.
export default function VideoPlayer({ src, name, onEnded, resumeKey, subtitles = [] }) {
  const wrapRef = useRef(null);
  const videoRef = useRef(null);
  const fillRef = useRef(null);
  const bufRef = useRef(null);
  const thumbRef = useRef(null);
  const barRef = useRef(null);
  const timeRef = useRef(null);
  const rafRef = useRef(0);
  const seekingRef = useRef(false);
  const pendingRatioRef = useRef(null);
  const hideTimer = useRef(0);
  const wakeRef = useRef(() => {});

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [showSpeed, setShowSpeed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [resumedFrom, setResumedFrom] = useState(null); // seconds, shows a banner
  const [activeSub, setActiveSub] = useState(-1); // -1 = off
  const [showSubs, setShowSubs] = useState(false);

  // On touch devices use the browser's NATIVE controls: the custom control bar's
  // div-based fullscreen isn't supported on iOS Safari (only <video> fullscreen
  // via webkitEnterFullscreen is), and the pointer-driven seek bar is awkward to
  // scrub on a phone. Native controls give working seek + fullscreen for free.
  const [isTouch] = useState(
    () =>
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(pointer: coarse)')?.matches || 'ontouchstart' in window),
  );

  const paint = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const dur = v.duration || 0;
    let buf = 0;
    if (v.buffered.length) buf = (v.buffered.end(v.buffered.length - 1) / dur) * 100;
    if (bufRef.current) bufRef.current.style.width = `${buf}%`;
    if (seekingRef.current) return; // pointer owns the scrubber while dragging
    const pct = dur ? (v.currentTime / dur) * 100 : 0;
    if (fillRef.current) fillRef.current.style.width = `${pct}%`;
    if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
    if (timeRef.current) timeRef.current.textContent = `${fmt(v.currentTime)} / ${fmt(dur)}`;
  }, []);

  const loop_paint = useCallback(() => {
    paint();
    rafRef.current = requestAnimationFrame(loop_paint);
  }, [paint]);
  const startLoop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(loop_paint);
  }, [loop_paint]);
  const stopLoop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    paint();
  }, [paint]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // Resume-watching: persist the current position to the SERVER (synced across
  // devices) and restore it next time this file is opened by the same user.
  const saveProgress = useCallback(() => {
    const v = videoRef.current;
    if (!v || !resumeKey || !v.duration || !v.currentTime) return;
    const position = Math.floor(v.currentTime);
    const duration = Math.floor(v.duration);
    if (position <= 3) return; // too early to bother
    FileApi.saveProgress(resumeKey, position, duration).catch(() => {});
  }, [resumeKey]);

  // Save periodically while open + once on unmount / when the file changes.
  useEffect(() => {
    const id = setInterval(saveProgress, 8000);
    return () => {
      clearInterval(id);
      saveProgress();
    };
  }, [saveProgress]);

  // Reset the active subtitle when the track list changes (new video).
  useEffect(() => {
    setActiveSub(-1);
  }, [subtitles]);

  // Apply the selected subtitle to the native text tracks.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const tracks = v.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = i === activeSub ? 'showing' : 'disabled';
    }
  }, [activeSub, subtitles]);

  // Track fullscreen state. Only this player triggers fullscreen in the preview
  // modal, so any fullscreen element means we're the one.
  useEffect(() => {
    const onFs = () =>
      setIsFullscreen(!!(document.fullscreenElement || document.webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('webkitfullscreenchange', onFs);
    };
  }, []);

  // Auto-hide controls only while in fullscreen. The hide/show is done by
  // toggling a CSS class directly on the wrapper element (no React state) so it
  // can never get out of sync with a re-render, and listeners are attached to
  // both `document` and the fullscreen element for reliability.
  useEffect(() => {
    const el = wrapRef.current;
    if (!isFullscreen || !el) {
      clearTimeout(hideTimer.current);
      el?.classList.remove('controls-hidden');
      wakeRef.current = () => {};
      return;
    }
    const wake = () => {
      el.classList.remove('controls-hidden');
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => {
        if (!videoRef.current?.paused) el.classList.add('controls-hidden');
      }, 2500);
    };
    wakeRef.current = wake;
    wake();
    const targets = [document, el];
    const evts = ['pointermove', 'pointerdown', 'touchstart', 'keydown'];
    targets.forEach((t) => evts.forEach((e) => t.addEventListener(e, wake, true)));
    return () => {
      targets.forEach((t) => evts.forEach((e) => t.removeEventListener(e, wake, true)));
      clearTimeout(hideTimer.current);
      el.classList.remove('controls-hidden');
      wakeRef.current = () => {};
    };
  }, [isFullscreen]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, []);

  const skip = useCallback(
    (delta) => {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = Math.min(Math.max(0, v.currentTime + delta), v.duration || 0);
      paint();
    },
    [paint],
  );

  const changeVolume = useCallback((delta) => {
    const v = videoRef.current;
    if (!v) return;
    const nv = Math.min(1, Math.max(0, v.volume + delta));
    v.volume = nv;
    v.muted = nv === 0;
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (v) v.muted = !v.muted;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current;
    const v = videoRef.current;
    if (!el) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      return;
    }
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen(); // Safari (desktop)
    else if (v?.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iOS: only the <video> can go FS
  }, []);

  const togglePip = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      /* PiP unsupported / blocked */
    }
  }, []);

  const setSpeed = (r) => {
    const v = videoRef.current;
    if (v) v.playbackRate = r;
    setRate(r);
    setShowSpeed(false);
  };

  const toggleLoop = () => {
    const v = videoRef.current;
    if (!v) return;
    v.loop = !v.loop;
    setLoop(v.loop);
  };

  const screenshot = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          toast.error('Screenshot not available for this video');
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const base = (name || 'frame').replace(/\.[^.]+$/, '');
        a.href = url;
        a.download = `${base}-${Math.floor(v.currentTime)}s.png`;
        a.click();
        URL.revokeObjectURL(url);
      }, 'image/png');
    } catch {
      toast.error('Screenshot blocked (cross-origin video)');
    }
  };

  useEffect(() => {
    const onKey = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          skip(-10);
          break;
        case 'ArrowRight':
          skip(10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          changeVolume(0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          changeVolume(-0.1);
          break;
        case 'm':
          toggleMute();
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'l':
          toggleLoop();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, skip, changeVolume, toggleMute, toggleFullscreen]);

  // Pointer-driven seek bar with seek-on-release.
  const ratioFromClientX = useCallback((clientX) => {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const paintRatio = useCallback((ratio) => {
    const v = videoRef.current;
    const dur = v?.duration || 0;
    const pct = ratio * 100;
    if (fillRef.current) fillRef.current.style.width = `${pct}%`;
    if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
    if (timeRef.current) timeRef.current.textContent = `${fmt(ratio * dur)} / ${fmt(dur)}`;
  }, []);

  const commitSeek = useCallback((ratio) => {
    const v = videoRef.current;
    if (v && v.duration) v.currentTime = ratio * v.duration;
  }, []);

  const onBarPointerDown = (e) => {
    e.preventDefault();
    seekingRef.current = true;
    e.currentTarget.classList.add('seeking');
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const ratio = ratioFromClientX(e.clientX);
    pendingRatioRef.current = ratio;
    paintRatio(ratio);
  };
  const onBarPointerMove = (e) => {
    if (!seekingRef.current) return;
    const ratio = ratioFromClientX(e.clientX);
    pendingRatioRef.current = ratio;
    paintRatio(ratio);
  };
  const onBarPointerUp = (e) => {
    if (!seekingRef.current) return;
    e.currentTarget.classList.remove('seeking');
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const ratio = pendingRatioRef.current;
    pendingRatioRef.current = null;
    seekingRef.current = false;
    if (ratio != null) commitSeek(ratio);
  };

  return (
    <div
      ref={wrapRef}
      className="video-player group relative mx-auto flex max-h-[72vh] w-full max-w-3xl flex-col rounded-lg bg-black"
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        src={src}
        preload="auto"
        playsInline
        controls={isTouch}
        controlsList="nodownload noremoteplayback"
        onContextMenu={(e) => e.preventDefault()}
        className={clsx(
          'video-player-media relative z-0 w-full bg-black object-contain',
          isTouch ? 'max-h-[72vh] rounded-lg' : 'max-h-[64vh] rounded-t-lg',
        )}
        onClick={isTouch ? undefined : togglePlay}
        onPlay={() => {
          setPlaying(true);
          startLoop();
          wakeRef.current(); // show controls then start the idle timer
        }}
        onPause={() => {
          setPlaying(false);
          stopLoop();
          saveProgress();
          clearTimeout(hideTimer.current);
          wrapRef.current?.classList.remove('controls-hidden'); // always visible while paused
        }}
        onEnded={() => {
          setPlaying(false);
          stopLoop();
          wrapRef.current?.classList.remove('controls-hidden');
          if (resumeKey) FileApi.clearProgress(resumeKey).catch(() => {});
          onEnded?.();
        }}
        onLoadedMetadata={() => {
          paint();
          const v = videoRef.current;
          if (!v || !resumeKey) return;
          // Fetch this user's saved position from the server and resume.
          FileApi.getProgress(resumeKey)
            .then(({ position }) => {
              const vid = videoRef.current;
              if (!vid) return;
              const saved = Number(position) || 0;
              if (saved > 3 && saved < (vid.duration || Infinity) - 10) {
                vid.currentTime = saved;
                paint();
                setResumedFrom(saved);
                setTimeout(() => setResumedFrom(null), 8000);
              }
            })
            .catch(() => {});
        }}
        onProgress={paint}
        onSeeked={() => {
          seekingRef.current = false;
          paint();
        }}
        onVolumeChange={(e) => {
          setVolume(e.target.volume);
          setMuted(e.target.muted);
        }}
      >
        {subtitles.map((s) => (
          <track key={s.id} kind="subtitles" src={s.url} label={s.label} />
        ))}
      </video>

      {resumedFrom != null && (
        <div className="pointer-events-auto absolute left-3 top-3 z-30 flex transform-gpu items-center gap-2 rounded-md bg-black/85 px-3 py-2 text-sm text-slate-100 shadow-xl ring-1 ring-white/10 backdrop-blur-sm animate-[fadeIn_120ms_ease-out]">
          <RotateCcw className="h-3.5 w-3.5 text-brand-400" />
          <span>Resumed from {fmt(resumedFrom)}</span>
          <button
            onClick={() => {
              const v = videoRef.current;
              if (v) v.currentTime = 0;
              if (resumeKey) FileApi.clearProgress(resumeKey).catch(() => {});
              setResumedFrom(null);
              paint();
            }}
            className="font-medium text-brand-400 hover:underline"
          >
            Start over
          </button>
        </div>
      )}

      {!isTouch && (
      <div className="video-player-bar flex flex-col gap-1 rounded-b-lg bg-slate-900 px-3 py-2 text-slate-200 transition-opacity duration-300">

        <div
          ref={barRef}
          onPointerDown={onBarPointerDown}
          onPointerMove={onBarPointerMove}
          onPointerUp={onBarPointerUp}
          className="seek-bar group/seek relative flex h-5 cursor-pointer touch-none select-none items-center"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="seek-track pointer-events-none absolute left-0 right-0 h-1.5 rounded-full bg-slate-700 transition-[height]">
            <div ref={bufRef} className="h-full rounded-full bg-slate-600" style={{ width: '0%' }} />
            <div
              ref={fillRef}
              className="absolute top-0 h-full rounded-full bg-brand-500"
              style={{ width: '0%' }}
            />
          </div>
          <div
            ref={thumbRef}
            className="seek-thumb pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand-500 bg-white shadow-md shadow-black/40 transition-transform"
            style={{ left: '0%' }}
          />
        </div>

        <div className="flex items-center gap-1">
          <button onClick={togglePlay} className="rounded p-1.5 hover:bg-white/10" title="Play/Pause (Space)">
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <button onClick={() => skip(-10)} className="rounded p-1.5 hover:bg-white/10" title="Back 10s (←)">
            <RotateCcw className="h-4 w-4" />
          </button>
          <button onClick={() => skip(10)} className="rounded p-1.5 hover:bg-white/10" title="Forward 10s (→)">
            <RotateCw className="h-4 w-4" />
          </button>

          <button onClick={toggleMute} className="rounded p-1.5 hover:bg-white/10" title="Mute (m)">
            {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={muted ? 0 : volume}
            onChange={(e) => {
              const v = videoRef.current;
              if (v) {
                v.volume = Number(e.target.value);
                v.muted = Number(e.target.value) === 0;
              }
            }}
            className="hidden w-20 cursor-pointer accent-brand-500 sm:block"
            aria-label="Volume"
          />

          <span ref={timeRef} className="ml-1 text-xs tabular-nums text-slate-400">
            0:00 / 0:00
          </span>

          <div className="ml-auto flex items-center gap-1">
            {subtitles.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowSubs((x) => !x)}
                  className={clsx(
                    'rounded p-1.5 hover:bg-white/10',
                    activeSub >= 0 && 'text-brand-400',
                  )}
                  title="Subtitles"
                >
                  <Subtitles className="h-4 w-4" />
                </button>
                {showSubs && (
                  <div className="absolute bottom-9 right-0 z-20 w-40 overflow-hidden rounded-md border border-slate-700 bg-slate-800 py-1 shadow-xl">
                    <button
                      onClick={() => {
                        setActiveSub(-1);
                        setShowSubs(false);
                      }}
                      className={clsx(
                        'block w-full px-3 py-1 text-left text-xs hover:bg-white/10',
                        activeSub === -1 && 'text-brand-400',
                      )}
                    >
                      Off
                    </button>
                    {subtitles.map((s, i) => (
                      <button
                        key={s.id}
                        onClick={() => {
                          setActiveSub(i);
                          setShowSubs(false);
                        }}
                        className={clsx(
                          'block w-full truncate px-3 py-1 text-left text-xs hover:bg-white/10',
                          activeSub === i && 'text-brand-400',
                        )}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="relative">
              <button
                onClick={() => setShowSpeed((x) => !x)}
                className="flex items-center gap-1 rounded p-1.5 text-xs hover:bg-white/10"
                title="Playback speed"
              >
                <Gauge className="h-4 w-4" /> {rate}x
              </button>
              {showSpeed && (
                <div className="absolute bottom-9 right-0 z-20 w-20 overflow-hidden rounded-md border border-slate-700 bg-slate-800 py-1 shadow-xl">
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setSpeed(s)}
                      className={clsx(
                        'block w-full px-3 py-1 text-left text-xs hover:bg-white/10',
                        s === rate && 'text-brand-400',
                      )}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={toggleLoop}
              className={clsx('rounded p-1.5 hover:bg-white/10', loop && 'text-brand-400')}
              title="Loop (l)"
            >
              <Repeat className="h-4 w-4" />
            </button>
            <button onClick={screenshot} className="rounded p-1.5 hover:bg-white/10" title="Screenshot frame">
              <Camera className="h-4 w-4" />
            </button>
            <button onClick={togglePip} className="rounded p-1.5 hover:bg-white/10" title="Picture-in-Picture">
              <PictureInPicture2 className="h-4 w-4" />
            </button>
            <button onClick={toggleFullscreen} className="rounded p-1.5 hover:bg-white/10" title="Fullscreen (f)">
              <Maximize className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
