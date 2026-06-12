import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useInfiniteQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
 FolderPlus,
 ChevronRight,
 Home,
 Search,
 Trash2,
 Download,
 Upload,
 LayoutGrid,
 List,
 Tag as TagIcon,
 Eye,
 Play,
 Link2,
 ArrowUp,
 ArrowDown,
 Wand2,
 Layers,
 Sparkles,
 X,
 Camera,
 Film,
 Plus,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { FolderApi, FileApi, AuthApi, TrashApi, ConfigApi } from '../api/endpoints.js';
import { useAuth } from '../store/auth.js';
import { api } from '../api/client.js';
import Uploader from '../components/Uploader.jsx';
import { FileRow, FolderRow } from '../components/FileRow.jsx';
import PreviewModal from '../components/PreviewModal.jsx';
import ShareModal from '../components/ShareModal.jsx';
import BulkRenameModal from '../components/BulkRenameModal.jsx';
import AddToCollectionModal from '../components/AddToCollectionModal.jsx';
import { promptDialog } from '../components/Dialog.jsx';
import { consumeSharedFiles } from '../lib/shareTarget.js';
import ActionMenu from '../components/ActionMenu.jsx';

// H3 — sort a list of files/folders by a key + direction. Folders have no
// meaningful size/type, so those keys fall back to name for folders.
// Task5 #20: only used for search results now — the folder listing arrives
// pre-sorted from the server (sort key/dir ride along with the cursor).
const SORT_LABELS = { name: 'Name', type: 'Type', size: 'Size', modified: 'Modified' };
function sortList(items, key, dir, isFolder) {
 const mul = dir === 'asc' ? 1 : -1;
 const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true });
 return [...items].sort((a, b) => {
 let r = 0;
 if (key === 'size' && !isFolder) r = Number(a.size || 0) - Number(b.size || 0);
 else if (key === 'type' && !isFolder) r = (a.mimeType || '').localeCompare(b.mimeType || '');
 else if (key === 'modified') r = new Date(a.updatedAt) - new Date(b.updatedAt);
 else r = byName(a, b);
 if (r === 0) r = byName(a, b);
 return r * mul;
 });
}

// Clickable column header that toggles sort and shows the active direction.
function SortHeader({ label, sortKey, sort, onSort }) {
 const active = sort.key === sortKey;
 return (
 <th className="px-3 py-2">
 <button
 onClick={() => onSort(sortKey)}
 className={
 'flex items-center gap-1 uppercase hover:text-slate-700 dark:hover:text-slate-200 ' +
 (active ? 'text-slate-700 dark:text-slate-200' : '')
 }
 >
 {label}
 {active &&
 (sort.dir === 'asc' ? (
 <ArrowUp className="h-3 w-3" />
 ) : (
 <ArrowDown className="h-3 w-3" />
 ))}
 </button>
 </th>
 );
}

// Task5 #20 — column count for the virtualized grid; mirrors the old
// `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6` breakpoints
// (Tailwind breakpoints are viewport-based, so window width is the right input).
function useGridCols() {
 const calc = () =>
  window.innerWidth >= 1024 ? 6 : window.innerWidth >= 768 ? 4 : window.innerWidth >= 640 ? 3 : 2;
 const [cols, setCols] = useState(calc);
 useEffect(() => {
  const onResize = () => setCols(calc());
  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
 }, []);
 return cols;
}

function ImageCard({ file, onPreview }) {
 const [url, setUrl] = useState(null);
 useEffect(() => {
 let alive = true;
 let blobUrl;
 if (file.hasPreview) {
 api
 .get(`/files/${file.id}/thumbnail`, { responseType: 'blob' })
 .then((r) => {
 if (!alive) return;
 blobUrl = URL.createObjectURL(r.data);
 setUrl(blobUrl);
 })
 .catch(() => {});
 }
 return () => {
 alive = false;
 if (blobUrl) URL.revokeObjectURL(blobUrl);
 };
 }, [file.id, file.hasPreview]);
 return (
 <button
 onClick={() => onPreview?.(file)}
 className="group block overflow-hidden rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-left transition hover:border-brand-500 hover:shadow"
 >
 <div className="relative flex aspect-square items-center justify-center bg-slate-100 dark:bg-slate-800">
 {url ? (
 <img src={url} alt="" className="h-full w-full object-cover" />
 ) : (
 <span className="text-xs text-slate-400 dark:text-slate-500">no preview</span>
 )}
 {(file.mimeType || '').startsWith('video/') && (
 <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
 <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/55 ring-1 ring-white/30">
 <Play className="h-5 w-5 translate-x-0.5 text-white" fill="currentColor" />
 </span>
 </span>
 )}
 </div>
 <div className="truncate px-2 py-1 text-xs font-medium text-slate-900 dark:text-slate-100">
 {file.name}
 </div>
 </button>
 );
}

