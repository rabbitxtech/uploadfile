import { useMemo, useState } from 'react';
import { X, Wand2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { FileApi } from '../api/endpoints.js';

function splitExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

// Compute the new name for one file given the pattern options.
function computeName(file, idx, opts) {
  const [base, ext] = splitExt(file.name);
  let out = base;
  if (opts.numbering) {
    const n = opts.start + idx;
    const tpl = opts.pattern.trim();
    if (tpl.includes('#')) {
      out = tpl.replace(/#+/g, (m) => String(n).padStart(m.length, '0'));
    } else {
      out = `${tpl || base}${tpl ? String(n).padStart(opts.pad, '0') : ''}`;
    }
  }
  if (opts.find) out = out.split(opts.find).join(opts.replace);
  out = `${opts.prefix}${out}${opts.suffix}`;
  return `${out}${ext}`;
}

export default function BulkRenameModal({ files, onClose, onDone }) {
  const [opts, setOpts] = useState({
    prefix: '',
    suffix: '',
    find: '',
    replace: '',
    numbering: false,
    pattern: 'IMG_###',
    start: 1,
    pad: 3,
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setOpts((o) => ({ ...o, [k]: v }));

  const renames = useMemo(
    () => files.map((f, i) => ({ id: f.id, old: f.name, name: computeName(f, i, opts) })),
    [files, opts],
  );
  const changed = renames.filter((r) => r.name !== r.old && r.name.trim());

  const apply = async () => {
    if (!changed.length) return;
    setBusy(true);
    try {
      const r = await FileApi.bulkRename(changed.map(({ id, name }) => ({ id, name })));
      toast.success(`Renamed ${r.count} file${r.count === 1 ? '' : 's'}`);
      onDone?.();
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Rename failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="card flex max-h-[90vh] w-full max-w-2xl flex-col p-5">
        <div className="mb-4 flex items-center gap-2">
          <Wand2 className="h-5 w-5 text-brand-600 dark:text-brand-400" />
          <span className="font-medium">Bulk rename — {files.length} files</span>
          <button className="ml-auto rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Prefix">
            <input className="input" value={opts.prefix} onChange={(e) => set('prefix', e.target.value)} placeholder="e.g. 2026_" />
          </Field>
          <Field label="Suffix (before extension)">
            <input className="input" value={opts.suffix} onChange={(e) => set('suffix', e.target.value)} placeholder="e.g. _final" />
          </Field>
          <Field label="Find">
            <input className="input" value={opts.find} onChange={(e) => set('find', e.target.value)} placeholder="text to replace" />
          </Field>
          <Field label="Replace with">
            <input className="input" value={opts.replace} onChange={(e) => set('replace', e.target.value)} placeholder="new text" />
          </Field>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input type="checkbox" checked={opts.numbering} onChange={(e) => set('numbering', e.target.checked)} />
          Sequential numbering — pattern uses <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">#</code> for digits
        </label>
        {opts.numbering && (
          <div className="mt-2 grid grid-cols-3 gap-3">
            <Field label="Pattern">
              <input className="input" value={opts.pattern} onChange={(e) => set('pattern', e.target.value)} placeholder="IMG_###" />
            </Field>
            <Field label="Start at">
              <input className="input" type="number" value={opts.start} onChange={(e) => set('start', parseInt(e.target.value || '1', 10))} />
            </Field>
            <Field label="Min digits (no #)">
              <input className="input" type="number" min="1" value={opts.pad} onChange={(e) => set('pad', parseInt(e.target.value || '1', 10))} />
            </Field>
          </div>
        )}

        <div className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Preview ({changed.length} will change)
        </div>
        <div className="mt-1 max-h-56 flex-1 overflow-auto rounded-md border border-slate-200 dark:border-slate-800">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {renames.slice(0, 200).map((r) => (
                <tr key={r.id} className={r.name === r.old ? 'opacity-50' : ''}>
                  <td className="max-w-[45%] truncate px-3 py-1.5 text-slate-500 line-through dark:text-slate-500">{r.old}</td>
                  <td className="px-2 text-slate-400">→</td>
                  <td className="truncate px-3 py-1.5 font-medium text-slate-800 dark:text-slate-100">{r.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={apply} disabled={busy || !changed.length}>
            {busy ? 'Renaming…' : `Rename ${changed.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">{label}</label>
      {children}
    </div>
  );
}
