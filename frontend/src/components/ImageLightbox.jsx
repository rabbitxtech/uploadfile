import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ZoomIn,
  ZoomOut,
  RotateCw,
  Maximize2,
  Minimize2,
  Expand,
  ChevronLeft,
  ChevronRight,
  Info,
  MapPin,
} from 'lucide-react';
import exifr from 'exifr';
import { api } from '../api/client.js';
import { formatBytes } from '../lib/format.js';

function exifRows(meta) {
  if (!meta) return [];
  const rows = [];
  const push = (label, val) => val != null && val !== '' && rows.push([label, String(val)]);
  const dt = meta.DateTimeOriginal || meta.CreateDate || meta.ModifyDate;
  if (dt) push('Taken', dt instanceof Date ? dt.toLocaleString() : dt);
  push('Camera', [meta.Make, meta.Model].filter(Boolean).join(' '));
  push('Lens', meta.LensModel || meta.Lens);
  if (meta.ExifImageWidth && meta.ExifImageHeight)
    push('Dimensions', `${meta.ExifImageWidth} × ${meta.ExifImageHeight}`);
  push('Focal length', meta.FocalLength && `${meta.FocalLength}mm`);
  push('Aperture', meta.FNumber && `ƒ/${meta.FNumber}`);
  push('Shutter', meta.ExposureTime && (meta.ExposureTime < 1 ? `1/${Math.round(1 / meta.ExposureTime)}s` : `${meta.ExposureTime}s`));
  push('ISO', meta.ISO);
  push('Software', meta.Software);
  return rows;
}