export default function Files() {
 const { folderId } = useParams();
 const navigate = useNavigate();
 const qc = useQueryClient();
 const currentUser = useAuth((s) => s.user);
 const setUser = useAuth((s) => s.setUser);
 const [searchParams, setSearchParams] = useSearchParams();
 // Admin can view other users' files via ?as=<userId>
 const asUserId = searchParams.get('as');
 const viewingAs = asUserId && currentUser?.role === 'admin' && asUserId !== currentUser.id;
 const ownerFilter = viewingAs ? asUserId : null;
 // Self-registered users must be approved by an admin before they can upload.
 const canUpload = currentUser?.role === 'admin' || currentUser?.approved;
 // Feature flag (server-controlled): ZIP download can be temporarily locked.
 const { data: appConfig } = useQuery({ queryKey: ['config'], queryFn: () => ConfigApi.get() });
 const zipEnabled = appConfig?.zipDownloadEnabled !== false;

 const [selected, setSelected] = useState({ files: new Set(), folders: new Set() });
 const [preview, setPreview] = useState(null);
 const [shareTarget, setShareTarget] = useState(null);
 const [bulkRenameOpen, setBulkRenameOpen] = useState(false);
 const [addToColOpen, setAddToColOpen] = useState(false);
 const [search, setSearch] = useState('');
 const [tagFilter, setTagFilter] = useState('');
 const [debouncedQ, setDebouncedQ] = useState('');
 const [semantic, setSemantic] = useState(false);
 const [view, setView] = useState('list');
 const uploaderRef = useRef(null);

 // PWA Web Share Target: when another app shares files to us, the service
 // worker stashes them and redirects here with ?share-target=N. Pull them out
 // of the cache and feed them to the uploader, then strip the param.
 useEffect(() => {
 if (!searchParams.has('share-target')) return;
 let cancelled = false;
 consumeSharedFiles().then((files) => {
 if (cancelled) return;
 if (files.length) {
 uploaderRef.current?.add(files);
 toast.success(`Received ${files.length} shared file${files.length === 1 ? '' : 's'}`);
 }
 const sp = new URLSearchParams(searchParams);
 sp.delete('share-target');
 setSearchParams(sp, { replace: true });
 });
 return () => {
 cancelled = true;
 };
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 // H3 — sort preference, remembered per folder in localStorage.
 const sortKeyFor = (id) => `filesort:${id || 'root'}`;
 const [sort, setSort] = useState(() => {
 try {
 return JSON.parse(localStorage.getItem(sortKeyFor(folderId))) || { key: 'name', dir: 'asc' };
 } catch {
 return { key: 'name', dir: 'asc' };
 }
 });
 useEffect(() => {
 try {
 const saved = JSON.parse(localStorage.getItem(sortKeyFor(folderId)));
 setSort(saved || { key: 'name', dir: 'asc' });
 } catch {
 setSort({ key: 'name', dir: 'asc' });
 }
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [folderId]);
 const applySort = (key) =>
 setSort((s) => {
 const next = s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
 try {
 localStorage.setItem(sortKeyFor(folderId), JSON.stringify(next));
 } catch {
 /* ignore */
 }
 return next;
 });

 // M2 — track the last toggled row for shift-click range selection.
 const orderedRef = useRef([]);
 const lastIdxRef = useRef(null);

 useEffect(() => {
 const t = setTimeout(() => setDebouncedQ(search.trim()), 250);
 return () => clearTimeout(t);
 }, [search]);

 // Task5 #20 — files arrive in cursor pages of 200, pre-sorted by the server
 // (the sort is part of the query key, so changing it refetches page 1).
 const listQuery = useInfiniteQuery({
 queryKey: ['folders', folderId || 'root', ownerFilter || 'self', sort.key, sort.dir],
 queryFn: ({ pageParam }) =>
 FolderApi.list(folderId || null, {
 ownerId: ownerFilter,
 cursor: pageParam,
 sort: sort.key,
 dir: sort.dir,
 }),
 initialPageParam: undefined,
 getNextPageParam: (last) => last.nextCursor || undefined,
 enabled: !debouncedQ && !tagFilter,
 });
 const listPages = listQuery.data?.pages;
 const listFolders = listPages?.[0]?.folders;
 const listFiles = useMemo(() => (listPages || []).flatMap((p) => p.files), [listPages]);
 const listTotal = listPages?.[0]?.total ?? null;
 const searchQuery = useQuery({
 queryKey: ['search', debouncedQ, tagFilter],
 queryFn: () => FileApi.search(debouncedQ, tagFilter || undefined),
 enabled: !!(debouncedQ || tagFilter) && !viewingAs && !semantic,
 });
 // K4 — semantic search (by meaning), used when the toggle is on.
 const semanticQuery = useQuery({
 queryKey: ['semantic', debouncedQ],
 queryFn: () => FileApi.semanticSearch(debouncedQ),
 enabled: semantic && !!debouncedQ && !viewingAs,
 });
 const breadcrumbQuery = useQuery({
 queryKey: ['breadcrumb', folderId, ownerFilter || 'self'],
 queryFn: () => FolderApi.breadcrumb(folderId, { ownerId: ownerFilter }),
 enabled: !!folderId,
 });
 // When admin views as another user, fetch that user's info for the banner.
 const viewedUserQuery = useQuery({
 queryKey: ['user-summary', asUserId],
 queryFn: () =>
 import('../api/endpoints.js').then(({ UserApi }) =>
 UserApi.list().then((d) => d.users.find((u) => u.id === asUserId)),
 ),
 enabled: !!viewingAs,
 });

 const refreshUser = async () => {
 const me = await AuthApi.me();
 setUser(me.user);
 };

 // A pending user may have just been approved by an admin — re-check on mount so
 // the upload UI unlocks without requiring a full re-login.
 useEffect(() => {
 if (!viewingAs && currentUser && !canUpload) refreshUser().catch(() => {});
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 const createFolder = useMutation({
 mutationFn: (name) => FolderApi.create({ name, parentId: folderId || null }),
 onSuccess: () => {
 qc.invalidateQueries({ queryKey: ['folders'] });
 qc.invalidateQueries({ queryKey: ['folder-tree'] });
 },
 });

 const removeFolder = useMutation({
 mutationFn: (id) => FolderApi.remove(id),
 onSuccess: () => {
 qc.invalidateQueries({ queryKey: ['folders'] });
 qc.invalidateQueries({ queryKey: ['folder-tree'] });
 },
 });

 const removeFile = useMutation({
 mutationFn: (id) => FileApi.remove(id),
 onSuccess: () => {
 qc.invalidateQueries({ queryKey: ['folders'] });
 qc.invalidateQueries({ queryKey: ['search'] });
 refreshUser();
 },
 });

 const onNewFolder = async () => {
 const name = await promptDialog({
 title: 'New folder',
 message: 'Choose a name for the new folder.',
 placeholder: 'e.g. Documents',
 confirmText: 'Create',
 });
 if (!name) return;
 createFolder.mutate(name);
 };

 const onUploadFromUrl = async () => {
 const url = await promptDialog({
 title: 'Upload from URL',
 message: 'Paste a direct link — the server downloads it into this folder.',
 placeholder: 'https://example.com/file.pdf',
 confirmText: 'Fetch',
 });
 if (!url) return;
 try {
 await toast.promise(FileApi.fromUrl(url.trim(), folderId || null), {
 loading: 'Fetching…',
 success: 'Saved to your files',
 error: (e) => e.response?.data?.error || 'Fetch failed',
 });
 qc.invalidateQueries({ queryKey: ['folders'] });
 refreshUser();
 } catch {
 /* toast already surfaced the error */
 }
 };

 const onImportYoutube = async () => {
 const url = await promptDialog({
 title: 'Import video from URL',
 message:
 'Paste a link from a supported source (YouTube, Vimeo, Dailymotion, TED, Internet Archive, Wikimedia, SoundCloud, X, Facebook, Instagram, Reddit, Twitch). The server downloads the best-quality video into this folder. Long videos can take several minutes.',
 placeholder: 'https://… (YouTube, Vimeo, Dailymotion, TED…)',
 confirmText: 'Import',
 });
 if (!url) return;
 const id = toast.loading('Preparing YouTube download…');
 try {
 await FileApi.fromYoutube(url.trim(), folderId || null, (evt) => {
 if (evt.type === 'progress') {
 const pct = (evt.percent || '').trim();
 const speed = (evt.speed || '').trim();
 const eta = (evt.eta || '').trim();
 const bad = (v) => !v || /unknown|^na$|n\/a/i.test(v);
 const extra = [!bad(speed) && speed, !bad(eta) && `ETA ${eta}`]
 .filter(Boolean)
 .join(' · ');
 toast.loading(`Downloading from YouTube… ${pct}${extra ? ` (${extra})` : ''}`, { id });
 } else if (evt.type === 'status') {
 const label =
 evt.status === 'merging'
 ? 'Merging video + audio…'
 : evt.status === 'uploading'
 ? 'Saving to your files…'
 : 'Downloading from YouTube…';
 toast.loading(label, { id });
 }
 });
 toast.success('Video saved to your files', { id });
 qc.invalidateQueries({ queryKey: ['folders'] });
 qc.invalidateQueries({ queryKey: ['file-recent'] });
 refreshUser();
 } catch (e) {
 toast.error(e.message || 'Import failed', { id });
 }
 };

 const clearSel = () => setSelected({ files: new Set(), folders: new Set() });

 const downloadOne = async (file) => {
 const { url } = await FileApi.presignedUrl(file.id);
 window.location.href = url;
 };

 // M3 — inline rename submit (name already chosen in the row's editor).
 const submitRenameFile = async (file, name) => {
 try {
 await FileApi.update(file.id, { name });
 qc.invalidateQueries({ queryKey: ['folders'] });
 qc.invalidateQueries({ queryKey: ['search'] });
 } catch (e) {
 toast.error(e.response?.data?.error || 'Rename failed');
 }
 };
 const submitRenameFolder = async (folder, name) => {
 try {
 await FolderApi.update(folder.id, { name });
 qc.invalidateQueries({ queryKey: ['folders'] });
 qc.invalidateQueries({ queryKey: ['breadcrumb'] });
 qc.invalidateQueries({ queryKey: ['folder-tree'] });
 } catch (e) {
 toast.error(e.response?.data?.error || 'Rename failed');
 }
 };

 const moveFileTo = async (fileId, targetFolderId) => {
 try {
 await FileApi.update(fileId, { folderId: targetFolderId });
 toast.success('Moved');
 qc.invalidateQueries({ queryKey: ['folders'] });
 } catch (e) {
 toast.error(e.response?.data?.error || 'Move failed');
 }
 };

 const searchActive = !!(debouncedQ || tagFilter);
 const data = semantic && debouncedQ
 ? { folders: [], files: semanticQuery.data?.files || [] }
 : searchActive
 ? { folders: [], files: searchQuery.data?.files || [] }
 : { folders: listFolders || [], files: listFiles };

 // Search endpoints return a full array → sort locally; the folder listing is
 // already in server order (Task5 #20), re-sorting a single page would lie.
 const sortedFolders = useMemo(
 () => (searchActive ? sortList(data.folders, sort.key, sort.dir, true) : data.folders),
 [data.folders, sort, searchActive],
 );
 const sortedFiles = useMemo(
 () => (searchActive ? sortList(data.files, sort.key, sort.dir, false) : data.files),
 [data.files, sort, searchActive],
 );
 // Keep the flat ordered list of selectable rows in sync for shift-range select.
 orderedRef.current = [
 ...sortedFolders.map((f) => `folder:${f.id}`),
 ...sortedFiles.map((f) => `file:${f.id}`),
 ];

 // Task5 #20 — virtualized rendering (window-scrolled). Both virtualizers are
 // created unconditionally (hooks must not be conditional); only the active
 // view renders one. List rows can't be measured (FileRow renders a <tr> we
 // can't ref), so fixed estimates + spacer rows; grid rows self-measure.
 const tableRows = useMemo(
 () => [
 ...sortedFolders.map((f) => ({ kind: 'folder', item: f })),
 ...sortedFiles.map((f) => ({ kind: 'file', item: f })),
 ],
 [sortedFolders, sortedFiles],
 );
 const listWrapRef = useRef(null);
 const rowVirtualizer = useWindowVirtualizer({
 count: tableRows.length,
 estimateSize: (i) => (i < sortedFolders.length ? 45 : 74),
 overscan: 12,
 scrollMargin: listWrapRef.current?.offsetTop ?? 0,
 });
 const vRows = rowVirtualizer.getVirtualItems();
 const padTop = vRows.length
 ? Math.max(0, vRows[0].start - rowVirtualizer.options.scrollMargin)
 : 0;
 const padBottom = vRows.length
 ? Math.max(
 0,
 rowVirtualizer.getTotalSize() -
 (vRows[vRows.length - 1].end - rowVirtualizer.options.scrollMargin),
 )
 : 0;

 const gridCols = useGridCols();
 const gridWrapRef = useRef(null);
 const [gridW, setGridW] = useState(0);
 useEffect(() => {
 const el = gridWrapRef.current;
 if (!el || typeof ResizeObserver === 'undefined') return undefined;
 const ro = new ResizeObserver(() => setGridW(el.clientWidth));
 ro.observe(el);
 setGridW(el.clientWidth);
 return () => ro.disconnect();
 }, [view]);
 const gridRowCount = Math.ceil(sortedFiles.length / gridCols);
 // Card = square image (width-driven) + ~26px caption + 12px row gap.
 const gridRowEstimate = gridW ? (gridW - (gridCols - 1) * 12) / gridCols + 38 : 220;
 const gridVirtualizer = useWindowVirtualizer({
 count: gridRowCount,
 estimateSize: () => gridRowEstimate,
 overscan: 6,
 scrollMargin: gridWrapRef.current?.offsetTop ?? 0,
 });
 const gRows = gridVirtualizer.getVirtualItems();

 // Auto-fetch the next cursor page when scrolling near the bottom.
 const { hasNextPage, isFetchingNextPage, fetchNextPage } = listQuery;
 useEffect(() => {
 if (searchActive || !hasNextPage || isFetchingNextPage) return;
 const last = view === 'grid' ? gRows[gRows.length - 1] : vRows[vRows.length - 1];
 if (!last) return;
 const count = view === 'grid' ? gridRowCount : tableRows.length;
 if (last.index >= count - 8) fetchNextPage();
 }, [
 searchActive,
 hasNextPage,
 isFetchingNextPage,
 view,
 vRows,
 gRows,
 gridRowCount,
 tableRows.length,
 fetchNextPage,
 ]);

 const handleSelect = (kind, id, checked, shiftKey) => {
 const idx = orderedRef.current.indexOf(`${kind}:${id}`);
 if (shiftKey && lastIdxRef.current != null && idx !== -1) {
 const [a, b] = [lastIdxRef.current, idx].sort((x, y) => x - y);
 setSelected((s) => {
 const files = new Set(s.files);
 const folders = new Set(s.folders);
 for (let i = a; i <= b; i++) {
 const [k, fid] = orderedRef.current[i].split(':');
 const set = k === 'file' ? files : folders;
 if (checked) set.add(fid);
 else set.delete(fid);
 }
 return { files, folders };
 });
 } else {
 setSelected((s) => {
 const files = new Set(s.files);
 const folders = new Set(s.folders);
 const set = kind === 'file' ? files : folders;
 if (checked) set.add(id);
 else set.delete(id);
 return { files, folders };
 });
 }
 lastIdxRef.current = idx;
 };

 const trail = useMemo(() => breadcrumbQuery.data?.trail || [], [breadcrumbQuery.data]);
 const hasSelection = selected.files.size > 0 || selected.folders.size > 0;
 const selectedFiles = sortedFiles.filter((f) => selected.files.has(f.id));
 const imageRatio = data.files.length
 ? data.files.filter((f) => f.mimeType?.startsWith('image/')).length / data.files.length
 : 0;
 const showGridSuggestion = imageRatio >= 0.5 && data.files.length >= 4;

 const refreshAfterTrash = () => {
 qc.invalidateQueries({ queryKey: ['folders'] });
 qc.invalidateQueries({ queryKey: ['folder-tree'] });
 qc.invalidateQueries({ queryKey: ['trash'] });
 refreshUser();
 };

 const bulkTrash = async () => {
 const fileIds = [...selected.files];
 const folderIds = [...selected.folders];
 if (fileIds.length) await FileApi.bulkTrash(fileIds);
 for (const id of folderIds) await FolderApi.remove(id);
 clearSel();
 refreshAfterTrash();
 // M2 — Undo toast restores the just-trashed items.
 const n = fileIds.length + folderIds.length;
 toast(
 (t) => (
 <span className="flex items-center gap-3">
 Moved {n} item{n === 1 ? '' : 's'} to trash
 <button
 className="font-semibold text-brand-600 hover:underline dark:text-brand-400"
 onClick={async () => {
 toast.dismiss(t.id);
 try {
 await TrashApi.restore({ fileIds, folderIds });
 refreshAfterTrash();
 toast.success('Restored');
 } catch {
 toast.error('Undo failed');
 }
 }}
 >
 Undo
 </button>
 </span>
 ),
 { duration: 6000, icon: '🗑️' },
 );
 };

 const bulkZip = async () => {
 const ids = [...selected.files];
 if (!ids.length) return;
 const resp = await api.post('/files/bulk/zip', { ids }, { responseType: 'blob' });
 const url = URL.createObjectURL(resp.data);
 const a = document.createElement('a');
 a.href = url;
 a.download = `files-${Date.now()}.zip`;
 a.click();
 URL.revokeObjectURL(url);
 };

 const qs = viewingAs ? `?as=${asUserId}` : '';

 // Task5 #20 — paging status under the list/grid. Scrolling auto-loads; the
 // button is a fallback when row-height estimates keep the sentinel off-screen.
 const loadMoreFooter =
 !searchActive && (hasNextPage || isFetchingNextPage) ? (
 <div className="flex items-center justify-center gap-3 px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
 <span>
 Loaded {sortedFiles.length}
 {listTotal != null ? ` of ${listTotal}` : ''} files
 </span>
 <button
 className="font-medium text-brand-600 hover:underline disabled:opacity-50 dark:text-brand-400"
 onClick={() => fetchNextPage()}
 disabled={isFetchingNextPage}
 >
 {isFetchingNextPage ? 'Loading…' : 'Load more'}
 </button>
 </div>
 ) : null;

 return (
 <div className="p-4 md:p-6">
 {viewingAs && (
 <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-sm">
 <Eye className="h-4 w-4 text-amber-700 dark:text-amber-300" />
 <span className="text-amber-800 dark:text-amber-300">
 Managing files of{' '}
 <strong>
 {viewedUserQuery.data?.name || viewedUserQuery.data?.email || asUserId}
 </strong>{' '}
 (admin — full access)
 </span>
 <Link
 to={`/trash?as=${asUserId}`}
 className="ml-auto rounded px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-500/20"
 >
 View trash
 </Link>
 <Link
 to="/files"
 className="rounded px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-500/20"
 >
 Exit
 </Link>
 </div>
 )}
 <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
 <button
 onClick={() => navigate(`/files${qs}`)}
 className="flex items-center gap-1 hover:underline"
 >
 <Home className="h-4 w-4" /> Home
 </button>
 {trail.map((t) => (
 <span key={t.id} className="flex items-center gap-1">
 <ChevronRight className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
 <button onClick={() => navigate(`/files/${t.id}${qs}`)} className="hover:underline">
 {t.name}
 </button>
 </span>
 ))}
 </div>

 <div className="mb-4 flex flex-wrap items-center gap-2">
 <div className="relative">
 <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400 dark:text-slate-500" />
 <input
 className="input pl-8"
 placeholder={semantic ? 'Search by meaning…' : 'Search files...'}
 value={search}
 onChange={(e) => setSearch(e.target.value)}
 />
 </div>
 <button
 onClick={() => setSemantic((x) => !x)}
 className={
 'flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs ' +
 (semantic
 ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300'
 : 'border-slate-300 text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800')
 }
 title="Semantic search — find files by meaning (AI)"
 >
 <Sparkles className="h-3.5 w-3.5" /> Semantic
 </button>
 {tagFilter && (
 <span className="chip-removable">
 <TagIcon className="h-3 w-3" />
 tag: {tagFilter}
 <button onClick={() => setTagFilter('')} className="hover:text-red-600">
 <X className="h-3 w-3" />
 </button>
 </span>
 )}
 {!viewingAs && (
 <ActionMenu
 variant="button"
 icon={Plus}
 align="left"
 label="Add new"
 items={[
 { label: 'Upload files', icon: Upload, hidden: !canUpload, onClick: () => uploaderRef.current?.pick() },
 { label: 'Take photo', icon: Camera, hidden: !canUpload, onClick: () => uploaderRef.current?.capture() },
 { label: 'From URL', icon: Link2, hidden: !canUpload, onClick: onUploadFromUrl },
 { label: 'Import video (URL)', icon: Film, hidden: !canUpload, onClick: onImportYoutube },
 { label: 'New folder', icon: FolderPlus, onClick: onNewFolder },
 ]}
 />
 )}
 <div className="ml-auto flex items-center gap-1 rounded-md border border-slate-300 px-1 dark:border-slate-700">
 <select
 className="bg-transparent py-1.5 text-xs text-slate-600 focus:outline-none dark:text-slate-300"
 value={sort.key}
 onChange={(e) => applySort(e.target.value)}
 title="Sort by"
 >
 {Object.entries(SORT_LABELS).map(([k, label]) => (
 <option key={k} value={k} className="dark:bg-slate-800">
 {label}
 </option>
 ))}
 </select>
 <button
 onClick={() => applySort(sort.key)}
 className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
 title={sort.dir === 'asc' ? 'Ascending' : 'Descending'}
 >
 {sort.dir === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
 </button>
 </div>
 <div className="flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-700">
 <button
 className={
 'px-2 py-1.5 text-xs ' +
 (view === 'list'
 ? 'bg-brand-600 text-white'
 : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800')
 }
 onClick={() => setView('list')}
 title="List view"
 >
 <List className="h-4 w-4" />
 </button>
 <button
 className={
 'px-2 py-1.5 text-xs ' +
 (view === 'grid'
 ? 'bg-brand-600 text-white'
 : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800')
 }
 onClick={() => setView('grid')}
 title="Grid view"
 >
 <LayoutGrid className="h-4 w-4" />
 </button>
 </div>
 {hasSelection && (
 <>
 <span className="text-sm text-slate-500 dark:text-slate-400">
 {selected.files.size + selected.folders.size} selected
 </span>
 {zipEnabled && (
 <button className="btn-secondary" onClick={bulkZip} disabled={!selected.files.size}>
 <Download className="h-4 w-4" /> Download zip
 </button>
 )}
 {!viewingAs && (
 <>
 <button className="btn-secondary" onClick={() => setBulkRenameOpen(true)} disabled={!selected.files.size}>
 <Wand2 className="h-4 w-4" /> Rename
 </button>
 <button className="btn-secondary" onClick={() => setAddToColOpen(true)} disabled={!selected.files.size}>
 <Layers className="h-4 w-4" /> Add to collection
 </button>
 </>
 )}
 <button className="btn-danger" onClick={bulkTrash}>
 <Trash2 className="h-4 w-4" /> Trash
 </button>
 </>
 )}
 </div>

 {showGridSuggestion && view === 'list' && (
 <div className="mb-3 flex items-center gap-2 rounded-md bg-brand-50 dark:bg-brand-500/10 px-3 py-2 text-xs text-brand-800 dark:text-brand-300">
 <LayoutGrid className="h-4 w-4" />
 Mostly images here —{' '}
 <button onClick={() => setView('grid')} className="font-medium underline">
 switch to grid view
 </button>
 </div>
 )}

 {!viewingAs && !canUpload && (
 <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
 <span className="text-amber-800 dark:text-amber-300">
 ⏳ Your account is <strong>pending administrator approval</strong>. You can browse, but you can't upload files until an admin approves your account.
 </span>
 </div>
 )}

 {!viewingAs && canUpload && (
 <div className="mb-4">
 <Uploader
 ref={uploaderRef}
 folderId={folderId || null}
 existingFiles={listFiles}
 onUploaded={() => {
 qc.invalidateQueries({ queryKey: ['folders'] });
 refreshUser();
 }}
 />
 </div>
 )}

 {view === 'grid' ? (
 <div ref={gridWrapRef}>
 {sortedFiles.length === 0 ? (
 <div className="py-12 text-center text-slate-500 dark:text-slate-400">
 {debouncedQ || tagFilter ? 'No matches' : 'No files'}
 </div>
 ) : (
 <div className="relative" style={{ height: gridVirtualizer.getTotalSize() }}>
 {gRows.map((vr) => (
 <div
 key={vr.key}
 ref={gridVirtualizer.measureElement}
 data-index={vr.index}
 className="absolute left-0 grid w-full gap-3 pb-3"
 style={{
 transform: `translateY(${vr.start - gridVirtualizer.options.scrollMargin}px)`,
 gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
 }}
 >
 {sortedFiles
 .slice(vr.index * gridCols, vr.index * gridCols + gridCols)
 .map((file) => (
 <ImageCard key={file.id} file={file} onPreview={setPreview} />
 ))}
 </div>
 ))}
 </div>
 )}
 {loadMoreFooter}
 </div>
 ) : (
 <div className="card overflow-x-auto" ref={listWrapRef}>
 <table className="w-full min-w-[600px] text-sm">
 <thead className="bg-slate-50 dark:bg-slate-900/60 text-left text-xs uppercase text-slate-500 dark:text-slate-400">
 <tr>
 <th className="px-3 py-2 w-8"></th>
 <SortHeader label="Name" sortKey="name" sort={sort} onSort={applySort} />
 <SortHeader label="Type" sortKey="type" sort={sort} onSort={applySort} />
 <SortHeader label="Size" sortKey="size" sort={sort} onSort={applySort} />
 <SortHeader label="Modified" sortKey="modified" sort={sort} onSort={applySort} />
 <th className="px-3 py-2"></th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
 {padTop > 0 && (
 <tr aria-hidden="true">
 <td colSpan={6} style={{ height: padTop, padding: 0, border: 0 }} />
 </tr>
 )}
 {vRows.map((vr) => {
 const row = tableRows[vr.index];
 if (!row) return null;
 if (row.kind === 'folder') {
 const f = row.item;
 return (
 <FolderRow
 key={`d-${f.id}`}
 folder={f}
 selected={selected.folders.has(f.id)}
 onSelect={(c, e) => handleSelect('folder', f.id, c, e?.shiftKey)}
 onOpen={(x) => navigate(`/files/${x.id}${qs}`)}
 onRenameSubmit={submitRenameFolder}
 onDelete={(x) => removeFolder.mutate(x.id)}
 onShare={(x) => setShareTarget({ folderId: x.id, name: x.name })}
 onDropFile={moveFileTo}
 />
 );
 }
 const file = row.item;
 return (
 <FileRow
 key={file.id}
 file={file}
 selected={selected.files.has(file.id)}
 onSelect={(c, e) => handleSelect('file', file.id, c, e?.shiftKey)}
 onPreview={setPreview}
 onShare={(f) => setShareTarget({ fileId: f.id, name: f.name })}
 onRenameSubmit={submitRenameFile}
 onDelete={(f) => removeFile.mutate(f.id)}
 onDownload={downloadOne}
 onStar={async (f) => {
 await FileApi.star(f.id);
 qc.invalidateQueries({ queryKey: ['folders'] });
 qc.invalidateQueries({ queryKey: ['file-starred'] });
 }}
 onTagsChanged={() => {
 qc.invalidateQueries({ queryKey: ['folders'] });
 qc.invalidateQueries({ queryKey: ['search'] });
 }}
 onTagClick={(t) => {
 setTagFilter(t);
 setSearch('');
 }}
 />
 );
 })}
 {padBottom > 0 && (
 <tr aria-hidden="true">
 <td colSpan={6} style={{ height: padBottom, padding: 0, border: 0 }} />
 </tr>
 )}
 {!tableRows.length && (
 <tr>
 <td colSpan={6} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">
 {debouncedQ || tagFilter
 ? 'No matches'
 : 'Empty folder — drop files anywhere on this page to upload'}
 </td>
 </tr>
 )}
 </tbody>
 </table>
 {loadMoreFooter}
 </div>
 )}

 <PreviewModal
 file={preview}
 onClose={() => setPreview(null)}
 siblings={sortedFiles}
 onNavigate={setPreview}
 />
 <ShareModal target={shareTarget} onClose={() => setShareTarget(null)} />
 {bulkRenameOpen && (
 <BulkRenameModal
 files={selectedFiles}
 onClose={() => setBulkRenameOpen(false)}
 onDone={() => {
 clearSel();
 qc.invalidateQueries({ queryKey: ['folders'] });
 }}
 />
 )}
 {addToColOpen && (
 <AddToCollectionModal
 fileIds={[...selected.files]}
 onClose={() => setAddToColOpen(false)}
 />
 )}
 </div>
 );
}
