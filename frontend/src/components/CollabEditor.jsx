// Task5 #6 — collaborative text/markdown editor (Yjs CRDT + CodeMirror 6).
// Connects to the /yjs/<fileId> y-websocket room; edits sync live across all
// editors with colored remote cursors (awareness). The text is persisted to
// MinIO as FileVersions via collab-save: a debounced autosave (only the "leader"
// client saves, to avoid duplicate versions) plus a manual Save button / Ctrl-S.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  Save, Users, Wifi, WifiOff,
  Bold, Italic, Strikethrough, Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks, Quote, Code, SquareCode,
  Link as LinkIcon, Image as ImageIcon, Table as TableIcon, Minus,
  Undo2, Redo2,
} from 'lucide-react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, EditorSelection } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { useAuth } from '../store/auth.js';
import { useTheme } from '../store/theme.js';
import { FileApi } from '../api/endpoints.js';

// Stable per-user cursor color from a string seed.
function userColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h}, 70%, 45%)`;
}

function wsBase() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/yjs`;
}

// Undo/redo wired to the Yjs UndoManager (the exact handlers yCollab binds to
// Ctrl+Z/Ctrl+Y). NOT CodeMirror's history `undo`/`redo`, which would also undo
// the initial document sync and wipe an unedited file on the first click.
const yUndo = yUndoManagerKeymap[0].run;
const yRedo = yUndoManagerKeymap[1].run;

// Wrap each selection range with `before`/`after` markers (e.g. ** for bold).
// With an empty selection the cursor lands between the markers so you can type.
function wrapSelection(view, before, after = before) {
  if (!view) return;
  view.dispatch(view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to);
    const insert = before + text + after;
    const anchor = range.from + before.length;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(anchor, anchor + text.length),
    };
  }));
  view.focus();
}

// Run `fn` for each distinct line touched by the selection. `fn(lineText)`
// returns the replacement for that line's leading marker as `{ to, insert }`
// where `to` is how many leading chars to drop (0 to only prepend).
function eachLine(view, fn) {
  if (!view) return;
  const { state } = view;
  const seen = new Set();
  const changes = [];
  for (const range of state.selection.ranges) {
    const from = state.doc.lineAt(range.from).number;
    const to = state.doc.lineAt(range.to).number;
    for (let n = from; n <= to; n += 1) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      const { drop = 0, insert } = fn(line.text);
      changes.push({ from: line.from, to: line.from + drop, insert });
    }
  }
  view.dispatch({ changes });
  view.focus();
}

// Prefix every selected line (lists, quote, task list).
function prefixLines(view, prefix) {
  eachLine(view, () => ({ insert: prefix }));
}

// Set a heading level, replacing any existing leading `#`s instead of stacking.
function setHeading(view, prefix) {
  eachLine(view, (text) => {
    const m = text.match(/^#{1,6}\s+/);
    return { drop: m ? m[0].length : 0, insert: prefix };
  });
}

// Insert a markdown link, using the selection (or "text") as the label and
// dropping the cursor on the url placeholder.
function insertLink(view) {
  if (!view) return;
  view.dispatch(view.state.changeByRange((range) => {
    const label = view.state.sliceDoc(range.from, range.to) || 'text';
    const insert = `[${label}](url)`;
    const urlFrom = range.from + label.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(urlFrom, urlFrom + 3),
    };
  }));
  view.focus();
}

// Insert a markdown image, selection becomes the alt text, cursor on the url.
function insertImage(view) {
  if (!view) return;
  view.dispatch(view.state.changeByRange((range) => {
    const alt = view.state.sliceDoc(range.from, range.to) || 'alt';
    const insert = `![${alt}](url)`;
    const urlFrom = range.from + alt.length + 4;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(urlFrom, urlFrom + 3),
    };
  }));
  view.focus();
}

// Wrap the selection in a fenced code block on its own lines.
function insertCodeBlock(view) {
  if (!view) return;
  view.dispatch(view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to);
    const insert = `\`\`\`\n${text}\n\`\`\``;
    const anchor = range.from + 4;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(anchor, anchor + text.length),
    };
  }));
  view.focus();
}

