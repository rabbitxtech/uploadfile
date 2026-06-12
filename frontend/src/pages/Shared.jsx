import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Cloud, Download, Lock, Folder as FolderIcon, File as FileIcon, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { ShareApi, ConfigApi } from '../api/endpoints.js';
import { apiBase } from '../api/client.js';
import { formatBytes } from '../lib/format.js';

export default function Shared() {
 const { token } = useParams();
 const [info, setInfo] = useState(null);
 const [password, setPassword] = useState('');
 const [error, setError] = useState(null);
 const [loading, setLoading] = useState(false);
 const [uploading, setUploading] = useState(false);
 const [zipEnabled, setZipEnabled] = useState(true);

 useEffect(() => {
 ConfigApi.get()
 .then((c) => setZipEnabled(c.zipDownloadEnabled !== false))
 .catch(() => {});
 }, []);

 const reload = () =>
 ShareApi.public(token)
 .then(setInfo)
 .catch((e) => setError(e.response?.data?.error || 'Share not found'));

 // Password-protected shares come back `locked` with no contents — exchange the
 // password for the full payload (file metadata / folder listing).
 const unlock = async (e) => {
 e?.preventDefault?.();
 setLoading(true);
 setError(null);
 try {
 const full = await ShareApi.unlock(token, password);
 setInfo(full);
 } catch (err) {
 setError(err.response?.data?.error || 'Wrong password');
 } finally {
 setLoading(false);
 }
 };

 useEffect(() => {
 reload();
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [token]);

 const onUpload = async (e) => {
 const files = [...(e.target.files || [])];
 e.target.value = '';
 if (!files.length) return;
 setUploading(true);
 setError(null);
 try {
 for (const f of files) {
 await ShareApi.publicUpload(token, f, password || undefined);
 }
 toast.success(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`);
 await reload();
 } catch (err) {
 const msg = err.response?.data?.error || 'Upload failed';
 setError(msg);
 toast.error(msg);
 } finally {
 setUploading(false);
 }
 };

 const download = async (e) => {
 e?.preventDefault?.();
 setLoading(true);
 setError(null);
 try {
 const resp = await fetch(`${apiBase}/shares/public/${token}/download`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ password }),
 });
 if (!resp.ok) {
 const data = await resp.json().catch(() => ({}));
 throw new Error(data.error || 'Download failed');
 }
 const blob = await resp.blob();
 const url = URL.createObjectURL(blob);
 const a = document.createElement('a');
 a.href = url;
 const fallback = info?.folder
 ? `${info.folder.name}.zip`
 : info?.file?.name || `share-${token}`;
 a.download = fallback;
 a.click();
 URL.revokeObjectURL(url);
 } catch (e) {
 setError(e.message);
 } finally {
 setLoading(false);
 }
 };

 return (
 <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-900/60 p-4">
 <div className="card w-full max-w-lg p-6">
 <div className="mb-6 flex items-center gap-2 text-brand-700 dark:text-brand-400">
 <Cloud className="h-7 w-7" />
 <span className="text-xl font-semibold">Shared with you</span>
 </div>

 {error && (
 <div className="mb-4 rounded bg-red-50 dark:bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
 {error}
 </div>
 )}

 {info && info.locked && (
 <form onSubmit={unlock} className="space-y-3">
 <div className="rounded border border-slate-200 dark:border-slate-800 p-3 text-sm text-slate-600 dark:text-slate-300">
 <div className="mb-1 flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
 <Lock className="h-4 w-4 text-amber-500" />
 This {info.isFolder ? 'folder' : 'file'} is password-protected
 </div>
 Enter the password to view {info.isFolder ? 'its contents' : 'and download it'}.
 </div>
 <div className="relative">
 <Lock className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400 dark:text-slate-500" />
 <input
 type="password"
 placeholder="Password"
 className="input pl-8"
 value={password}
 onChange={(e) => setPassword(e.target.value)}
 autoFocus
 />
 </div>
 <button type="submit" disabled={loading || !password} className="btn-primary w-full justify-center">
 <Lock className="h-4 w-4" />
 {loading ? 'Unlocking…' : 'Unlock'}
 </button>
 </form>
 )}

 {info && !info.locked && (
 <div>
 {info.file && (
 <div className="mb-4 rounded border border-slate-200 dark:border-slate-800 p-3">
 <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
 <FileIcon className="h-4 w-4 text-brand-600 dark:text-brand-400" />
 {info.file.name}
 </div>
 <div className="text-xs text-slate-500 dark:text-slate-400">
 {info.file.mimeType} · {formatBytes(info.file.size)}
 </div>
 </div>
 )}
 {info.folder && (
 <div className="mb-4 rounded border border-slate-200 dark:border-slate-800 p-3">
 <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
 <FolderIcon className="h-4 w-4 text-amber-500" />
 {info.folder.name}
 </div>
 <div className="mb-2 text-xs text-slate-500 dark:text-slate-400">
 {info.files?.length || 0} file(s) ·{' '}
 {formatBytes(
 (info.files || []).reduce((sum, f) => sum + Number(f.size || 0), 0),
 )}
 </div>
 <div className="max-h-48 overflow-auto rounded bg-slate-50 dark:bg-slate-900/60 p-2">
 {(info.files || []).map((f) => (
 <div
 key={f.id}
 className="flex items-center justify-between gap-2 py-1 text-xs"
 >
 <span className="truncate text-slate-700 dark:text-slate-200">{f.name}</span>
 <span className="shrink-0 text-slate-500 dark:text-slate-400">{formatBytes(f.size)}</span>
 </div>
 ))}
 {(info.files || []).length === 0 && (
 <div className="py-1 text-xs text-slate-500 dark:text-slate-400">Folder is empty</div>
 )}
 </div>
 </div>
 )}
 {info.expiresAt && (
 <div className="mb-2 text-xs text-slate-500 dark:text-slate-400">
 Expires: {new Date(info.expiresAt).toLocaleString()}
 </div>
 )}
 {info.remainingDownloads != null && (
 <div className="mb-2 text-xs text-slate-500 dark:text-slate-400">
 Remaining downloads: {info.remainingDownloads}
 </div>
 )}
 {info.folder && !zipEnabled ? (
 <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
 Folder ZIP download is temporarily disabled.
 </div>
 ) : (
 <form onSubmit={download} className="space-y-3">
 {info.hasPassword && (
 <div className="relative">
 <Lock className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400 dark:text-slate-500" />
 <input
 type="password"
 placeholder="Password"
 className="input pl-8"
 value={password}
 onChange={(e) => setPassword(e.target.value)}
 />
 </div>
 )}
 <button type="submit" disabled={loading} className="btn-primary w-full justify-center">
 <Download className="h-4 w-4" />
 {loading
 ? 'Downloading...'
 : info.folder
 ? 'Download folder as ZIP'
 : 'Download'}
 </button>
 </form>
 )}

 {info.allowUpload && (
 <div className="mt-4 rounded-lg border border-dashed border-brand-300 bg-brand-50/50 p-4 text-center dark:border-brand-500/40 dark:bg-brand-500/10">
 <Upload className="mx-auto mb-2 h-6 w-6 text-brand-600 dark:text-brand-400" />
 <div className="mb-1 text-sm font-medium text-slate-800 dark:text-slate-100">
 Upload files to this folder
 </div>
 <div className="mb-3 text-xs text-slate-500 dark:text-slate-400">
 No account needed. Max 100 MB per file.
 </div>
 <label className="btn-primary mx-auto inline-flex cursor-pointer">
 <Upload className="h-4 w-4" />
 {uploading ? 'Uploading…' : 'Choose files'}
 <input type="file" multiple className="hidden" disabled={uploading} onChange={onUpload} />
 </label>
 </div>
 )}
 </div>
 )}
 </div>
 </div>
 );
}
