import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Layers, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { CollectionApi } from '../api/endpoints.js';

export default function AddToCollectionModal({ fileIds, onClose }) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const { data } = useQuery({ queryKey: ['collections'], queryFn: () => CollectionApi.list() });
  const manual = (data?.collections || []).filter((c) => c.kind === 'manual');

  const addTo = async (c) => {
    setBusy(true);
    try {
      const r = await CollectionApi.addFiles(c.id, fileIds);
      toast.success(`Added ${r.added} to "${c.name}"`);
      qc.invalidateQueries({ queryKey: ['collections'] });
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const createNew = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await CollectionApi.create({ name: newName.trim(), kind: 'manual', fileIds });
      toast.success(`Created "${newName.trim()}"`);
      qc.invalidateQueries({ queryKey: ['collections'] });
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="card w-full max-w-sm p-5">
        <div className="mb-3 flex items-center gap-2">
          <Layers className="h-5 w-5 text-brand-600 dark:text-brand-400" />
          <span className="font-medium">Add {fileIds.length} to collection</span>
          <button className="ml-auto rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-56 space-y-1 overflow-auto">
          {manual.length === 0 && (
            <div className="py-3 text-center text-xs text-slate-400">No collections yet</div>
          )}
          {manual.map((c) => (
            <button
              key={c.id}
              disabled={busy}
              onClick={() => addTo(c)}
              className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <span className="truncate text-slate-700 dark:text-slate-200">{c.name}</span>
              <span className="text-xs text-slate-400">{c.fileCount}</span>
            </button>
          ))}
        </div>

        <div className="mt-3 flex gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          <input
            className="input"
            placeholder="New collection name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createNew()}
          />
          <button className="btn-primary shrink-0" onClick={createNew} disabled={busy || !newName.trim()}>
            <Plus className="h-4 w-4" /> Create
          </button>
        </div>
      </div>
    </div>
  );
}
