import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  RotateCcw,
  RotateCw,
  Repeat,
  Gauge,
  Music,
} from 'lucide-react';
import clsx from 'clsx';
import { FileApi } from '../api/endpoints.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function fmt(t) {
  if (!isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Custom audio player. Same proven patterns as VideoPlayer: pointer-driven
// seek-on-release, rAF DOM updates (no re-render during playback), server-side
// resume position (synced across devices).
export default function AudioPlayer({ src, name, onEnded, resumeKey }) {
  const audioRef = useRef(null);
  const fillRef = useRef(null);
  const bufRef = useRef(null);
  const thumbRef = useRef(null);
  const barRef = useRef(null);
  const timeRef = useRef(null);
  const rafRef = useRef(0);
  const seekingRef = useRef(false);
  const pendingRatioRef = useRef(null);

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [showSpeed, setShowSpeed] = useState(false);
  const [resumedFrom, setResumedFrom] = useState(null);

  const paint = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    const dur = a.duration || 0;
    let buf = 0;
    if (a.buffered.length) buf = (a.buffered.end(a.buffered.length - 1) / dur) * 100;
    if (bufRef.current) bufRef.current.style.width = `${buf}%`;
    if (seekingRef.current) return;
    const pct = dur ? (a.currentTime / dur) * 100 : 0;
    if (fillRef.current) fillRef.current.style.width = `${pct}%`;
    if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
    if (timeRef.current) timeRef.current.textContent = `${fmt(a.currentTime)} / ${fmt(dur)}`;
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

  // Resume position (server-synced).
  const saveProgress = useCallback(() => {
    const a = audioRef.current;
    if (!a || !resumeKey || !a.duration || !a.currentTime) return;
    if (a.currentTime <= 3) return;
    FileApi.saveProgress(resumeKey, Math.floor(a.currentTime), Math.floor(a.duration)).catch(() => {});
  }, [resumeKey]);

  useEffect(() => {
    const id = setInterval(saveProgress, 8000);
    return () => {
      clearInterval(id);
      saveProgress();
    };
  }, [saveProgress]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play();
    else a.pause();
  }, []);

  const skip = useCallback(
    (delta) => {
      const a = audioRef.current;
      if (!a) return;
      a.currentTime = Math.min(Math.max(0, a.currentTime + delta), a.duration || 0);
      paint();
    },
    [paint],
  );

  const setSpeed = (r) => {
    const a = audioRef.current;
    if (a) a.playbackRate = r;
    setRate(r);
    setShowSpeed(false);
  };
  const toggleLoop = () => {
    const a = audioRef.current;
    if (!a) return;
    a.loop = !a.loop;
    setLoop(a.loop);
  };
  const toggleMute = () => {
    const a = audioRef.current;
    if (a) a.muted = !a.muted;
  };

  const ratioFromClientX = useCallback((clientX) => {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);
  const paintRatio = useCallback((ratio) => {
    const a = audioRef.current;
    const dur = a?.duration || 0;
    const pct = ratio * 100;
    if (fillRef.current) fillRef.current.style.width = `${pct}%`;
    if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
    if (timeRef.current) timeRef.current.textContent = `${fmt(ratio * dur)} / ${fmt(dur)}`;
  }, []);
  const commitSeek = useCallback((ratio) => {
    const a = audioRef.current;
    if (a && a.duration) a.currentTime = ratio * a.duration;
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
    <div className="mx-auto w-full max-w-xl rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-violet-500 text-white">
          <Music className="h-7 w-7" />
        </div>
        <div className="min-w-0">
          <div className="truncate font-medium text-slate-900 dark:text-slate-100">{name}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">Audio</div>
        </div>
      </div>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        src={src}
        preload="auto"
        onPlay={() => {
          setPlaying(true);
          startLoop();
        }}
        onPause={() => {
          setPlaying(false);
          stopLoop();
          saveProgress();
        }}
        onEnded={() => {
          setPlaying(false);
          stopLoop();
          if (resumeKey) FileApi.clearProgress(resumeKey).catch(() => {});
          onEnded?.();
        }}
        onLoadedMetadata={() => {
          paint();
          const a = audioRef.current;
          if (!a || !resumeKey) return;
          FileApi.getProgress(resumeKey)
            .then(({ position }) => {
              const saved = Number(position) || 0;
              if (a && saved > 3 && saved < (a.duration || Infinity) - 10) {
                a.currentTime = saved;
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
      />

      {resumedFrom != null && (
        <div className="mb-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <RotateCcw className="h-3.5 w-3.5 text-brand-500" />
          Resumed from {fmt(resumedFrom)}
          <button
            onClick={() => {
              const a = audioRef.current;
              if (a) a.currentTime = 0;
              if (resumeKey) FileApi.clearProgress(resumeKey).catch(() => {});
              setResumedFrom(null);
              paint();
            }}
            className="font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            Start over
          </button>
        </div>
      )}

      {/* Seek bar */}
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
        <div className="seek-track pointer-events-none absolute left-0 right-0 h-1.5 rounded-full bg-slate-200 transition-[height] dark:bg-slate-700">
          <div ref={bufRef} className="h-full rounded-full bg-slate-300 dark:bg-slate-600" style={{ width: '0%' }} />
          <div ref={fillRef} className="absolute top-0 h-full rounded-full bg-brand-500" style={{ width: '0%' }} />
        </div>
        <div
          ref={thumbRef}
          className="seek-thumb pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand-500 bg-white shadow-md transition-transform"
          style={{ left: '0%' }}
        />
      </div>

      <div className="mt-2 flex items-center gap-1 text-slate-600 dark:text-slate-300">
        <button onClick={togglePlay} className="rounded-full bg-brand-600 p-2 text-white hover:bg-brand-500" title="Play/Pause">
          {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 translate-x-0.5" />}
        </button>
        <button onClick={() => skip(-10)} className="rounded p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800" title="Back 10s">
          <RotateCcw className="h-4 w-4" />
        </button>
        <button onClick={() => skip(10)} className="rounded p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800" title="Forward 10s">
          <RotateCw className="h-4 w-4" />
        </button>
        <button onClick={toggleMute} className="rounded p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800" title="Mute">
          {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={muted ? 0 : volume}
          onChange={(e) => {
            const a = audioRef.current;
            if (a) {
              a.volume = Number(e.target.value);
              a.muted = Number(e.target.value) === 0;
            }
          }}
          className="hidden w-20 cursor-pointer accent-brand-500 sm:block"
          aria-label="Volume"
        />
        <span ref={timeRef} className="ml-1 text-xs tabular-nums text-slate-500 dark:text-slate-400">
          0:00 / 0:00
        </span>

        <div className="ml-auto flex items-center gap-1">
          <div className="relative">
            <button
              onClick={() => setShowSpeed((x) => !x)}
              className="flex items-center gap-1 rounded p-1.5 text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
              title="Speed"
            >
              <Gauge className="h-4 w-4" /> {rate}x
            </button>
            {showSpeed && (
              <div className="absolute bottom-9 right-0 z-20 w-20 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-800">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setSpeed(s)}
                    className={clsx(
                      'block w-full px-3 py-1 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-700',
                      s === rate && 'text-brand-500',
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
            className={clsx('rounded p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800', loop && 'text-brand-500')}
            title="Loop"
          >
            <Repeat className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
