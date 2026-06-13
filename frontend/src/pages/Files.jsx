import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useInfiniteQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useTranslation, Trans } from 'react-i18next';
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
const SORT_KEYS = ['name', 'type', 'size', 'modified'];
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
 const { t } = useTranslation();
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
 title: t('files.newFolderTitle'),
 message: t('files.newFolderMessage'),
 placeholder: t('files.newFolderPlaceholder'),
 confirmText: t('common.create'),
 });
 if (!name) return;
 createFolder.mutate(name);
 };

 const onUploadFromUrl = async () => {
 const url = await promptDialog({
 title: t('files.fromUrlTitle'),
 message: t('files.fromUrlMessage'),
 placeholder: t('files.fromUrlPlaceholder'),
 confirmText: t('files.fetch'),
 });
 if (!url) return;
 try {
 await toast.promise(FileApi.fromUrl(url.trim(), folderId || null), {
 loading: t('files.fetching'),
 success: t('files.savedToFiles'),
 error: (e) => e.response?.data?.error || t('files.fetchFailed'),
 });
 qc.invalidateQueries({ queryKey: ['folders'] });
 refreshUser();
 } catch {
 /* toast already surfaced the error */
 }
 };

 const onImportYoutube = async () => {
 const url = await promptDialog({
 title: t('files.importVideoTitle'),
 message: t('files.importVideoMessage'),
 placeholder: t('files.importVideoPlaceholder'),
 confirmText: t('files.import'),
 });
 if (!url) return;
 const id = toast.loading(t('files.preparingDownload'));
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
 toast.loading(`${t('files.downloadingFrom')} ${pct}${extra ? ` (${extra})` : ''}`, { id });
 } else if (evt.type === 'status') {
 const label =
 evt.status === 'merging'
 ? t('files.mergingAudio')
 : evt.status === 'uploading'
 ? t('files.savingToFiles')
 : t('files.downloadingFrom');
 toast.loading(label, { id });
 }
 });
 toast.success(t('files.videoSaved'), { id });
 qc.invalidateQueries({ queryKey: ['folders'] });
 qc.invalidateQueries({ queryKey: ['file-recent'] });
 refreshUser();
 } catch (e) {
 toast.error(e.message || t('files.importFailed'), { id });
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
 toast.error(e.response?.data?.error || t('common.renameFailed'));
 }
 };
 const submitRenameFolder = async (folder, name) => {
 try {
 await FolderApi.update(folder.id, { name });
 qc.invalidateQueries({ queryKey: ['folders'] });
 qc.invalidateQueries({ queryKey: ['breadcrumb'] });
 qc.invalidateQueries({ queryKey: ['folder-tree'] });
 } catch (e) {
 toast.error(e.response?.data?.error || t('common.renameFailed'));
 }
 };

 const moveFileTo = async (fileId, targetFolderId) => {
 try {
 await FileApi.update(fileId, { folderId: targetFolderId });
 toast.success(t('common.moved'));
 qc.invalidateQueries({ queryKey: ['folders'] });
 } catch (e) {
 toast.error(e.response?.data?.error || t('common.moveFailed'));
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

 // Task5 #20 — cursor pages are loaded on demand. The working set is bounded by
 // pagination (200/page), so we render the loaded rows directly (no DOM
 // virtualization): the app scrolls inside Layout's <main>, not the window, so a
 // window virtualizer mis-measured the scroll position and produced a huge empty
 // scroll area. A bottom sentinel + IntersectionObserver auto-loads the next page
 // regardless of which element actually scrolls.
 const { hasNextPage, isFetchingNextPage, fetchNextPage } = listQuery;
 const sentinelRef = useRef(null);
 useEffect(() => {
 const el = sentinelRef.current;
 if (!el || searchActive || !hasNextPage || typeof IntersectionObserver === 'undefined') {
 return undefined;
 }
 const io = new IntersectionObserver(
 (entries) => {
 if (entries[0]?.isIntersecting && !isFetchingNextPage) fetchNextPage();
 },
 { rootMargin: '400px' },
 );
 io.observe(el);
 return () => io.disconnect();
 }, [searchActive, hasNextPage, isFetchingNextPage, fetchNextPage]);

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

 // Select-all over the currently loaded rows (pagination appends, so "all"
 // means everything fetched so far — consistent with how bulk ops work). Grid
 // view only renders files (no folders), so its universe is files only.
 const gridMode = view === 'grid';
 const totalRows = gridMode ? sortedFiles.length : sortedFolders.length + sortedFiles.length;
 const allSelected =
 totalRows > 0 &&
 selected.files.size === sortedFiles.length &&
 selected.folders.size === (gridMode ? 0 : sortedFolders.length);
 const someSelected = hasSelection && !allSelected;
 const toggleSelectAll = () => {
 if (allSelected) {
 clearSel();
 } else {
 setSelected({
 files: new Set(sortedFiles.map((f) => f.id)),
 folders: gridMode ? new Set() : new Set(sortedFolders.map((f) => f.id)),
 });
 }
 lastIdxRef.current = null;
 };
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
 (to) => (
 <span className="flex items-center gap-3">
 {t('files.movedToTrash', { count: n })}
 <button
 className="font-semibold text-brand-600 hover:underline dark:text-brand-400"
 onClick={async () => {
 toast.dismiss(to.id);
 try {
 await TrashApi.restore({ fileIds, folderIds });
 refreshAfterTrash();
 toast.success(t('files.restored'));
 } catch {
 toast.error(t('files.undoFailed'));
 }
 }}
 >
 {t('files.undo')}
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
 {listTotal != null
 ? t('files.loadedOf', { loaded: sortedFiles.length, total: listTotal })
 : t('files.loaded', { loaded: sortedFiles.length })}
 </span>
 <button
 className="font-medium text-brand-600 hover:underline disabled:opacity-50 dark:text-brand-400"
 onClick={() => fetchNextPage()}
 disabled={isFetchingNextPage}
 >
 {isFetchingNextPage ? t('common.loading') : t('files.loadMore')}
 </button>
 </div>
 ) : null;

 return (
 <div className="p-4 md:p-6">
 {viewingAs && (
 <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-sm">
 <Eye className="h-4 w-4 text-amber-700 dark:text-amber-300" />
 <span className="text-amber-800 dark:text-amber-300">
 {t('files.managingFilesOf')}{' '}
 <strong>
 {viewedUserQuery.data?.name || viewedUserQuery.data?.email || asUserId}
 </strong>{' '}
 {t('files.adminFullAccess')}
 </span>
 <Link
 to={`/trash?as=${asUserId}`}
 className="ml-auto rounded px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-500/20"
 >
 {t('files.viewTrash')}
 </Link>
 <Link
 to="/files"
 className="rounded px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-500/20"
 >
 {t('files.exit')}
 </Link>
 </div>
 )}
 <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
 <button
 onClick={() => navigate(`/files${qs}`)}
 className="flex items-center gap-1 hover:underline"
 >
 <Home className="h-4 w-4" /> {t('files.home')}
 </button>
 {trail.map((crumb) => (
 <span key={crumb.id} className="flex items-center gap-1">
 <ChevronRight className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
 <button onClick={() => navigate(`/files/${crumb.id}${qs}`)} className="hover:underline">
 {crumb.name}
 </button>
 </span>
 ))}
 </div>

 <div className="mb-4 flex flex-wrap items-center gap-2">
 <div className="relative">
 <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400 dark:text-slate-500" />
 <input
 className="input pl-8"
 placeholder={semantic ? t('files.searchByMeaning') : t('files.searchFiles')}
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
 title={t('files.semanticTitle')}
 >
 <Sparkles className="h-3.5 w-3.5" /> {t('files.semantic')}
 </button>
 {tagFilter && (
 <span className="chip-removable">
 <TagIcon className="h-3 w-3" />
 {t('files.tagPrefix')} {tagFilter}
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
 label={t('files.addNew')}
 items={[
 { label: t('files.uploadFiles'), icon: Upload, hidden: !canUpload, onClick: () => uploaderRef.current?.pick() },
 { label: t('files.takePhoto'), icon: Camera, hidden: !canUpload, onClick: () => uploaderRef.current?.capture() },
 { label: t('files.fromUrl'), icon: Link2, hidden: !canUpload, onClick: onUploadFromUrl },
 { label: t('files.importVideo'), icon: Film, hidden: !canUpload, onClick: onImportYoutube },
 { label: t('files.newFolder'), icon: FolderPlus, onClick: onNewFolder },
 ]}
 />
 )}
 <div className="ml-auto flex items-center gap-1 rounded-md border border-slate-300 px-1 dark:border-slate-700">
 <select
 className="bg-transparent py-1.5 text-xs text-slate-600 focus:outline-none dark:text-slate-300"
 value={sort.key}
 onChange={(e) => applySort(e.target.value)}
 title={t('files.sortBy')}
 >
 {SORT_KEYS.map((k) => (
 <option key={k} value={k} className="dark:bg-slate-800">
 {t(`files.sort.${k}`)}
 </option>
 ))}
 </select>
 <button
 onClick={() => applySort(sort.key)}
 className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
 title={sort.dir === 'asc' ? t('files.ascending') : t('files.descending')}
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
 title={t('files.listView')}
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
 title={t('files.gridView')}
 >
 <LayoutGrid className="h-4 w-4" />
 </button>
 </div>
 {hasSelection && (
 <>
 <span className="text-sm text-slate-500 dark:text-slate-400">
 {t('files.selectedCount', { count: selected.files.size + selected.folders.size })}
 </span>
 {zipEnabled && (
 <button className="btn-secondary" onClick={bulkZip} disabled={!selected.files.size}>
 <Download className="h-4 w-4" /> {t('files.downloadZip')}
 </button>
 )}
 {!viewingAs && (
 <>
 <button className="btn-secondary" onClick={() => setBulkRenameOpen(true)} disabled={!selected.files.size}>
 <Wand2 className="h-4 w-4" /> {t('files.rename')}
 </button>
 <button className="btn-secondary" onClick={() => setAddToColOpen(true)} disabled={!selected.files.size}>
 <Layers className="h-4 w-4" /> {t('files.addToCollection')}
 </button>
 </>
 )}
 <button className="btn-danger" onClick={bulkTrash}>
 <Trash2 className="h-4 w-4" /> {t('nav.trash')}
 </button>
 </>
 )}
 </div>

 {showGridSuggestion && view === 'list' && (
 <div className="mb-3 flex items-center gap-2 rounded-md bg-brand-50 dark:bg-brand-500/10 px-3 py-2 text-xs text-brand-800 dark:text-brand-300">
 <LayoutGrid className="h-4 w-4" />
 {t('files.mostlyImages')}{' '}
 <button onClick={() => setView('grid')} className="font-medium underline">
 {t('files.switchToGrid')}
 </button>
 </div>
 )}

 {!viewingAs && !canUpload && (
 <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
 <span className="text-amber-800 dark:text-amber-300">
 <Trans i18nKey="files.pendingApproval"><strong>pending</strong></Trans>
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
 <div>
 {sortedFiles.length === 0 ? (
 <div className="py-12 text-center text-slate-500 dark:text-slate-400">
 {debouncedQ || tagFilter ? t('files.noMatches') : t('files.noFiles')}
 </div>
 ) : (
 <>
 <label className="mb-2 inline-flex cursor-pointer items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
 <input
 type="checkbox"
 checked={allSelected}
 ref={(el) => {
 if (el) el.indeterminate = someSelected;
 }}
 onChange={toggleSelectAll}
 />
 {t('files.selectAll')}
 </label>
 <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
 {sortedFiles.map((file) => (
 <ImageCard key={file.id} file={file} onPreview={setPreview} />
 ))}
 </div>
 </>
 )}
 {loadMoreFooter}
 <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />
 </div>
 ) : (
 <div className="card overflow-x-auto">
 <table className="w-full min-w-[600px] text-sm">
 <thead className="bg-slate-50 dark:bg-slate-900/60 text-left text-xs uppercase text-slate-500 dark:text-slate-400">
 <tr>
 <th className="px-3 py-2 w-8">
 <input
 type="checkbox"
 aria-label={t('files.selectAll')}
 title={t('files.selectAll')}
 checked={allSelected}
 ref={(el) => {
 if (el) el.indeterminate = someSelected;
 }}
 onChange={toggleSelectAll}
 disabled={!totalRows}
 />
 </th>
 <SortHeader label={t('files.sort.name')} sortKey="name" sort={sort} onSort={applySort} />
 <SortHeader label={t('files.sort.type')} sortKey="type" sort={sort} onSort={applySort} />
 <SortHeader label={t('files.sort.size')} sortKey="size" sort={sort} onSort={applySort} />
 <SortHeader label={t('files.sort.modified')} sortKey="modified" sort={sort} onSort={applySort} />
 <th className="px-3 py-2"></th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
 {sortedFolders.map((f) => (
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
 ))}
 {sortedFiles.map((file) => (
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
 ))}
 {!sortedFolders.length && !sortedFiles.length && (
 <tr>
 <td colSpan={6} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">
 {debouncedQ || tagFilter ? t('files.noMatches') : t('files.emptyFolder')}
 </td>
 </tr>
 )}
 </tbody>
 </table>
 {loadMoreFooter}
 <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />
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
