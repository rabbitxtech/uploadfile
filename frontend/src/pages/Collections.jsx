import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Layers, Plus, Trash2, Search as SearchIcon, FolderHeart } from 'lucide-react';
import { CollectionApi } from '../api/endpoints.js';
import { confirmDialog } from '../components/Dialog.jsx';

export default function Collections() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['collections'], queryFn: () => CollectionApi.list() });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', kind: 'manual', q: '', tag: '' });

  const create = useMutation({
    mutationFn: () =>
      CollectionApi.create({
        name: form.name.trim(),
        kind: form.kind,
        filter: form.kind === 'smart' ? { q: form.q || undefined, tag: form.tag || undefined } : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collections'] });
      setOpen(false);
      setForm({ name: '', kind: 'manual', q: '', tag: '' });
      toast.success('Collection created');
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed'),
  });

  const remove = async (c) => {
    const ok = await confirmDialog({
      title: `Delete collection "${c.name}"?`,
      message: 'The collection is removed. Your files are not deleted.',
      confirmText: 'Delete',
    });
    if (!ok) return;
    await CollectionApi.remove(c.id);
    qc.invalidateQueries({ queryKey: ['collections'] });
  };

  const collections = data?.collections || [];

  return (
    <div className="p-6">
      <div className="mb-5 flex items-center gap-2">
        <Layers className="h-5 w-5 text-brand-600 dark:text-brand-400" />
        <h1 className="text-lg font-semibold">Collections</h1>
        <button className="btn-primary ml-auto" onClick={() => setOpen((x) => !x)}>
          <Plus className="h-4 w-4" /> New collection
        </button>
      </div>

      {open && (
        <div className="card mb-5 space-y-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">Name</label>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Best photos" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">Type</label>
              <select className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="manual">Manual — pick files yourself</option>
                <option value="smart">Smart — saved search</option>
              </select>
            </div>
          </div>
          {form.kind === 'smart' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">Search text</label>
                <input className="input" value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} placeholder="name contains…" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">Tag</label>
                <input className="input" value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })} placeholder="exact tag" />
              </div>
            </div>
          )}
          <div className="flex justify-end">
            <button className="btn-primary" onClick={() => create.mutate()} disabled={!form.name.trim() || create.isPending}>
              Create
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>
      ) : collections.length === 0 ? (
        <div className="card p-12 text-center text-slate-500 dark:text-slate-400">
          No collections yet. Create one, or select files and use “Add to collection”.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {collections.map((c) => (
            <div key={c.id} className="card group flex items-center gap-3 p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">
                {c.kind === 'smart' ? <SearchIcon className="h-5 w-5" /> : <FolderHeart className="h-5 w-5" />}
              </div>
              <Link to={`/collections/${c.id}`} className="min-w-0 flex-1">
                <div className="truncate font-medium text-slate-900 hover:underline dark:text-slate-100">{c.name}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {c.kind === 'smart' ? 'Smart · saved search' : `${c.fileCount} file${c.fileCount === 1 ? '' : 's'}`}
                </div>
              </Link>
              <button
                onClick={() => remove(c)}
                className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-100 hover:text-red-600 group-hover:opacity-100 dark:hover:bg-slate-800"
                title="Delete collection"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
