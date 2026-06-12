import { useEffect, useRef, useState } from 'react';
import {
 File as FileIcon,
 Image as ImageIcon,
 FileText,
 FileArchive,
 Music,
 Video,
 Folder as FolderIcon,
 Tag as TagIcon,
 Star,
 X,
 Download,
 Share2,
 Pencil,
 Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import { formatBytes, formatDate, fileIcon } from '../lib/format.js';
import { api } from '../api/client.js';
import { useAuth } from '../store/auth.js';
import { FileApi } from '../api/endpoints.js';
import ActionMenu from './ActionMenu.jsx';

const ICONS = {
 image: ImageIcon,
 video: Video,
 audio: Music,
 pdf: FileText,
 archive: FileArchive,
 file: FileIcon,
};

function BlobThumb({ file, className = 'h-10 w-10' }) {
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

 if (file.hasPreview && url) {
 return <img src={url} alt="" className={clsx('rounded object-cover', className)} />;
 }
 const Icon = ICONS[fileIcon(file.mimeType)] || FileIcon;
 return <Icon className={clsx('text-slate-500 dark:text-slate-400', className)} />;
}

function TagsEditor({ file, onSaved }) {
 const [tags, setTags] = useState(file.tags?.map((t) => t.name) || []);
 const [draft, setDraft] = useState('');
 const [saving, setSaving] = useState(false);
 const inputRef = useRef(null);

 useEffect(() => {
 inputRef.current?.focus();
 }, []);

 const add = (name) => {
 const v = name.trim();
 if (!v) return;
 if (tags.includes(v)) return;
 setTags([...tags, v]);
 setDraft('');
 };
 const remove = (name) => setTags(tags.filter((t) => t !== name));

 const save = async () => {
 setSaving(true);
 try {
 await FileApi.update(file.id, { tags });
 onSaved?.(tags);
 } finally {
 setSaving(false);
 }
 };

 return (
 <div className="flex flex-col gap-2 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2 shadow-lg">
 <div className="flex flex-wrap gap-1">
 {tags.length === 0 && (
 <span className="text-xs text-slate-400 dark:text-slate-500">No tags yet</span>
 )}
 {tags.map((t) => (
 <span key={t} className="chip-removable">
 {t}
 <button
 type="button"
 onClick={() => remove(t)}
 className="hover:text-red-600"
 aria-label={`Remove ${t}`}
 >
 <X className="h-3 w-3" />
 </button>
 </span>
 ))}
 </div>
 <div className="flex items-center gap-1">
 <input
 ref={inputRef}
 value={draft}
 onChange={(e) => setDraft(e.target.value)}
 onKeyDown={(e) => {
 if (e.key === 'Enter') {
 e.preventDefault();
 add(draft);
 } else if (e.key === 'Backspace' && !draft && tags.length) {
 remove(tags[tags.length - 1]);
 }
 }}
 placeholder="Add tag, Enter to confirm"
 className="input py-1 text-xs"
 />
 <button
 type="button"
 className="btn-primary text-xs"
 onClick={save}
 disabled={saving}
 >
 Save
 </button>
 </div>
 </div>
 );
}

// Inline name editor: Enter saves, Esc cancels, blur saves. Used for M3.
function EditableName({ value, onSubmit, onCancel }) {
 const ref = useRef(null);
 const [v, setV] = useState(value);
 useEffect(() => {
 setV(value);
 const t = setTimeout(() => {
 ref.current?.focus();
 ref.current?.select();
 }, 0);
 return () => clearTimeout(t);
 }, [value]);
 const submit = () => {
 const t = v.trim();
 if (t && t !== value) onSubmit(t);
 else onCancel();
 };
 return (
 <input
 ref={ref}
 value={v}
 onChange={(e) => setV(e.target.value)}
 onClick={(e) => e.stopPropagation()}
 onKeyDown={(e) => {
 if (e.key === 'Enter') {
 e.preventDefault();
 submit();
 } else if (e.key === 'Escape') {
 e.preventDefault();
 onCancel();
 }
 }}
 onBlur={submit}
 className="input w-full py-0.5 text-sm"
 />
 );
}

// Distinguish single-click (open/preview) from double-click (inline rename)
// with a short timer so the two don't fight.
function useClickDelay(onSingle, onDouble) {
 const timer = useRef(null);
 return {
 onClick: (e) => {
 e.stopPropagation();
 if (timer.current) return;
 timer.current = setTimeout(() => {
 timer.current = null;
 onSingle?.();
 }, 220);
 },
 onDoubleClick: (e) => {
 e.stopPropagation();
 if (timer.current) {
 clearTimeout(timer.current);
 timer.current = null;
 }
 onDouble?.();
 },
 };
}

export function FolderRow({
 folder,
 selected,
 onSelect,
 onOpen,
 onRenameSubmit,
 onDelete,
 onShare,
 onDropFile,
}) {
 const [dragHover, setDragHover] = useState(false);
 const [editing, setEditing] = useState(false);
 const nameClick = useClickDelay(
 () => onOpen?.(folder),
 () => setEditing(true),
 );
 return (
 <tr
 className={clsx(
 'group transition-colors duration-150 hover:bg-slate-50 dark:hover:bg-slate-800/40',
 selected && 'bg-brand-50 dark:bg-brand-500/10',
 dragHover && 'ring-2 ring-inset ring-brand-500',
 )}
 onDragOver={(e) => {
 if (e.dataTransfer.types.includes('application/x-file-id')) {
 e.preventDefault();
 setDragHover(true);
 }
 }}
 onDragLeave={() => setDragHover(false)}
 onDrop={(e) => {
 setDragHover(false);
 const id = e.dataTransfer.getData('application/x-file-id');
 if (id) {
 e.preventDefault();
 onDropFile?.(id, folder.id);
 }
 }}
 >
 <td className="px-3 py-2">
 <input
 type="checkbox"
 checked={!!selected}
 onChange={(e) => onSelect?.(e.target.checked, e.nativeEvent)}
 />
 </td>
 <td className="px-3 py-2">
 <div className="flex items-center gap-2">
 <FolderIcon className="h-5 w-5 shrink-0 text-amber-500" />
 {editing ? (
 <EditableName
 value={folder.name}
 onSubmit={(name) => {
 setEditing(false);
 onRenameSubmit?.(folder, name);
 }}
 onCancel={() => setEditing(false)}
 />
 ) : (
 <button
 {...nameClick}
 title="Double-click to rename"
 className="truncate text-left font-medium text-slate-900 dark:text-slate-100"
 >
 {folder.name}
 </button>
 )}
 </div>
 </td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">Folder</td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">-</td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
 {formatDate(folder.updatedAt)}
 </td>
 <td className="px-3 py-2 text-right">
 <div className="flex justify-end">
 <ActionMenu
 label="Folder actions"
 items={[
 { label: 'Share', icon: Share2, onClick: () => onShare?.(folder) },
 { label: 'Rename', icon: Pencil, onClick: () => setEditing(true) },
 { label: 'Delete', icon: Trash2, danger: true, onClick: () => onDelete?.(folder) },
 ]}
 />
 </div>
 </td>
 </tr>
 );
}

export function FileRow({
 file,
 selected,
 onSelect,
 onPreview,
 onShare,
 onRenameSubmit,
 onDelete,
 onDownload,
 onTagsChanged,
 onTagClick,
 onStar,
}) {
 const currentUser = useAuth((s) => s.user);
 const owner = file.owner || (file.ownerId === currentUser?.id ? currentUser : null);
 const isMe = owner?.id === currentUser?.id;
 const ownerLabel = isMe ? 'you' : owner?.name || owner?.email || 'unknown';
 const [editingTags, setEditingTags] = useState(false);
 const [editing, setEditing] = useState(false);
 const nameClick = useClickDelay(
 () => onPreview?.(file),
 () => setEditing(true),
 );

 return (
 <tr
 className={clsx(
 'group transition-colors duration-150 hover:bg-slate-50 dark:hover:bg-slate-800/40',
 selected && 'bg-brand-50 dark:bg-brand-500/10',
 )}
 draggable
 onDragStart={(e) => {
 e.dataTransfer.effectAllowed = 'move';
 e.dataTransfer.setData('application/x-file-id', file.id);
 }}
 >
 <td className="px-3 py-2">
 <input
 type="checkbox"
 checked={!!selected}
 onChange={(e) => onSelect?.(e.target.checked, e.nativeEvent)}
 />
 </td>
 <td className="min-w-0 max-w-xs px-3 py-2 sm:max-w-md md:max-w-lg lg:max-w-xl">
 <div className="flex min-w-0 items-start gap-2">
 <button
 onClick={() => onStar?.(file)}
 className={clsx(
 'mt-1 shrink-0 rounded p-0.5 transition',
 file.starred
 ? 'text-amber-400 hover:text-amber-500'
 : 'text-slate-300 dark:text-slate-600 opacity-0 hover:text-amber-400 group-hover:opacity-100',
 )}
 title={file.starred ? 'Unstar' : 'Star'}
 >
 <Star className="h-4 w-4" fill={file.starred ? 'currentColor' : 'none'} />
 </button>
 <button
 onClick={() => onPreview?.(file)}
 className="flex shrink-0 items-center gap-2 text-left"
 >
 <BlobThumb file={file} className="h-8 w-8" />
 </button>
 <div className="min-w-0 flex-1">
 {editing ? (
 <EditableName
 value={file.name}
 onSubmit={(name) => {
 setEditing(false);
 onRenameSubmit?.(file, name);
 }}
 onCancel={() => setEditing(false)}
 />
 ) : (
 <button {...nameClick} title="Double-click to rename" className="block w-full text-left">
 <div className="truncate font-medium text-slate-900 dark:text-slate-100">{file.name}</div>
 <div className="text-xs text-slate-500 dark:text-slate-400">
 Uploaded by <span className="font-medium text-slate-600 dark:text-slate-300">{ownerLabel}</span> · {formatDate(file.createdAt)}
 </div>
 </button>
 )}
 <div className="relative mt-1 flex flex-wrap items-center gap-1">
 {(file.tags || []).map((t) => (
 <button
 key={t.id}
 onClick={() => onTagClick?.(t.name)}
 className="chip hover:bg-slate-200 dark:hover:bg-slate-800"
 title={`Filter by tag: ${t.name}`}
 >
 <TagIcon className="h-2.5 w-2.5" />
 {t.name}
 </button>
 ))}
 <button
 onClick={() => setEditingTags((x) => !x)}
 className="text-xs text-slate-400 dark:text-slate-500 opacity-0 hover:text-brand-600 group-hover:opacity-100"
 title="Edit tags"
 >
 {file.tags?.length ? 'Edit tags' : '+ Add tag'}
 </button>
 {editingTags && (
 <div className="absolute left-0 top-6 z-10 w-72">
 <TagsEditor
 file={file}
 onSaved={(nextTags) => {
 setEditingTags(false);
 onTagsChanged?.(file.id, nextTags);
 }}
 />
 </div>
 )}
 </div>
 </div>
 </div>
 </td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{file.mimeType}</td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
 {formatBytes(file.size)}
 </td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
 {formatDate(file.updatedAt)}
 </td>
 <td className="px-3 py-2 text-right">
 <div className="flex justify-end">
 <ActionMenu
 label="File actions"
 items={[
 { label: 'Download', icon: Download, onClick: () => onDownload?.(file) },
 { label: 'Share', icon: Share2, onClick: () => onShare?.(file) },
 { label: 'Rename', icon: Pencil, onClick: () => setEditing(true) },
 { label: 'Delete', icon: Trash2, danger: true, onClick: () => onDelete?.(file) },
 ]}
 />
 </div>
 </td>
 </tr>
 );
}
