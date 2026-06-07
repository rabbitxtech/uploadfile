import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Copy, Trash2, Folder as FolderIcon } from 'lucide-react';
import { FileApi } from '../api/endpoints.js';
import { formatBytes, formatDate } from '../lib/format.js';
import { confirmDialog } from '../components/Dialog.jsx';

export default function Duplicates() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['duplicates'],
    queryFn: () => FileApi.duplicates(),
  });

  const trash = useMutation({
    mutationFn: (id) => FileApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['duplicates'] });
      qc.invalidateQueries({ queryKey: ['folders'] });
    },
  });

  const removeExtra = async (file) => {
    const ok = await confirmDialog({
      title: `Move "${file.name}" to trash?`,
      message: 'The other copies with identical content are kept. You can restore from Trash.',
      confirmText: 'Move to trash',
    });
    if (ok) {
      trash.mutate(file.id);
      toast.success('Moved to trash');
    }
  };

  if (isLoading) return <div className="p-6 text-sm text-slate-500 dark:text-slate-400">Scanning…</div>;

  const groups = data?.groups || [];

  return (
    <div className="p-6">
      <div className="mb-1 flex items-center gap-2">
        <Copy className="h-5 w-5 text-brand-600 dark:text-brand-400" />
        <h1 className="text-lg font-semibold">Duplicate files</h1>
      </div>
      <p className="mb-5 text-sm text-slate-500 dark:text-slate-400">
        Files with identical content (matched by SHA-256 checksum).
        {groups.length > 0 && (
          <>
            {' '}
            <span className="font-medium text-amber-600 dark:text-amber-400">
              {formatBytes(data.wastedBytes)}
            </span>{' '}
            wasted across {data.totalGroups} group{data.totalGroups === 1 ? '' : 's'}.
          </>
        )}
      </p>

      {groups.length === 0 ? (
        <div className="card p-12 text-center text-slate-500 dark:text-slate-400">
          No duplicates found 🎉
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.checksum} className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-xs dark:border-slate-800">
                <span className="text-slate-500 dark:text-slate-400">
                  {g.count} copies · {formatBytes(g.size)} each ·{' '}
                  <span className="font-mono">{g.checksum.slice(0, 12)}…</span>
                </span>
                <span className="text-amber-600 dark:text-amber-400">
                  {formatBytes(g.wastedBytes)} reclaimable
                </span>
              </div>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {g.files.map((f, i) => (
                  <li key={f.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-slate-800 dark:text-slate-100">{f.name}</span>
                        {i === 0 && (
                          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                            oldest — keep
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <FolderIcon className="h-3 w-3" />
                        {f.folder?.name || 'Home'} · {formatDate(f.createdAt)}
                      </div>
                    </div>
                    <button
                      onClick={() => removeExtra(f)}
                      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
                      title="Move this copy to trash"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Trash
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
