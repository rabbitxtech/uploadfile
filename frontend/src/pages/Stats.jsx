import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  HardDrive,
  Image,
  Film,
  Music,
  FileText,
  FileArchive,
  File as FileIcon,
  Folder,
  BarChart3,
  Sparkles,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { FileApi } from '../api/endpoints.js';
import { formatBytes } from '../lib/format.js';

function AiIndexCard() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await FileApi.reindex();
      toast.success(
        r.queued ? t('stats.indexing', { count: r.queued }) : t('stats.allIndexed'),
      );
    } catch {
      toast.error(t('stats.reindexFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card mb-6 flex flex-wrap items-center gap-3 p-4">
      <Sparkles className="h-5 w-5 text-brand-600 dark:text-brand-400" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('stats.aiIndex')}</div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {t('stats.aiIndexDesc')}
        </div>
      </div>
      <button className="btn-primary" onClick={run} disabled={busy}>
        {busy ? t('stats.queuing') : t('stats.indexExisting')}
      </button>
    </div>
  );
}

const CATEGORY_META = {
  image: { icon: Image, color: 'bg-emerald-500', text: 'text-emerald-500' },
  video: { icon: Film, color: 'bg-violet-500', text: 'text-violet-500' },
  audio: { icon: Music, color: 'bg-pink-500', text: 'text-pink-500' },
  pdf: { icon: FileText, color: 'bg-red-500', text: 'text-red-500' },
  document: { icon: FileText, color: 'bg-blue-500', text: 'text-blue-500' },
  archive: { icon: FileArchive, color: 'bg-amber-500', text: 'text-amber-500' },
  other: { icon: FileIcon, color: 'bg-slate-400', text: 'text-slate-400' },
};

function meta(cat) {
  return CATEGORY_META[cat] || CATEGORY_META.other;
}

// Resolve the i18n category key (falling back to "other" for unknown categories).
function catKey(cat) {
  return CATEGORY_META[cat] ? cat : 'other';
}

export default function Stats() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['stats'],
    queryFn: () => FileApi.analytics(),
  });

  if (isLoading) {
    return <div className="p-6 text-sm text-slate-500 dark:text-slate-400">{t('stats.loading')}</div>;
  }

  const total = Number(data?.totalSize || 0);
  const quota = Number(data?.quotaBytes || 0);
  const used = Number(data?.usedBytes || 0);
  const pct = quota ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const byCategory = data?.byCategory || [];
  const byFolder = data?.byFolder || [];
  const largest = data?.largest || [];
  const maxCat = byCategory.reduce((m, c) => Math.max(m, Number(c.size)), 0) || 1;
  const maxFolder = byFolder.reduce((m, f) => Math.max(m, Number(f.size)), 0) || 1;

  return (
    <div className="p-6">
      <div className="mb-5 flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-brand-600 dark:text-brand-400" />
        <h1 className="text-lg font-semibold">{t('stats.title')}</h1>
      </div>

      <AiIndexCard />

      {/* Summary cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="card p-4">
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <HardDrive className="h-4 w-4" /> {t('stats.usedQuota')}
          </div>
          <div className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {formatBytes(used)}
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div className="h-full bg-brand-500" style={{ width: pct + '%' }} />
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t('stats.pctOf', { pct, total: formatBytes(quota) })}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">{t('stats.files')}</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {data?.totalFiles ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t('stats.acrossFolders', { count: byFolder.length })}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">{t('stats.totalSize')}</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {formatBytes(total)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t('stats.fileTypes', { count: byCategory.length })}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* By category */}
        <div className="card p-4">
          <div className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('stats.byFileType')}
          </div>
          {byCategory.length === 0 && (
            <div className="py-6 text-center text-sm text-slate-400">{t('stats.noFilesYet')}</div>
          )}
          <div className="space-y-3">
            {byCategory.map((c) => {
              const m = meta(c.category);
              const Icon = m.icon;
              const w = Math.max(2, (Number(c.size) / maxCat) * 100);
              return (
                <div key={c.category}>
                  <div className="mb-1 flex items-center gap-2 text-sm">
                    <Icon className={`h-4 w-4 ${m.text}`} />
                    <span className="text-slate-700 dark:text-slate-200">{t(`stats.cat.${catKey(c.category)}`)}</span>
                    <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
                      {c.count} · {formatBytes(c.size)}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <div className={`h-full rounded-full ${m.color}`} style={{ width: w + '%' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Top folders */}
        <div className="card p-4">
          <div className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('stats.topFolders')}
          </div>
          {byFolder.length === 0 && (
            <div className="py-6 text-center text-sm text-slate-400">{t('stats.noFilesYet')}</div>
          )}
          <div className="space-y-3">
            {byFolder.map((f) => {
              const w = Math.max(2, (Number(f.size) / maxFolder) * 100);
              return (
                <div key={f.id || 'root'}>
                  <div className="mb-1 flex items-center gap-2 text-sm">
                    <Folder className="h-4 w-4 text-brand-500" />
                    <span className="truncate text-slate-700 dark:text-slate-200" title={f.path}>
                      {f.name}
                    </span>
                    <span className="ml-auto whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
                      {f.count} · {formatBytes(f.size)}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <div className="h-full rounded-full bg-brand-500" style={{ width: w + '%' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Largest files */}
      <div className="card mt-6 overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900 dark:border-slate-800 dark:text-slate-100">
          {t('stats.largestFiles')}
        </div>
        {largest.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">{t('stats.noFilesYet')}</div>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {largest.map((f) => {
                const m = meta(f.category);
                const Icon = m.icon;
                return (
                  <tr key={f.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <Icon className={`h-4 w-4 shrink-0 ${m.text}`} />
                        <span className="truncate text-slate-800 dark:text-slate-100">{f.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-slate-500 dark:text-slate-400">
                      {f.folder?.name || t('files.home')}
                    </td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-700 dark:text-slate-200">
                      {formatBytes(f.size)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