export default function ImageLightbox({ file, src, images = [], onNavigate }) {
  const [scale, setScale] = useState(1);
  const [rot, setRot] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showInfo, setShowInfo] = useState(false);
  const [exif, setExif] = useState(null);
  const [exifLoaded, setExifLoaded] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const dragRef = useRef(null);
  const containerRef = useRef(null);

  const idx = images.findIndex((f) => f.id === file.id);
  const prev = idx > 0 ? images[idx - 1] : null;
  const next = idx !== -1 && idx < images.length - 1 ? images[idx + 1] : null;

  // Reset view when the image changes.
  useEffect(() => {
    setScale(1);
    setRot(0);
    setPan({ x: 0, y: 0 });
    setExif(null);
    setExifLoaded(false);
  }, [file.id]);

  // Track native fullscreen state (Esc / F11 / our button).
  useEffect(() => {
    const onFs = () => setIsFs(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      containerRef.current?.requestFullscreen?.();
    }
  }, []);

  // Load EXIF lazily from the same-origin preview bytes (avoids MinIO CORS).
  useEffect(() => {
    if (!showInfo || exifLoaded) return;
    let cancelled = false;
    setExifLoaded(true);
    api
      .get(`/files/${file.id}/preview`, { responseType: 'arraybuffer' })
      .then((r) => exifr.parse(r.data, { gps: true }).catch(() => null))
      .then((meta) => !cancelled && setExif(meta || {}))
      .catch(() => !cancelled && setExif({}));
    return () => {
      cancelled = true;
    };
  }, [showInfo, exifLoaded, file.id]);

  const clampScale = (v) => Math.min(8, Math.max(1, +v.toFixed(2)));
  const zoom = useCallback((delta) => {
    setScale((s) => {
      const ns = clampScale(s + delta);
      if (ns === 1) setPan({ x: 0, y: 0 }); // recenter when back to fit
      return ns;
    });
  }, []);
  const reset = () => {
    setScale(1);
    setRot(0);
    setPan({ x: 0, y: 0 });
  };

  const onWheel = (e) => {
    e.preventDefault();
    zoom(e.deltaY < 0 ? 0.25 : -0.25);
  };

  // Pan only when dragging on the image itself, so toolbar clicks keep working
  // even while zoomed (otherwise pointer capture on the stage swallows them).
  const onPointerDown = (e) => {
    if (scale <= 1 || e.target.tagName !== 'IMG') return;
    dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!dragRef.current) return;
    setPan({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y });
  };
  const onPointerUp = (e) => {
    if (dragRef.current) e.currentTarget.releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  };

  // Keyboard: arrows navigate, +/- zoom, 0 reset, f fullscreen.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowLeft' && prev && scale === 1) onNavigate?.(prev);
      else if (e.key === 'ArrowRight' && next && scale === 1) onNavigate?.(next);
      else if (e.key === '+' || e.key === '=') zoom(0.25);
      else if (e.key === '-') zoom(-0.25);
      else if (e.key === '0') reset();
      else if (e.key === 'f') toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next, onNavigate, zoom, scale, toggleFullscreen]);

  const rows = exifRows(exif);
  const gps =
    exif && exif.latitude != null && exif.longitude != null
      ? { lat: exif.latitude, lng: exif.longitude }
      : null;

  return (
    <div
      ref={containerRef}
      className={
        'relative flex w-full select-none overflow-hidden rounded-lg bg-slate-900/90 ' +
        (isFs ? 'h-screen rounded-none' : 'h-[72vh]')
      }
    >
      {/* Stage */}
      <div
        className="relative flex flex-1 items-center justify-center overflow-hidden"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => (scale === 1 ? zoom(1) : reset())}
      >
        <img
          src={src}
          alt={file.name}
          draggable={false}
          className="max-h-full max-w-full object-contain"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale}) rotate(${rot}deg)`,
            cursor: scale > 1 ? 'grab' : 'zoom-in',
            transition: dragRef.current ? 'none' : 'transform 80ms',
          }}
        />

        {/* Prev / next */}
        {prev && (
          <button
            onClick={() => onNavigate?.(prev)}
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
            title="Previous (←)"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {next && (
          <button
            onClick={() => onNavigate?.(next)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
            title="Next (→)"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}

        {/* Toolbar */}
        <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/70 px-2 py-1 text-white shadow-lg backdrop-blur">
          <button onClick={() => zoom(-0.25)} disabled={scale <= 1} className="rounded-full p-1.5 hover:bg-white/15 disabled:opacity-40" title="Zoom out (-)">
            <ZoomOut className="h-4 w-4" />
          </button>
          <button onClick={reset} className="w-12 text-center text-xs tabular-nums hover:text-brand-300" title="Reset (0)">
            {Math.round(scale * 100)}%
          </button>
          <button onClick={() => zoom(0.25)} disabled={scale >= 8} className="rounded-full p-1.5 hover:bg-white/15 disabled:opacity-40" title="Zoom in (+)">
            <ZoomIn className="h-4 w-4" />
          </button>
          <span className="mx-1 h-4 w-px bg-white/20" />
          <button onClick={() => setRot((r) => (r + 90) % 360)} className="rounded-full p-1.5 hover:bg-white/15" title="Rotate">
            <RotateCw className="h-4 w-4" />
          </button>
          <button onClick={reset} className="rounded-full p-1.5 hover:bg-white/15" title="Fit to screen (0)">
            <Expand className="h-4 w-4" />
          </button>
          <button onClick={toggleFullscreen} className="rounded-full p-1.5 hover:bg-white/15" title="Fullscreen (f)">
            {isFs ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            onClick={() => setShowInfo((x) => !x)}
            className={'rounded-full p-1.5 hover:bg-white/15 ' + (showInfo ? 'text-brand-300' : '')}
            title="Image info / EXIF"
          >
            <Info className="h-4 w-4" />
          </button>
          {images.length > 1 && idx !== -1 && (
            <span className="px-1 text-xs text-white/70">
              {idx + 1}/{images.length}
            </span>
          )}
        </div>
      </div>

      {/* Info / EXIF panel */}
      {showInfo && (
        <div className="w-64 shrink-0 overflow-auto border-l border-white/10 bg-slate-900 p-4 text-slate-200">
          <div className="mb-3 text-sm font-semibold">Details</div>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between gap-2">
              <span className="text-slate-400">Name</span>
              <span className="truncate text-right" title={file.name}>{file.name}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-slate-400">Size</span>
              <span>{formatBytes(file.size)}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-slate-400">Type</span>
              <span>{file.mimeType}</span>
            </div>
          </div>

          <div className="mb-2 mt-4 text-sm font-semibold">EXIF</div>
          {exif == null ? (
            <div className="text-xs text-slate-400">Reading…</div>
          ) : rows.length === 0 && !gps ? (
            <div className="text-xs text-slate-400">No EXIF metadata</div>
          ) : (
            <div className="space-y-1.5 text-xs">
              {rows.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <span className="text-slate-400">{k}</span>
                  <span className="truncate text-right" title={v}>{v}</span>
                </div>
              ))}
              {gps && (
                <a
                  href={`https://www.openstreetmap.org/?mlat=${gps.lat}&mlon=${gps.lng}#map=15/${gps.lat}/${gps.lng}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 flex items-center gap-1 text-brand-400 hover:underline"
                >
                  <MapPin className="h-3.5 w-3.5" /> View location
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
