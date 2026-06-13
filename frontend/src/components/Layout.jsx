import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import '../lib/i18n.js'; // ensure i18next is initialized even when Layout is mounted in isolation (tests)
import {
 Files,
 Trash2,
 Share2,
 User,
 LogOut,
 Users as UsersIcon,
 Cloud,
 Menu,
 X,
 Clock,
 Star,
 Users2,
 Moon,
 Sun,
 BarChart3,
 Copy,
 Layers,
 Command,
 ShieldAlert,
 ChevronLeft,
 ChevronRight,
 FolderTree as FolderTreeIcon,
 WifiOff,
} from 'lucide-react';
import { useAuth } from '../store/auth.js';
import { useTheme } from '../store/theme.js';
import { formatBytes } from '../lib/format.js';
import { subscribeServerEvents } from '../lib/presence.js';
import { FolderApi, FileApi, AuthApi } from '../api/endpoints.js';
import FolderTree from './FolderTree.jsx';
import NotificationBell from './NotificationBell.jsx';
import CommandPalette from './CommandPalette.jsx';

function Item({ to, icon: Icon, children, onClick }) {
 return (
 <NavLink
 to={to}
 onClick={onClick}
 end={to === '/files'}
 className={({ isActive }) =>
 'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-all duration-150 ease-smooth ' +
 (isActive
 ? 'bg-brand-600 text-white shadow-sm'
 : 'text-slate-700 dark:text-slate-200 hover:translate-x-0.5 hover:bg-slate-200 dark:hover:bg-slate-800')
 }
 >
 <Icon className="h-4 w-4" />
 {children}
 </NavLink>
 );
}

