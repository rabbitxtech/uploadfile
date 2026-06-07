import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Trash2, Folder as FolderIcon, File as FileIcon, BarChart3, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { ShareApi } from '../api/endpoints.js';
import { formatDate } from '../lib/format.js';
import { copyText } from '../lib/uid.js';
import { confirmDialog } from '../components/Dialog.jsx';
import ActionMenu from '../components/ActionMenu.jsx';

function AccessModal({ share, onClose }) {
  const { data, isLoading } = useQuery({
    queryKey: ['share-access', share.id],
    queryFn: () => ShareApi.access(share.id),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card flex max-h-[80vh] w-full max-w-lg flex-col p-5">
        <div className="mb-3 flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-brand-600 dark:text-brand-400" />
          <span className="truncate font-medium">Access log — {share.folder?.name || share.file?.name || 'share'}</span>
          <button className="ml-auto rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>
        {!isLoading && data && (
          <div className="mb-3 flex gap-2 text-xs">
            {['view', 'download', 'upload'].map((k) =>
              data.summary?.[k] ? (
                <span key={k} className="badge bg-slate-100 dark:bg-slate-700">
                  {k}: {data.summary[k]}
                </span>
              ) : null,
            )}
            {!data.total && <span className="text-slate-400">No accesses yet</span>}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {(data?.accesses || []).map((a) => (
                <tr key={a.id}>
                  <td className="py-1.5 pr-2"><span className="badge bg-slate-100 dark:bg-slate-700">{a.action}</span></td>
                  <td className="py-1.5 pr-2 text-xs text-slate-400">{a.ip || '—'}</td>
                  <td className="py-1.5 text-right text-xs text-slate-400">{formatDate(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function Shares() {
 const qc = useQueryClient();
 const [accessShare, setAccessShare] = useState(null);
 const { data } = useQuery({ queryKey: ['shares'], queryFn: () => ShareApi.list() });

 const remove = async (id) => {
 const ok = await confirmDialog({
 title: 'Revoke this share link?',
 message: 'Anyone with the link will lose access immediately.',
 confirmText: 'Revoke',
 });
 if (!ok) return;
 await ShareApi.remove(id);
 qc.invalidateQueries({ queryKey: ['shares'] });
 };

 const copy = async (token) => {
 const url = `${window.location.origin}/s/${token}`;
 const ok = await copyText(url);
 toast[ok ? 'success' : 'error'](ok ? 'Copied' : 'Copy failed');
 };

 return (
 <div className="p-6">
 <h1 className="mb-4 text-lg font-semibold">Share links</h1>
 <div className="card overflow-x-auto">
 <table className="w-full min-w-[560px] text-sm">
 <thead className="bg-slate-50 dark:bg-slate-900/60 text-left text-xs uppercase text-slate-500 dark:text-slate-400">
 <tr>
 <th className="px-3 py-2">Target</th>
 <th className="px-3 py-2">Created</th>
 <th className="px-3 py-2">Expires</th>
 <th className="px-3 py-2">Downloads</th>
 <th className="px-3 py-2">Password</th>
 <th className="px-3 py-2"></th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
 {(data?.shares || []).map((s) => (
 <tr key={s.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
 <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">
 <span className="inline-flex items-center gap-1.5">
 {s.folder ? (
 <>
 <FolderIcon className="h-3.5 w-3.5 shrink-0 text-amber-500" />
 {s.folder.name}
 </>
 ) : s.file ? (
 <>
 <FileIcon className="h-3.5 w-3.5 shrink-0 text-brand-600 dark:text-brand-400" />
 {s.file.name}
 </>
 ) : (
 '-'
 )}
 </span>
 </td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{formatDate(s.createdAt)}</td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
 {s.expiresAt ? formatDate(s.expiresAt) : 'never'}
 </td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
 {s.downloads}
 {s.maxDownloads ? ` / ${s.maxDownloads}` : ''}
 </td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{s.password ? 'yes' : 'no'}</td>
 <td className="px-3 py-2 text-right">
 <div className="flex justify-end">
 <ActionMenu
 label="Share actions"
 items={[
 { label: 'Copy link', icon: Copy, onClick: () => copy(s.token) },
 { label: 'View access log', icon: BarChart3, onClick: () => setAccessShare(s) },
 { label: 'Revoke', icon: Trash2, danger: true, onClick: () => remove(s.id) },
 ]}
 />
 </div>
 </td>
 </tr>
 ))}
 {!data?.shares?.length && (
 <tr>
 <td colSpan={6} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">
 No shares yet
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 {accessShare && <AccessModal share={accessShare} onClose={() => setAccessShare(null)} />}
 </div>
 );
}
