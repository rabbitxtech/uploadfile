import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { Upload, X, Pause, Play } from 'lucide-react';
import toast from 'react-hot-toast';
import { chunkedUpload } from '../api/upload.js';
import { formatBytes } from '../lib/format.js';
import { confirmDialog } from './Dialog.jsx';
import { randomId } from '../lib/uid.js';
import { enqueue, allItems, removeItem } from '../lib/outbox.js';

function makeEntry(file, { replaceFileId = null } = {}) {
 return {
 id: randomId(),
 file,
 progress: 0,
 uploaded: 0,
 status: 'pending',
 error: null,
 abortController: null,
 replaceFileId,
 };
}

// The dropzone is invisible by default; a full-screen overlay appears only
// when the user drags files anywhere over the window. Parent components can
// trigger the OS file picker through the imperative ref (`pick()`).
const Uploader = forwardRef(function Uploader({ folderId, onUploaded, existingFiles = [] }, ref) {
 const [entries, setEntries] = useState([]);
 const [dragActive, setDragActive] = useState(false);
 const dragCounter = useRef(0);
 const inputRef = useRef(null);
 const cameraRef = useRef(null);
 const entriesRef = useRef(entries);
 entriesRef.current = entries;
 const existingRef = useRef(existingFiles);
 existingRef.current = existingFiles;

 const update = (id, patch) => {
 setEntries((cur) => cur.map((e) => (e.id === id ? { ...e, ...patch } : e)));
 };

 const startEntry = useCallback(
 async (entry) => {
 const ac = new AbortController();
 update(entry.id, { status: 'uploading', abortController: ac });
 try {
 const result = await chunkedUpload(entry.file, {
 folderId,
 signal: ac.signal,
 replaceFileId: entry.replaceFileId || null,
 onProgress: ({ uploaded, total }) => {
 update(entry.id, {
 uploaded,
 progress: Math.round((uploaded / total) * 100),
 });
 },
 });
 update(entry.id, { status: 'done', progress: 100 });
 toast.success(
 entry.replaceFileId
 ? `Replaced ${entry.file.name}`
 : `Uploaded ${entry.file.name}`,
 );
 onUploaded?.(result);
 } catch (e) {
 if (ac.signal.aborted) {
 update(entry.id, { status: 'paused' });
 } else {
 // Prefer the server's message (e.g. "Quota exceeded") over a raw status code.
 const msg = e.response?.data?.error || e.serverError || e.message || 'Upload failed';
 update(entry.id, { status: 'error', error: msg });
 toast.error(`${entry.file.name}: ${msg}`);
 }
 }
 },
 [folderId, onUploaded],
 );

 const addFiles = useCallback(
 async (files) => {
 if (!files || !files.length) return;
 const list = Array.from(files);

 // Offline: stash in the IndexedDB outbox and upload automatically when the
 // connection returns (see the flush effect below).
 if (typeof navigator !== 'undefined' && navigator.onLine === false) {
 for (const f of list) {
 await enqueue({ id: randomId(), file: f, name: f.name, folderId: folderId || null, createdAt: Date.now() });
 }
 toast(`Offline — ${list.length} file${list.length === 1 ? '' : 's'} queued, will upload when back online`, {
 icon: '📥',
 });
 return;
 }

 const existing = existingRef.current || [];
 const duplicates = list
 .map((f) => ({ file: f, dup: existing.find((x) => x.name === f.name) }))
 .filter((x) => x.dup);

 // applyAll: 'replace' | 'skip' | null. When set, remaining conflicts use
 // this choice without prompting again.
 let applyAll = null;
 const queued = [];

 for (const f of list) {
 const dup = existing.find((x) => x.name === f.name);
 if (!dup) {
 queued.push(makeEntry(f));
 continue;
 }

 if (applyAll === 'replace') {
 queued.push(makeEntry(f, { replaceFileId: dup.id }));
 continue;
 }
 if (applyAll === 'skip') continue;

 const remaining = duplicates.filter((x) => x.file !== f).length;
 const opts = {
 title: 'Replace existing file?',
 message: `A file named "${f.name}" already exists in this folder.\nReplacing will delete the old file and its versions.`,
 confirmText: 'Replace',
 cancelText: 'Skip',
 };
 if (remaining > 0) {
 opts.checkbox = { label: `Apply to all ${remaining} remaining duplicate(s)` };
 const { ok, checked } = await confirmDialog(opts);
 if (checked) applyAll = ok ? 'replace' : 'skip';
 if (!ok) continue;
 queued.push(makeEntry(f, { replaceFileId: dup.id }));
 } else {
 const ok = await confirmDialog(opts);
 if (!ok) continue;
 queued.push(makeEntry(f, { replaceFileId: dup.id }));
 }
 }
 if (!queued.length) return;
 setEntries((cur) => [...cur, ...queued]);
 queued.forEach(startEntry);
 },
 [startEntry, folderId],
 );

 useImperativeHandle(
 ref,
 () => ({
 pick: () => inputRef.current?.click(),
 capture: () => cameraRef.current?.click(),
 add: (files) => addFiles(files),
 }),
 [addFiles],
 );

 // Flush the offline outbox on mount and whenever connectivity returns.
 useEffect(() => {
 const flush = async () => {
 if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
 let items = [];
 try {
 items = await allItems();
 } catch {
 return;
 }
 for (const item of items) {
 try {
 const result = await chunkedUpload(item.file, { folderId: item.folderId || null });
 await removeItem(item.id);
 toast.success(`Uploaded ${item.name}`);
 onUploaded?.(result);
 } catch {
 // Still offline / server unreachable — leave it queued for next time.
 }
 }
 };
 flush();
 window.addEventListener('online', flush);
 return () => window.removeEventListener('online', flush);
 }, [onUploaded]);

 useEffect(() => {
 const hasFiles = (e) => {
 const t = e.dataTransfer?.types;
 if (!t) return false;
 for (let i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
 return false;
 };

 const onDragEnter = (e) => {
 if (!hasFiles(e)) return;
 dragCounter.current += 1;
 setDragActive(true);
 };
 const onDragLeave = () => {
 dragCounter.current -= 1;
 if (dragCounter.current <= 0) {
 dragCounter.current = 0;
 setDragActive(false);
 }
 };
 const onDragOver = (e) => {
 if (hasFiles(e)) e.preventDefault();
 };
 const onDrop = (e) => {
 const had = hasFiles(e);
 dragCounter.current = 0;
 setDragActive(false);
 if (!had) return;
 e.preventDefault();
 addFiles(e.dataTransfer.files);
 };

 window.addEventListener('dragenter', onDragEnter);
 window.addEventListener('dragleave', onDragLeave);
 window.addEventListener('dragover', onDragOver);
 window.addEventListener('drop', onDrop);
 return () => {
 window.removeEventListener('dragenter', onDragEnter);
 window.removeEventListener('dragleave', onDragLeave);
 window.removeEventListener('dragover', onDragOver);
 window.removeEventListener('drop', onDrop);
 };
 }, [addFiles]);

 const cancel = (entry) => {
 entry.abortController?.abort();
 };
 const dismiss = (id) => {
 const entry = entriesRef.current.find((e) => e.id === id);
 entry?.abortController?.abort();
 setEntries((cur) => cur.filter((e) => e.id !== id));
 };

 const active = entries.filter((e) => e.status !== 'done');

 return (
 <>
 <input
 ref={inputRef}
 type="file"
 multiple
 className="hidden"
 onChange={(e) => {
 addFiles(e.target.files);
 e.target.value = '';
 }}
 />
 {/* Camera capture (mobile): opens the rear camera directly. */}
 <input
 ref={cameraRef}
 type="file"
 accept="image/*"
 capture="environment"
 className="hidden"
 onChange={(e) => {
 addFiles(e.target.files);
 e.target.value = '';
 }}
 />

 {dragActive && (
 <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-brand-600/25 backdrop-blur-sm animate-[fadeIn_120ms_ease-out]">
 <div className="rounded-2xl border-4 border-dashed border-brand-500 bg-white/95 px-10 py-12 text-center shadow-2xl dark:bg-slate-800/95">
 <Upload className="mx-auto h-12 w-12 text-brand-600 dark:text-brand-400" />
 <div className="mt-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Drop files to upload</div>
 <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
 Large files are chunked &amp; resumable
 </div>
 </div>
 </div>
 )}

 {active.length > 0 && (
 <div className="space-y-2">
 {active.map((entry) => (
 <div key={entry.id} className="card flex items-center gap-3 p-3">
 <div className="flex-1 overflow-hidden">
 <div className="flex items-center justify-between gap-2 text-sm">
 <span className="truncate font-medium text-slate-900 dark:text-slate-100">{entry.file.name}</span>
 <span className="text-xs text-slate-500 dark:text-slate-400">
 {formatBytes(entry.uploaded)} / {formatBytes(entry.file.size)}
 </span>
 </div>
 <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
 <div
 className={
 'h-full transition-all ' +
 (entry.status === 'error'
 ? 'bg-red-500'
 : entry.status === 'paused'
 ? 'bg-amber-500'
 : 'bg-brand-500')
 }
 style={{ width: entry.progress + '%' }}
 />
 </div>
 {entry.status === 'error' && (
 <div className="mt-1 text-xs text-red-600 dark:text-red-400">{entry.error}</div>
 )}
 </div>
 {entry.status === 'uploading' && (
 <button
 className="rounded p-1 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
 title="Pause"
 onClick={() => cancel(entry)}
 >
 <Pause className="h-4 w-4" />
 </button>
 )}
 {(entry.status === 'paused' || entry.status === 'error') && (
 <button
 className="rounded p-1 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
 title="Retry"
 onClick={() => startEntry(entry)}
 >
 <Play className="h-4 w-4" />
 </button>
 )}
 <button
 className="rounded p-1 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
 title="Cancel"
 onClick={() => dismiss(entry.id)}
 >
 <X className="h-4 w-4" />
 </button>
 </div>
 ))}
 </div>
 )}
 </>
 );
});

export default Uploader;
