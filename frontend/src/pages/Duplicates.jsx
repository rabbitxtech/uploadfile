import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useTranslation, Trans } from 'react-i18next';
import toast from 'react-hot-toast';
import { Copy, Trash2, Folder as FolderIcon } from 'lucide-react';
import { FileApi } from '../api/endpoints.js';
import { formatBytes, formatDate } from '../lib/format.js';
import { confirmDialog } from '../components/Dialog.jsx';

export default function Duplicates() {
  const { t } = useTranslation();
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
      title: t('fileList.moveToTrashConfirm', { name: file.name }),
      message: t('duplicates.confirmMsg'),
      confirmText: t('duplicates.moveToTrash'),
    });
    if (ok) {
      trash.mutate(file.id);
      toast.success(t('fileList.movedToTrash'));
    }
  };

  if (isLoading) return <div className="p-6 text-sm text-slate-500 dark:text-slate-400">{t('duplicates.scanning')}</div>;

  const groups = data?.groups || [];

  return (
    <div className="p-6">
      <div className="mb-1 flex items-center gap-2">
        <Copy className="h-5 w-5 text-brand-600 dark:text-brand-400" />
        <h1 className="text-lg font-semibold">{t('duplicates.title')}</h1>
      </div>
      <p className="mb-5 text-sm text-slate-500 dark:text-slate-400">
        {t('duplicates.intro')}
        {groups.length > 0 && (
          <>
            {' '}
            <Trans
              i18nKey="duplicates.wasted"
              count={data.totalGroups}
              values={{ size: formatBytes(data.wastedBytes), count: data.totalGroups }}
            >
              <span className="font-medium text-amber-600 dark:text-amber-400">size</span>
            </Trans>
          </>
        )}
      </p>

      {groups.length === 0 ? (
        <div className="card p-12 text-center text-slate-500 dark:text-slate-400">
          {t('duplicates.none')}
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.checksum} className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-xs dark:border-slate-800">
                <span className="text-slate-500 dark:text-slate-400">
                  {t('duplicates.groupMeta', { count: g.count, eachSize: formatBytes(g.size) })} ·{' '}
                  <span className="font-mono">{g.checksum.slice(0, 12)}…</span>
                </span>
                <span className="text-amber-600 dark:text-amber-400">
                  {t('duplicates.reclaimable', { size: formatBytes(g.wastedBytes) })}
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
                            {t('duplicates.oldestKeep')}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <FolderIcon className="h-3 w-3" />
                        {f.folder?.name || t('files.home')} · {formatDate(f.createdAt)}
                      </div>
                    </div>
                    <button
                      onClick={() => removeExtra(f)}
                      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
                      title={t('duplicates.moveThisCopy')}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> {t('nav.trash')}
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
