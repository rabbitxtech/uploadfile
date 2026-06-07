import { useMemo, useState } from 'react';
import { ChevronRight, Folder as FolderIcon, FolderOpen } from 'lucide-react';
import clsx from 'clsx';

function buildTree(folders) {
 const byParent = new Map();
 for (const f of folders) {
 const k = f.parentId || 'root';
 if (!byParent.has(k)) byParent.set(k, []);
 byParent.get(k).push(f);
 }
 return byParent;
}

function Node({ folder, byParent, depth, currentId, onPick, expandedIds, setExpandedIds, onDropFile }) {
 const children = byParent.get(folder.id) || [];
 const hasChildren = children.length > 0;
 const isOpen = expandedIds.has(folder.id);
 const isActive = currentId === folder.id;
 const [hover, setHover] = useState(false);

 const toggle = (e) => {
 e.stopPropagation();
 setExpandedIds((cur) => {
 const next = new Set(cur);
 if (isOpen) next.delete(folder.id);
 else next.add(folder.id);
 return next;
 });
 };

 return (
 <div>
 <button
 onClick={() => onPick(folder.id)}
 onDragOver={(e) => {
 if (e.dataTransfer.types.includes('application/x-file-id')) {
 e.preventDefault();
 setHover(true);
 }
 }}
 onDragLeave={() => setHover(false)}
 onDrop={(e) => {
 setHover(false);
 const id = e.dataTransfer.getData('application/x-file-id');
 if (id) {
 e.preventDefault();
 onDropFile?.(id, folder.id);
 }
 }}
 className={clsx(
 'group flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-sm transition',
 isActive
 ? 'bg-brand-600 text-white'
 : 'text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800',
 hover && 'ring-2 ring-brand-500',
 )}
 style={{ paddingLeft: `${depth * 12 + 6}px` }}
 >
 <span
 onClick={hasChildren ? toggle : undefined}
 className={clsx(
 'flex h-4 w-4 shrink-0 items-center justify-center',
 hasChildren ? 'cursor-pointer' : 'opacity-0',
 )}
 >
 <ChevronRight
 className={clsx('h-3.5 w-3.5 transition-transform', isOpen && 'rotate-90')}
 />
 </span>
 {isOpen ? (
 <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
 ) : (
 <FolderIcon className="h-4 w-4 shrink-0 text-amber-500" />
 )}
 <span className="truncate">{folder.name}</span>
 </button>
 {isOpen && hasChildren && (
 <div>
 {children.map((c) => (
 <Node
 key={c.id}
 folder={c}
 byParent={byParent}
 depth={depth + 1}
 currentId={currentId}
 onPick={onPick}
 expandedIds={expandedIds}
 setExpandedIds={setExpandedIds}
 onDropFile={onDropFile}
 />
 ))}
 </div>
 )}
 </div>
 );
}

export default function FolderTree({ folders, currentId, onPick, onDropFile }) {
 const byParent = useMemo(() => buildTree(folders || []), [folders]);
 const roots = byParent.get('root') || [];
 const [expanded, setExpanded] = useState(() => new Set());
 const [rootHover, setRootHover] = useState(false);

 return (
 <div className="flex flex-col gap-0.5">
 <button
 onClick={() => onPick(null)}
 onDragOver={(e) => {
 if (e.dataTransfer.types.includes('application/x-file-id')) {
 e.preventDefault();
 setRootHover(true);
 }
 }}
 onDragLeave={() => setRootHover(false)}
 onDrop={(e) => {
 setRootHover(false);
 const id = e.dataTransfer.getData('application/x-file-id');
 if (id) {
 e.preventDefault();
 onDropFile?.(id, null);
 }
 }}
 className={clsx(
 'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition',
 currentId === null
 ? 'bg-brand-600 text-white'
 : 'text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800',
 rootHover && 'ring-2 ring-brand-500',
 )}
 >
 <FolderIcon className="h-4 w-4 shrink-0 text-amber-500" />
 <span className="truncate">Root</span>
 </button>
 {roots.map((f) => (
 <Node
 key={f.id}
 folder={f}
 byParent={byParent}
 depth={1}
 currentId={currentId}
 onPick={onPick}
 expandedIds={expanded}
 setExpandedIds={setExpanded}
 onDropFile={onDropFile}
 />
 ))}
 {roots.length === 0 && (
 <div className="px-2 py-2 text-xs text-slate-500 dark:text-slate-400">No folders yet</div>
 )}
 </div>
 );
}