// Drop a block snippet (table, horizontal rule) on its own line.
function insertBlock(view, snippet) {
  if (!view) return;
  const { state } = view;
  const range = state.selection.main;
  const atLineStart = state.doc.lineAt(range.from).from === range.from;
  const insert = (atLineStart ? '' : '\n') + snippet;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length },
  });
  view.focus();
}

const TABLE_SNIPPET = '| Column | Column |\n| --- | --- |\n| Cell | Cell |\n';
const HR_SNIPPET = '\n---\n';

// Word / character counts for the status bar.
function countText(text) {
  const trimmed = text.trim();
  return { words: trimmed ? trimmed.split(/\s+/).length : 0, chars: text.length };
}

function CollabEditor({ file }, ref) {
  const { t } = useTranslation();
  const me = useAuth((s) => s.user);
  const token = useAuth((s) => s.token);
  const { theme } = useTheme();
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const saveRef = useRef(() => {});
  const [status, setStatus] = useState('connecting'); // connecting|synced|saving|saved|error|offline
  const [peers, setPeers] = useState(1);
  const [counts, setCounts] = useState({ words: 0, chars: 0 });

  // Dirty = typed since the last save ('editing') or a save that failed ('error').
  // PreviewModal queries this to warn before closing, and we guard tab close too.
  const dirty = status === 'editing' || status === 'error';
  useImperativeHandle(ref, () => ({
    isDirty: () => dirty,
    save: () => saveRef.current(),
  }), [dirty]);

  // Native browser warning if the tab is closed/refreshed with unsaved edits.
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Keep the latest save fn reachable from the Ctrl-S keymap (created once).
  useEffect(() => {
    let view;
    let provider;
    let saveTimer;
    let lastSaved = null;

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    provider = new WebsocketProvider(wsBase(), file.id, ydoc, {
      params: token ? { token } : {},
    });

    const name = me?.name || me?.email || 'You';
    provider.awareness.setLocalStateField('user', {
      name,
      color: userColor(me?.id || name),
    });

    // Only one client autosaves (lowest awareness clientID) to avoid each editor
    // minting its own FileVersion for the same content.
    const isLeader = () => {
      const ids = [...provider.awareness.getStates().keys()];
      return ids.length === 0 || provider.awareness.clientID === Math.min(...ids);
    };

    const doSave = async () => {
      const text = view ? view.state.doc.toString() : ytext.toString();
      if (text === lastSaved) {
        setStatus('saved');
        return;
      }
      setStatus('saving');
      try {
        await FileApi.collabSave(file.id, text);
        lastSaved = text;
        setStatus('saved');
      } catch (e) {
        setStatus('error');
        toast.error(e.response?.data?.error || t('editor.saveFailed'));
      }
    };
    saveRef.current = doSave;

    const scheduleAutosave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (isLeader()) doSave();
      }, 4000);
    };

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        /\.(md|markdown)$/i.test(file.name) || file.mimeType === 'text/markdown' ? markdown() : [],
        theme === 'dark' ? oneDark : [],
        yCollab(ytext, provider.awareness),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { saveRef.current(); return true; } },
          { key: 'Mod-b', preventDefault: true, run: (v) => { wrapSelection(v, '**'); return true; } },
          { key: 'Mod-i', preventDefault: true, run: (v) => { wrapSelection(v, '*'); return true; } },
          { key: 'Mod-k', preventDefault: true, run: (v) => { insertLink(v); return true; } },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            setStatus((s) => (s === 'saved' || s === 'synced' ? 'editing' : s));
            setCounts(countText(u.state.doc.toString()));
            scheduleAutosave();
          }
        }),
      ],
    });
    view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    setCounts(countText(view.state.doc.toString()));

    provider.on('status', ({ status: st }) => {
      setStatus((s) => (st === 'connected' ? (s === 'connecting' ? 'synced' : s) : 'offline'));
    });
    provider.on('sync', (isSynced) => {
      if (isSynced) {
        lastSaved = view.state.doc.toString();
        setCounts(countText(lastSaved));
        setStatus('synced');
      }
    });
    const onAwareness = () => setPeers(provider.awareness.getStates().size);
    provider.awareness.on('change', onAwareness);
    onAwareness();

    return () => {
      clearTimeout(saveTimer);
      provider.awareness.off('change', onAwareness);
      // Flush unsaved edits as the editor closes (Close button / Esc / Preview
      // toggle all unmount this). Not leader-gated: the closing tab must persist
      // its own edits. doSave() no-ops when text === lastSaved, and collab-save
      // dedupes by checksum, so an unedited file or a redundant flush makes no
      // new FileVersion. Text is read synchronously before view.destroy() below.
      doSave();
      view.destroy();
      viewRef.current = null;
      provider.destroy();
      ydoc.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  const statusLabel = {
    connecting: t('editor.connecting'),
    synced: t('editor.saved'),
    editing: t('editor.unsaved'),
    saving: t('editor.saving'),
    saved: t('editor.saved'),
    error: t('editor.saveFailed'),
    offline: t('editor.offline'),
  }[status];

  // Grouped toolbar actions; each group is separated by a divider. `sc` is an
  // optional keyboard-shortcut hint shown in the tooltip.
  const groups = [
    [
      { key: 'undo', Icon: Undo2, run: yUndo, sc: 'Ctrl+Z' },
      { key: 'redo', Icon: Redo2, run: yRedo, sc: 'Ctrl+Y' },
    ],
    [
      { key: 'h1', Icon: Heading1, run: (v) => setHeading(v, '# ') },
      { key: 'h2', Icon: Heading2, run: (v) => setHeading(v, '## ') },
      { key: 'h3', Icon: Heading3, run: (v) => setHeading(v, '### ') },
    ],
    [
      { key: 'bold', Icon: Bold, run: (v) => wrapSelection(v, '**'), sc: 'Ctrl+B' },
      { key: 'italic', Icon: Italic, run: (v) => wrapSelection(v, '*'), sc: 'Ctrl+I' },
      { key: 'strike', Icon: Strikethrough, run: (v) => wrapSelection(v, '~~') },
      { key: 'code', Icon: Code, run: (v) => wrapSelection(v, '`') },
    ],
    [
      { key: 'ul', Icon: List, run: (v) => prefixLines(v, '- ') },
      { key: 'ol', Icon: ListOrdered, run: (v) => prefixLines(v, '1. ') },
      { key: 'task', Icon: ListChecks, run: (v) => prefixLines(v, '- [ ] ') },
      { key: 'quote', Icon: Quote, run: (v) => prefixLines(v, '> ') },
    ],
    [
      { key: 'link', Icon: LinkIcon, run: insertLink, sc: 'Ctrl+K' },
      { key: 'image', Icon: ImageIcon, run: insertImage },
      { key: 'codeblock', Icon: SquareCode, run: insertCodeBlock },
      { key: 'table', Icon: TableIcon, run: (v) => insertBlock(v, TABLE_SNIPPET) },
      { key: 'hr', Icon: Minus, run: (v) => insertBlock(v, HR_SNIPPET) },
    ],
  ];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 rounded-lg border border-slate-200 bg-white/95 p-1 shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-800/95">
        {groups.map((group, gi) => (
          <div key={group[0].key} className="flex items-center gap-0.5">
            {gi > 0 && <span className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-600" />}
            {group.map((tl) => {
              const label = tl.sc
                ? `${t(`editor.toolbar.${tl.key}`)} (${tl.sc})`
                : t(`editor.toolbar.${tl.key}`);
              return (
                <button
                  key={tl.key}
                  type="button"
                  title={label}
                  aria-label={label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => tl.run(viewRef.current)}
                  className="rounded p-1.5 text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
                >
                  <tl.Icon className="h-4 w-4" />
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1">
          {status === 'offline' ? <WifiOff className="h-3.5 w-3.5 text-amber-500" /> : <Wifi className="h-3.5 w-3.5 text-emerald-500" />}
          {statusLabel}
        </span>
        <span className="inline-flex items-center gap-1">
          <Users className="h-3.5 w-3.5" /> {t('editor.collaborators', { count: peers })}
        </span>
        <span className="hidden sm:inline">
          {t('editor.stats', { words: counts.words, chars: counts.chars })}
        </span>
        <button onClick={() => saveRef.current()} className="btn-primary ml-auto py-1 text-xs" disabled={status === 'saving'}>
          <Save className="h-3.5 w-3.5" /> {status === 'saving' ? t('editor.saving') : t('editor.save')}
        </button>
      </div>
      <div
        ref={hostRef}
        className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 dark:border-slate-700"
      />
    </div>
  );
}

export default forwardRef(CollabEditor);
