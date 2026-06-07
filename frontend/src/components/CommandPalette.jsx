import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  File as FileIcon,
  Folder as FolderIcon,
  Clock,
  Star,
  Trash2,
  BarChart3,
  Copy,
  Layers,
  Share2,
  Users2,
  Moon,
  Sun,
  CornerDownLeft,
} from 'lucide-react';
import { FileApi } from '../api/endpoints.js';
import { useTheme } from '../store/theme.js';

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [debounced, setDebounced] = useState('');
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const fileQuery = useQuery({
    queryKey: ['palette-search', debounced],
    queryFn: () => FileApi.search(debounced),
    enabled: open && debounced.length >= 2,
  });

  const actions = useMemo(
    () => [
      { id: 'go-files', label: 'My files', icon: FolderIcon, run: () => navigate('/files') },
      { id: 'go-recent', label: 'Recent', icon: Clock, run: () => navigate('/recent') },
      { id: 'go-starred', label: 'Starred', icon: Star, run: () => navigate('/starred') },
      { id: 'go-collections', label: 'Collections', icon: Layers, run: () => navigate('/collections') },
      { id: 'go-shared', label: 'Shared with me', icon: Users2, run: () => navigate('/shared-with-me') },
      { id: 'go-shares', label: 'My share links', icon: Share2, run: () => navigate('/shares') },
      { id: 'go-stats', label: 'Storage analytics', icon: BarChart3, run: () => navigate('/stats') },
      { id: 'go-dups', label: 'Duplicate files', icon: Copy, run: () => navigate('/duplicates') },
      { id: 'go-trash', label: 'Trash', icon: Trash2, run: () => navigate('/trash') },
      {
        id: 'theme',
        label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        icon: theme === 'dark' ? Sun : Moon,
        run: () => toggle(),
        keepOpen: true,
      },
    ],
    [navigate, theme, toggle],
  );

  const ql = debounced.toLowerCase();
  const filteredActions = ql
    ? actions.filter((a) => a.label.toLowerCase().includes(ql))
    : actions;
  const files = (fileQuery.data?.files || []).slice(0, 8);

  // Flat list of selectable items for keyboard nav.
  const items = useMemo(() => {
    const list = filteredActions.map((a) => ({ type: 'action', ...a }));
    files.forEach((f) =>
      list.push({
        type: 'file',
        id: 'file-' + f.id,
        label: f.name,
        icon: FileIcon,
        run: () => navigate(f.folderId ? `/files/${f.folderId}` : '/files'),
        sub: f.folder?.name || 'Home',
      }),
    );
    return list;
  }, [filteredActions, files, navigate]);

  useEffect(() => {
    if (active >= items.length) setActive(0);
  }, [items.length, active]);

  const exec = (item) => {
    if (!item) return;
    item.run?.();
    if (!item.keepOpen) onClose();
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 dark:border-slate-700">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(items.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                exec(items[active]);
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
            placeholder="Search files or jump to…"
            className="w-full bg-transparent py-3 text-sm text-slate-800 outline-none placeholder:text-slate-400 dark:text-slate-100"
          />
          <kbd className="hidden rounded border border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-400 dark:border-slate-600 sm:block">
            ESC
          </kbd>
        </div>
        <div ref={listRef} className="max-h-80 overflow-auto py-1">
          {items.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-slate-400">No results</div>
          )}
          {filteredActions.length > 0 && (
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Actions
            </div>
          )}
          {items.map((item, i) => {
            const Icon = item.icon;
            if (item.type === 'file' && (i === 0 || items[i - 1].type === 'action')) {
              return (
                <div key="files-head">
                  <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Files
                  </div>
                  <Row item={item} Icon={Icon} activeRow={i === active} onClick={() => exec(item)} onHover={() => setActive(i)} />
                </div>
              );
            }
            return (
              <Row key={item.id} item={item} Icon={Icon} activeRow={i === active} onClick={() => exec(item)} onHover={() => setActive(i)} />
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({ item, Icon, activeRow, onClick, onHover }) {
  return (
    <button
      onMouseDown={onClick}
      onMouseEnter={onHover}
      className={
        'flex w-full items-center gap-3 px-3 py-2 text-left text-sm ' +
        (activeRow ? 'bg-brand-50 dark:bg-brand-500/15' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50')
      }
    >
      <Icon className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" />
      <span className="flex-1 truncate text-slate-700 dark:text-slate-200">{item.label}</span>
      {item.sub && <span className="shrink-0 text-xs text-slate-400">{item.sub}</span>}
      {activeRow && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
    </button>
  );
}
