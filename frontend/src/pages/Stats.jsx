import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await FileApi.reindex();
      toast.success(
        r.queued
          ? `Indexing ${r.queued} file(s) in the background — search by meaning + OCR will improve shortly.`
          : 'All files already indexed.',
      );
    } catch {
      toast.error('Reindex failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card mb-6 flex flex-wrap items-center gap-3 p-4">
      <Sparkles className="h-5 w-5 text-brand-600 dark:text-brand-400" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">AI search index</div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          OCR (images/PDF) + semantic embeddings. New uploads index automatically; run this once to
          index existing files.
        </div>
      </div>
      <button className="btn-primary" onClick={run} disabled={busy}>
        {busy ? 'Queuing…' : 'Index existing files'}
      </button>
    </div>
  );
}

const CATEGORY_META = {
  image: { label: 'Images', icon: Image, color: 'bg-emerald-500', text: 'text-emerald-500' },
  video: { label: 'Videos', icon: Film, color: 'bg-violet-500', text: 'text-violet-500' },
  audio: { label: 'Audio', icon: Music, color: 'bg-pink-500', text: 'text-pink-500' },
  pdf: { label: 'PDF', icon: FileText, color: 'bg-red-500', text: 'text-red-500' },
  document: { label: 'Documents', icon: FileText, color: 'bg-blue-500', text: 'text-blue-500' },
  archive: { label: 'Archives', icon: FileArchive, color: 'bg-amber-500', text: 'text-amber-500' },
  other: { label: 'Other', icon: FileIcon, color: 'bg-slate-400', text: 'text-slate-400' },
};

function meta(cat) {
  return CATEGORY_META[cat] || CATEGORY_META.other;
}

export default function Stats() {
  const { data, isLoading } = useQuery({
    queryKey: ['stats'],
    queryFn: () => FileApi.analytics(),
  });

  if (isLoading) {
    return <div className="p-6 text-sm text-slate-500 dark:text-slate-400">Loading analytics…</div>;
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
        <h1 className="text-lg font-semibold">Storage analytics</h1>
      </div>

      <AiIndexCard />

      {/* Summary cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="card p-4">
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <HardDrive className="h-4 w-4" /> Used / quota
          </div>
          <div className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {formatBytes(used)}
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div className="h-full bg-brand-500" style={{ width: pct + '%' }} />
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {pct}% of {formatBytes(quota)}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Files</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {data?.totalFiles ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            across {byFolder.length} folder{byFolder.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Total size (excl. trash)</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {formatBytes(total)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {byCategory.length} file type{byCategory.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* By category */}
        <div className="card p-4">
          <div className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
            By file type
          </div>
          {byCategory.length === 0 && (
            <div className="py-6 text-center text-sm text-slate-400">No files yet</div>
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
                    <span className="text-slate-700 dark:text-slate-200">{m.label}</span>
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
            Top folders
          </div>
          {byFolder.length === 0 && (
            <div className="py-6 text-center text-sm text-slate-400">No files yet</div>
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
          Largest files
        </div>
        {largest.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">No files yet</div>
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
                      {f.folder?.name || 'Home'}
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
