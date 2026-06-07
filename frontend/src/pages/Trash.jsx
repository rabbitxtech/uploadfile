import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
 RefreshCcw,
 Trash2,
 RotateCcw,
 Folder as FolderIcon,
 File as FileIcon,
 Image as ImageIcon,
 FileText,
 FileArchive,
 Music,
 Video,
 Eye,
} from 'lucide-react';
import { fileIcon } from '../lib/format.js';
import { TrashApi, AuthApi, UserApi } from '../api/endpoints.js';
import { useAuth } from '../store/auth.js';
import { formatBytes, formatDate } from '../lib/format.js';
import { confirmDialog } from '../components/Dialog.jsx';

const ICONS = {
 image: ImageIcon,
 video: Video,
 audio: Music,
 pdf: FileText,
 archive: FileArchive,
 file: FileIcon,
};

function FileTypeIcon({ mime }) {
 const Icon = ICONS[fileIcon(mime)] || FileIcon;
 return <Icon className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" />;
}

export default function Trash() {
 const qc = useQueryClient();
 const me = useAuth((s) => s.user);
 const setUser = useAuth((s) => s.setUser);
 const [searchParams] = useSearchParams();
 const asUserId = searchParams.get('as');
 const viewingAs = asUserId && me?.role === 'admin' && asUserId !== me.id;
 const ownerFilter = viewingAs ? asUserId : null;

 const { data, isFetching, refetch } = useQuery({
 queryKey: ['trash', ownerFilter || 'self'],
 queryFn: () => TrashApi.list({ ownerId: ownerFilter }),
 });

 const viewedUserQuery = useQuery({
 queryKey: ['user-summary', asUserId],
 queryFn: () => UserApi.list().then((d) => d.users.find((u) => u.id === asUserId)),
 enabled: !!viewingAs,
 });

 const refresh = async () => {
 qc.invalidateQueries({ queryKey: ['trash'] });
 qc.invalidateQueries({ queryKey: ['folders'] });
 if (!viewingAs) {
 const meData = await AuthApi.me();
 setUser(meData.user);
 }
 };

 const restoreFile = async (id) => {
 await TrashApi.restore({ fileIds: [id] });
 refresh();
 };
 const restoreFolder = async (id) => {
 await TrashApi.restore({ folderIds: [id] });
 refresh();
 };
 const deleteForever = async (id) => {
 const ok = await confirmDialog({
 title: 'Delete file permanently?',
 message: 'This action cannot be undone. The file will be removed from storage.',
 confirmText: 'Delete forever',
 });
 if (!ok) return;
 await TrashApi.removeFile(id);
 refresh();
 };
 const emptyAll = async () => {
 const ok = await confirmDialog({
 title: 'Empty trash?',
 message: 'All items in trash will be permanently deleted. This cannot be undone.',
 confirmText: 'Empty trash',
 });
 if (!ok) return;
 await TrashApi.empty({ ownerId: ownerFilter });
 toast.success('Trash emptied');
 refresh();
 };

 return (
 <div className="p-6">
 {viewingAs && (
 <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
 <Eye className="h-4 w-4 text-amber-700 dark:text-amber-300" />
 <span className="text-amber-800 dark:text-amber-300">
 Trash of{' '}
 <strong>
 {viewedUserQuery.data?.name || viewedUserQuery.data?.email || asUserId}
 </strong>{' '}
 (admin)
 </span>
 <Link
 to="/trash"
 className="ml-auto rounded px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-500/20"
 >
 Exit
 </Link>
 </div>
 )}
 <div className="mb-4 flex items-center gap-2">
 <h1 className="text-lg font-semibold">Trash</h1>
 <button className="btn-secondary" onClick={() => refetch()}>
 <RefreshCcw className="h-4 w-4" /> Refresh
 </button>
 <button className="btn-danger ml-auto" onClick={emptyAll}>
 <Trash2 className="h-4 w-4" /> Empty trash
 </button>
 </div>

 {data?.retentionDays > 0 && (
 <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
 Items in trash are permanently deleted after <strong>{data.retentionDays} days</strong>. Restore anything you want to keep.
 </div>
 )}

 {isFetching && <div className="text-sm text-slate-500 dark:text-slate-400">Loading...</div>}

 <div className="card overflow-x-auto">
 <table className="w-full min-w-[560px] text-sm">
 <thead className="bg-slate-50 dark:bg-slate-900/60 text-left text-xs uppercase text-slate-500 dark:text-slate-400">
 <tr>
 <th className="px-3 py-2">Name</th>
 <th className="px-3 py-2">Type</th>
 <th className="px-3 py-2">Size</th>
 <th className="px-3 py-2">Trashed at</th>
 <th className="px-3 py-2"></th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
 {(data?.folders || []).map((f) => (
 <tr key={'fo-' + f.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
 <td className="px-3 py-2">
 <div className="flex items-center gap-2">
 <FolderIcon className="h-4 w-4 shrink-0 text-amber-500" />
 <span className="truncate font-medium text-slate-900 dark:text-slate-100">{f.name}</span>
 </div>
 </td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">Folder</td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">-</td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{formatDate(f.trashedAt)}</td>
 <td className="px-3 py-2 text-right text-xs">
 <button
 className="text-brand-600 dark:text-brand-400 hover:underline"
 onClick={() => restoreFolder(f.id)}
 >
 <RotateCcw className="inline h-3.5 w-3.5" /> Restore
 </button>
 </td>
 </tr>
 ))}
 {(data?.files || []).map((f) => (
 <tr key={'fi-' + f.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
 <td className="px-3 py-2">
 <div className="flex items-center gap-2">
 <FileTypeIcon mime={f.mimeType} />
 <span className="truncate font-medium text-slate-900 dark:text-slate-100">{f.name}</span>
 </div>
 </td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{f.mimeType}</td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{formatBytes(f.size)}</td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{formatDate(f.trashedAt)}</td>
 <td className="px-3 py-2 text-right text-xs">
 <button
 className="mr-3 text-brand-600 dark:text-brand-400 hover:underline"
 onClick={() => restoreFile(f.id)}
 >
 <RotateCcw className="inline h-3.5 w-3.5" /> Restore
 </button>
 <button
 className="text-red-600 dark:text-red-400 hover:underline"
 onClick={() => deleteForever(f.id)}
 >
 Delete forever
 </button>
 </td>
 </tr>
 ))}
 {!data?.files?.length && !data?.folders?.length && (
 <tr>
 <td colSpan={5} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">
 Trash is empty
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 );
}