export default function Layout() {
 const { t } = useTranslation();
 const { user, logout } = useAuth();
 const { theme, toggle: toggleTheme } = useTheme();
 const navigate = useNavigate();
 const location = useLocation();
 const params = useParams();
 const qc = useQueryClient();
 const [mobileOpen, setMobileOpen] = useState(false);
 const [paletteOpen, setPaletteOpen] = useState(false);
 // Folder tree column (desktop) — collapsed state persisted across reloads.
 const [treeOpen, setTreeOpen] = useState(() => localStorage.getItem('treeOpen') !== '0');
 // Folder tree modal on mobile.
 const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
 // Offline indicator (PWA) — uploads made while offline are queued and retried.
 const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

 // Task5 #5 — WebSocket push: a 'notification' event refetches the bell
 // instantly (no 30s poll wait); 'file-change' refreshes the file lists so a
 // second tab/device sees uploads/renames/deletes live.
 useEffect(() => {
 if (!user) return undefined;
 return subscribeServerEvents((msg) => {
 if (msg.type === 'notification') {
 qc.invalidateQueries({ queryKey: ['notifications'] });
 } else if (msg.type === 'file-change') {
 qc.invalidateQueries({ queryKey: ['folders'] });
 qc.invalidateQueries({ queryKey: ['folder-tree'] });
 qc.invalidateQueries({ queryKey: ['trash'] });
 }
 });
 }, [user, qc]);

 useEffect(() => {
 const up = () => setOnline(true);
 const down = () => setOnline(false);
 window.addEventListener('online', up);
 window.addEventListener('offline', down);
 return () => {
 window.removeEventListener('online', up);
 window.removeEventListener('offline', down);
 };
 }, []);

 useEffect(() => {
 localStorage.setItem('treeOpen', treeOpen ? '1' : '0');
 }, [treeOpen]);

 // Close mobile drawer/modal on route change
 useEffect(() => {
 setMobileOpen(false);
 setMobileTreeOpen(false);
 }, [location.pathname]);

 // Global Cmd/Ctrl+K opens the command palette.
 useEffect(() => {
 const onKey = (e) => {
 if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
 e.preventDefault();
 setPaletteOpen((x) => !x);
 }
 };
 window.addEventListener('keydown', onKey);
 return () => window.removeEventListener('keydown', onKey);
 }, []);

 const treeQuery = useQuery({ queryKey: ['folder-tree'], queryFn: () => FolderApi.tree() });

 const pct =
 user && user.quotaBytes
 ? Math.min(100, Math.round((Number(user.usedBytes) / Number(user.quotaBytes)) * 100))
 : 0;

 const currentFolderId =
 location.pathname.startsWith('/files') && params['*'] ? null : params.folderId || null;
 const onFilesPage = location.pathname.startsWith('/files');

 const pickFolder = (id) => {
 navigate(id ? `/files/${id}` : '/files');
 setMobileOpen(false);
 };

 const handleDropFileOnFolder = async (fileId, folderId) => {
 try {
 await FileApi.update(fileId, { folderId });
 toast.success(t('common.moved'));
 qc.invalidateQueries({ queryKey: ['folders'] });
 } catch (e) {
 toast.error(e.response?.data?.error || t('common.moveFailed'));
 }
 };

 const folderPanel = (onClose, CloseIcon = ChevronLeft) => (
 <>
 <div className="mb-1 flex items-center justify-between px-2">
 <span className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
 {t('nav.folders')}
 </span>
 <button
 onClick={onClose}
 className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
 title={t('nav.hideFolders')}
 aria-label={t('nav.hideFolders')}
 >
 <CloseIcon className="h-4 w-4" />
 </button>
 </div>
 <div className="flex-1 overflow-auto pr-1">
 <FolderTree
 folders={treeQuery.data?.folders || []}
 currentId={currentFolderId}
 onPick={pickFolder}
 onDropFile={handleDropFileOnFolder}
 />
 </div>
 </>
 );

 const sidebar = (
 <aside className="flex h-full w-64 flex-col gap-2 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
 <div className="flex items-center gap-2 px-2 py-2">
 <div className="flex items-center gap-2 text-brand-700 dark:text-brand-400">
 <Cloud className="h-6 w-6" />
 <span className="text-lg font-semibold">Uploader</span>
 </div>
 <div className="ml-auto flex items-center gap-1">
 <NotificationBell compact />
 <button
 className="rounded p-1 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 md:hidden"
 onClick={() => setMobileOpen(false)}
 aria-label={t('nav.closeMenu')}
 >
 <X className="h-5 w-5" />
 </button>
 </div>
 </div>
 <button
 onClick={() => setPaletteOpen(true)}
 className="mb-1 flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
 >
 <Command className="h-4 w-4" />
 <span className="flex-1 text-left">{t('nav.quickSearch')}</span>
 <kbd className="rounded border border-slate-300 px-1 text-[10px] dark:border-slate-600">⌘K</kbd>
 </button>
 <nav className="flex flex-col gap-1">
 <Item to="/files" icon={Files}>
 {t('nav.myFiles')}
 </Item>
 <Item to="/recent" icon={Clock}>
 {t('nav.recent')}
 </Item>
 <Item to="/starred" icon={Star}>
 {t('nav.starred')}
 </Item>
 <Item to="/collections" icon={Layers}>
 {t('nav.collections')}
 </Item>
 <Item to="/stats" icon={BarChart3}>
 {t('nav.storage')}
 </Item>
 <Item to="/duplicates" icon={Copy}>
 {t('nav.duplicates')}
 </Item>
 <Item to="/shared-with-me" icon={Users2}>
 {t('nav.sharedWithMe')}
 </Item>
 <Item to="/shares" icon={Share2}>
 {t('nav.myShareLinks')}
 </Item>
 <Item to="/trash" icon={Trash2}>
 {t('nav.trash')}
 </Item>
 <Item to="/profile" icon={User}>
 {t('nav.profile')}
 </Item>
 {user?.role === 'admin' && (
 <Item to="/users" icon={UsersIcon}>
 {t('nav.users')}
 </Item>
 )}
 {user?.role === 'admin' && (
 <Item to="/audit" icon={ShieldAlert}>
 {t('nav.auditLog')}
 </Item>
 )}
 </nav>

 <div className="mt-auto rounded-md border border-slate-200 dark:border-slate-800 p-3 text-xs">
 <div className="mb-1 truncate font-medium text-slate-700 dark:text-slate-200">
 {user?.email}
 </div>
 <div className="mb-1 text-slate-500 dark:text-slate-400">
 {formatBytes(user?.usedBytes || 0)} / {formatBytes(user?.quotaBytes || 0)}
 </div>
 <div className="h-1.5 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
 <div className="h-full bg-brand-500" style={{ width: pct + '%' }} />
 </div>
 <div className="mt-3 flex items-center gap-1">
 <button
 className="flex flex-1 items-center justify-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 px-2 py-1 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
 onClick={() => {
 // Revoke this session server-side (best-effort) before clearing local state.
 AuthApi.logout().catch(() => {});
 logout();
 navigate('/login');
 }}
 >
 <LogOut className="h-3.5 w-3.5" /> {t('nav.signOut')}
 </button>
 <button
 className="rounded-md border border-slate-300 dark:border-slate-700 p-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
 onClick={toggleTheme}
 aria-label={t('nav.toggleTheme')}
 title={t('nav.toggleTheme')}
 >
 {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
 </button>
 </div>
 </div>
 </aside>
 );

 return (
 <div className="flex h-[100dvh] bg-slate-50 dark:bg-slate-900/60 text-slate-900">
 {/* Desktop sidebar */}
 <div className="relative hidden md:block">
 {sidebar}
 {/* Round ">" toggle, vertically centered on the sidebar edge, to reveal the tree */}
 {onFilesPage && !treeOpen && (
 <button
 onClick={() => setTreeOpen(true)}
 className="absolute right-0 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 shadow-md hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
 title={t('nav.showFolders')}
 aria-label={t('nav.showFolders')}
 >
 <ChevronRight className="h-4 w-4" />
 </button>
 )}
 </div>

 {/* Folder tree — its own column to the right of the sidebar, files page only */}
 {onFilesPage && treeOpen && (
 <aside className="hidden h-full w-60 flex-col gap-2 border-r border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900 md:flex">
 {folderPanel(() => setTreeOpen(false))}
 </aside>
 )}

 {/* Mobile drawer */}
 {mobileOpen && (
 <div
 className="fixed inset-0 z-40 bg-slate-900/50 md:hidden"
 onClick={() => setMobileOpen(false)}
 >
 <div
 className="absolute inset-y-0 left-0 animate-[slideIn_180ms_ease-out]"
 onClick={(e) => e.stopPropagation()}
 >
 {sidebar}
 </div>
 </div>
 )}

 {/* Mobile folder tree modal */}
 {mobileTreeOpen && onFilesPage && (
 <div
 className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 md:hidden"
 onClick={() => setMobileTreeOpen(false)}
 >
 <div
 className="flex max-h-[80vh] w-full max-w-sm flex-col overflow-hidden rounded-lg border border-slate-200 bg-white p-3 shadow-xl dark:border-slate-700 dark:bg-slate-800"
 onClick={(e) => e.stopPropagation()}
 >
 {folderPanel(() => setMobileTreeOpen(false), X)}
 </div>
 </div>
 )}

 <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
 {/* Mobile top bar */}
 <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2 md:hidden">
 <button
 className="rounded p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
 onClick={() => setMobileOpen(true)}
 aria-label={t('nav.openMenu')}
 >
 <Menu className="h-5 w-5" />
 </button>
 {onFilesPage && (
 <button
 className="rounded p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
 onClick={() => setMobileTreeOpen(true)}
 aria-label={t('nav.showFolders')}
 title={t('nav.folders')}
 >
 <FolderTreeIcon className="h-5 w-5" />
 </button>
 )}
 <div className="flex items-center gap-1 text-brand-700 dark:text-brand-400">
 <Cloud className="h-5 w-5" />
 <span className="font-semibold">Uploader</span>
 </div>
 <div className="ml-auto flex items-center gap-1">
 <NotificationBell compact />
 <button
 className="rounded p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
 onClick={toggleTheme}
 aria-label={t('nav.toggleTheme')}
 >
 {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
 </button>
 </div>
 </div>
 {/* key on the path so each route change replays a soft fade-in */}
 <div key={location.pathname} className="animate-fade-in">
 <Outlet />
 </div>
 </main>
 <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
 {!online && (
 <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800 shadow-lg dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200">
 <WifiOff className="h-3.5 w-3.5" /> {t('nav.offline')}
 </div>
 )}
 </div>
 );
}
