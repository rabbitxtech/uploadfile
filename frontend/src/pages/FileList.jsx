// Shared list page used by Recent and Starred. It's a slim version of Files.jsx
// without folders/upload/breadcrumbs — purely a flat list of files.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Trash2, Download } from 'lucide-react';
import { FileApi, AuthApi } from '../api/endpoints.js';
import { useAuth } from '../store/auth.js';
import { FileRow } from '../components/FileRow.jsx';
import PreviewModal from '../components/PreviewModal.jsx';
import ShareModal from '../components/ShareModal.jsx';
import { confirmDialog, promptDialog } from '../components/Dialog.jsx';

export default function FileList({ title, emptyText, queryKey, queryFn }) {
 const { t } = useTranslation();
 const qc = useQueryClient();
 const setUser = useAuth((s) => s.setUser);
 const [preview, setPreview] = useState(null);
 const [shareTarget, setShareTarget] = useState(null);
 const [selected, setSelected] = useState(new Set());

 const { data, isLoading } = useQuery({ queryKey, queryFn });

 const files = data?.files || [];

 const invalidate = () => {
 qc.invalidateQueries({ queryKey });
 qc.invalidateQueries({ queryKey: ['folders'] });
 qc.invalidateQueries({ queryKey: ['file-recent'] });
 qc.invalidateQueries({ queryKey: ['file-starred'] });
 };

 const refreshUser = async () => {
 const me = await AuthApi.me();
 setUser(me.user);
 };

 const toggleStar = async (file) => {
 await FileApi.star(file.id);
 invalidate();
 };

 const removeFile = async (file) => {
 const ok = await confirmDialog({
 title: t('fileList.moveToTrashConfirm', { name: file.name }),
 confirmText: t('nav.trash'),
 });
 if (!ok) return;
 await FileApi.remove(file.id);
 invalidate();
 refreshUser();
 };

 const renameFile = async (file) => {
 const name = await promptDialog({
 title: t('fileList.renameFile'),
 defaultValue: file.name,
 confirmText: t('files.rename'),
 });
 if (!name || name === file.name) return;
 await FileApi.update(file.id, { name });
 invalidate();
 };

 const downloadOne = async (file) => {
 const { url } = await FileApi.presignedUrl(file.id);
 window.location.href = url;
 };

 const toggle = (id, checked) =>
 setSelected((cur) => {
 const next = new Set(cur);
 checked ? next.add(id) : next.delete(id);
 return next;
 });

 const bulkTrash = async () => {
 if (!selected.size) return;
 await FileApi.bulkTrash([...selected]);
 setSelected(new Set());
 invalidate();
 refreshUser();
 toast.success(t('fileList.movedToTrash'));
 };

 return (
 <div className="p-4 md:p-6">
 <div className="mb-4 flex items-center gap-2">
 <h1 className="text-lg font-semibold">{title}</h1>
 <span className="text-sm text-slate-500 dark:text-slate-400">{t('fileList.fileCount', { count: files.length })}</span>
 {selected.size > 0 && (
 <button className="btn-danger ml-auto" onClick={bulkTrash}>
 <Trash2 className="h-4 w-4" /> {t('fileList.trashN', { count: selected.size })}
 </button>
 )}
 </div>

 <div className="card overflow-x-auto">
 <table className="w-full min-w-[600px] text-sm">
 <thead className="bg-slate-50 dark:bg-slate-900/60 text-left text-xs uppercase text-slate-500 dark:text-slate-400">
 <tr>
 <th className="px-3 py-2 w-8"></th>
 <th className="px-3 py-2">{t('files.sort.name')}</th>
 <th className="px-3 py-2">{t('files.sort.type')}</th>
 <th className="px-3 py-2">{t('files.sort.size')}</th>
 <th className="px-3 py-2">{t('files.sort.modified')}</th>
 <th className="px-3 py-2"></th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
 {files.map((file) => (
 <FileRow
 key={file.id}
 file={file}
 selected={selected.has(file.id)}
 onSelect={(c) => toggle(file.id, c)}
 onPreview={setPreview}
 onShare={(f) => setShareTarget({ fileId: f.id, name: f.name })}
 onRename={renameFile}
 onDelete={removeFile}
 onDownload={downloadOne}
 onStar={toggleStar}
 onTagsChanged={invalidate}
 />
 ))}
 {!isLoading && files.length === 0 && (
 <tr>
 <td colSpan={6} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">
 {emptyText}
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>

 <PreviewModal
 file={preview}
 onClose={() => setPreview(null)}
 siblings={files}
 onNavigate={setPreview}
 />
 <ShareModal target={shareTarget} onClose={() => setShareTarget(null)} />
 </div>
 );
}
