import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
 Bell,
 CheckCheck,
 Trash,
 AlertTriangle,
 Download,
 Sparkles,
 ShieldAlert,
 ShieldCheck,
 HardDrive,
 Crown,
 Users2,
 MessageSquare,
} from 'lucide-react';
import clsx from 'clsx';
import { NotificationApi } from '../api/endpoints.js';
import { formatDate } from '../lib/format.js';

const TYPE_ICONS = {
 share_download: Download,
 welcome: Sparkles,
 banned: ShieldAlert,
 unbanned: ShieldCheck,
 role_changed: Crown,
 quota_changed: HardDrive,
 shared_with_you: Users2,
 comment: MessageSquare,
};

const PANEL_W = 360;
const PANEL_MARGIN = 8;

function timeAgo(iso) {
 if (!iso) return '';
 const ms = Date.now() - new Date(iso).getTime();
 if (ms < 60_000) return 'just now';
 const m = Math.floor(ms / 60_000);
 if (m < 60) return `${m}m ago`;
 const h = Math.floor(m / 60);
 if (h < 24) return `${h}h ago`;
 const d = Math.floor(h / 24);
 if (d < 7) return `${d}d ago`;
 return formatDate(iso);
}

export default function NotificationBell({ compact = false }) {
 const { t } = useTranslation();
 const qc = useQueryClient();
 const navigate = useNavigate();
 const [open, setOpen] = useState(false);
 const [coords, setCoords] = useState(null);
 const panelRef = useRef(null);
 const btnRef = useRef(null);

 const { data } = useQuery({
 queryKey: ['notifications'],
 queryFn: () => NotificationApi.list({ limit: 30 }),
 // Task5 #5 — WebSocket push (Layout) invalidates this query instantly; the
 // interval is just a slow fallback for when the socket is down.
 refetchInterval: 120_000,
 refetchOnWindowFocus: true,
 });

 const items = data?.items || [];
 const unread = data?.unread || 0;

 // Compute panel position from the bell button rect. Prefer right-aligned with
 // the bell (typical dropdown), but flip / clamp to keep within the viewport.
 useLayoutEffect(() => {
 if (!open) return;
 const update = () => {
 const el = btnRef.current;
 if (!el) return;
 const r = el.getBoundingClientRect();
 let left = r.right - PANEL_W;
 if (left < PANEL_MARGIN) left = r.left;
 if (left + PANEL_W > window.innerWidth - PANEL_MARGIN) {
 left = window.innerWidth - PANEL_W - PANEL_MARGIN;
 }
 if (left < PANEL_MARGIN) left = PANEL_MARGIN;
 setCoords({ top: r.bottom + 6, left });
 };
 update();
 window.addEventListener('resize', update);
 window.addEventListener('scroll', update, true);
 return () => {
 window.removeEventListener('resize', update);
 window.removeEventListener('scroll', update, true);
 };
 }, [open]);

 useEffect(() => {
 if (!open) return;
 const onDoc = (e) => {
 if (panelRef.current?.contains(e.target)) return;
 if (btnRef.current?.contains(e.target)) return;
 setOpen(false);
 };
 const onKey = (e) => {
 if (e.key === 'Escape') setOpen(false);
 };
 document.addEventListener('mousedown', onDoc);
 document.addEventListener('keydown', onKey);
 return () => {
 document.removeEventListener('mousedown', onDoc);
 document.removeEventListener('keydown', onKey);
 };
 }, [open]);

 const invalidate = () => qc.invalidateQueries({ queryKey: ['notifications'] });

 const click = async (n) => {
 if (!n.readAt) {
 await NotificationApi.markRead(n.id);
 invalidate();
 }
 if (n.link) {
 setOpen(false);
 navigate(n.link);
 }
 };

 const markAll = async () => {
 if (unread === 0) return;
 await NotificationApi.markAllRead();
 invalidate();
 };

 const clearAll = async () => {
 if (items.length === 0) return;
 await NotificationApi.clear();
 invalidate();
 };

 const remove = async (e, n) => {
 e.stopPropagation();
 await NotificationApi.remove(n.id);
 invalidate();
 };

 return (
 <>
 <button
 ref={btnRef}
 onClick={() => setOpen((x) => !x)}
 className={clsx(
 'relative rounded-md transition',
 compact
 ? 'p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
 : 'flex w-full items-center gap-2 border border-slate-300 dark:border-slate-700 px-2 py-1 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800',
 )}
 aria-label={t('notifications.title')}
 title={t('notifications.title')}
 >
 <Bell className={compact ? 'h-5 w-5' : 'h-3.5 w-3.5'} />
 {!compact && <span className="text-xs">{t('notifications.inbox')}</span>}
 {unread > 0 && (
 <span
 className={clsx(
 'absolute flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white',
 compact ? 'right-1 top-1' : '-right-1.5 -top-1.5',
 )}
 >
 {unread > 99 ? '99+' : unread}
 </span>
 )}
 </button>

 {open &&
 coords &&
 createPortal(
 <div
 ref={panelRef}
 style={{ position: 'fixed', top: coords.top, left: coords.left, width: PANEL_W }}
 className="z-[100] overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl animate-[popIn_140ms_ease-out]"
 >
 <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-3 py-2">
 <div className="flex items-center gap-2 text-sm font-semibold">
 {t('notifications.title')}
 {unread > 0 && (
 <span className="rounded-full bg-brand-100 dark:bg-brand-500/20 px-1.5 py-0.5 text-[10px] font-bold text-brand-700 dark:text-brand-400">
 {t('notifications.new', { count: unread })}
 </span>
 )}
 </div>
 <div className="flex items-center gap-1">
 <button
 onClick={markAll}
 disabled={unread === 0}
 className="rounded p-1 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30"
 title={t('notifications.markAllRead')}
 >
 <CheckCheck className="h-4 w-4" />
 </button>
 <button
 onClick={clearAll}
 disabled={items.length === 0}
 className="rounded p-1 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30"
 title={t('notifications.clearAll')}
 >
 <Trash className="h-4 w-4" />
 </button>
 </div>
 </div>
 <div className="max-h-[28rem] overflow-auto">
 {items.length === 0 && (
 <div className="px-3 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
 <Bell className="mx-auto mb-2 h-6 w-6 text-slate-300 dark:text-slate-600" />
 {t('notifications.empty')}
 </div>
 )}
 {items.map((n) => {
 const Icon = TYPE_ICONS[n.type] || AlertTriangle;
 return (
 <button
 key={n.id}
 onClick={() => click(n)}
 className={clsx(
 'group flex w-full items-start gap-2 border-b border-slate-100 dark:border-slate-800 px-3 py-2 text-left transition last:border-b-0',
 n.readAt
 ? 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
 : 'bg-brand-50/60 hover:bg-brand-50 dark:hover:bg-brand-500/20',
 )}
 >
 <div
 className={clsx(
 'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
 n.readAt
 ? 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
 : 'bg-brand-100 dark:bg-brand-500/20 text-brand-700 dark:text-brand-400',
 )}
 >
 <Icon className="h-3.5 w-3.5" />
 </div>
 <div className="min-w-0 flex-1">
 <div className="flex items-start justify-between gap-2">
 <div className="text-xs font-medium leading-tight text-slate-900 dark:text-slate-100">{n.title}</div>
 {!n.readAt && (
 <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
 )}
 </div>
 {n.body && (
 <div className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
 {n.body}
 </div>
 )}
 <div className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">{timeAgo(n.createdAt)}</div>
 </div>
 <span
 onClick={(e) => remove(e, n)}
 className="invisible mt-1 cursor-pointer rounded p-1 text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-red-600 group-hover:visible"
 role="button"
 aria-label={t('notifications.delete')}
 >
 <Trash className="h-3 w-3" />
 </span>
 </button>
 );
 })}
 </div>
 </div>,
 document.body,
 )}
 </>
 );
}
