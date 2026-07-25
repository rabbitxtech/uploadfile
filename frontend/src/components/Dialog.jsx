import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Pencil, X } from 'lucide-react';
import clsx from 'clsx';

// Imperative dialog API. Call confirmDialog(...) / promptDialog(...) anywhere;
// <DialogHost /> mounted at the app root renders the current dialog.
//
// confirmDialog returns a boolean by default. If `checkbox: { label, initial }`
// is passed, it returns `{ ok, checked }` instead so callers can read the
// checkbox state (e.g. "apply to all remaining").

let push;
const subscribe = (fn) => {
 push = fn;
};

export function confirmDialog(opts) {
 return new Promise((resolve) => {
 push?.({ kind: 'confirm', ...opts, resolve });
 });
}

export function promptDialog(opts) {
 return new Promise((resolve) => {
 push?.({ kind: 'prompt', ...opts, resolve });
 });
}

export function DialogHost() {
 const { t } = useTranslation();
 const [dlg, setDlg] = useState(null);
 const [value, setValue] = useState('');
 const [checked, setChecked] = useState(false);
 const inputRef = useRef(null);
 const confirmBtnRef = useRef(null);

 useEffect(() => {
 subscribe((d) => {
 setValue(d?.defaultValue ?? '');
 setChecked(!!d?.checkbox?.initial);
 setDlg(d);
 });
 return () => subscribe(() => {});
 }, []);

 useEffect(() => {
 if (!dlg) return;
 const onKey = (e) => {
 if (e.key === 'Escape') close(false);
 if (e.key === 'Enter' && dlg.kind === 'confirm') accept();
 };
 window.addEventListener('keydown', onKey);
 const t = setTimeout(() => {
 if (dlg.kind === 'prompt') inputRef.current?.select();
 else confirmBtnRef.current?.focus();
 }, 30);
 return () => {
 window.removeEventListener('keydown', onKey);
 clearTimeout(t);
 };
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [dlg]);

 const close = (ok) => {
 if (!dlg) return;
 if (dlg.kind === 'confirm') {
 const result = dlg.checkbox ? { ok: !!ok, checked } : !!ok;
 dlg.resolve(result);
 } else {
 // prompt: ok=true returns value, ok=false returns null
 dlg.resolve(ok ? value : null);
 }
 setDlg(null);
 };

 const accept = () => close(true);

 if (!dlg) return null;

 const variant = dlg.variant || (dlg.kind === 'confirm' ? 'danger' : 'default');
 const isDanger = variant === 'danger';
 const Icon = dlg.kind === 'prompt' ? Pencil : AlertTriangle;

 return (
 <div
 className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm animate-[fadeIn_120ms_ease-out]"
 onMouseDown={(e) => {
 if (e.target === e.currentTarget) close(false);
 }}
 >
 <div
 role="dialog"
 aria-modal="true"
 className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 shadow-2xl ring-1 ring-slate-200 dark:ring-slate-700 animate-[popIn_140ms_ease-out]"
 >
 <div className="flex items-start gap-3 p-5">
 <div
 className={clsx(
 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
 isDanger
 ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
 : 'bg-brand-100 dark:bg-brand-500/20 text-brand-600 dark:text-brand-400',
 )}
 >
 <Icon className="h-5 w-5" />
 </div>
 <div className="flex-1">
 <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
 {/* A caller-supplied title wins; only the fallback is translated. */}
 {dlg.title || (dlg.kind === 'prompt' ? t('dialog.promptTitle') : t('dialog.title'))}
 </h2>
 {dlg.message && (
 <p className="mt-1 text-sm text-slate-600 dark:text-slate-300 whitespace-pre-line">{dlg.message}</p>
 )}
 {dlg.kind === 'prompt' && (
 <input
 ref={inputRef}
 className="input mt-3"
 placeholder={dlg.placeholder || ''}
 value={value}
 onChange={(e) => setValue(e.target.value)}
 onKeyDown={(e) => {
 if (e.key === 'Enter') {
 e.preventDefault();
 accept();
 }
 }}
 />
 )}
 {dlg.kind === 'confirm' && dlg.checkbox && (
 <label className="mt-3 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 cursor-pointer select-none">
 <input
 type="checkbox"
 className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 text-brand-600 dark:text-brand-400 focus:ring-brand-500"
 checked={checked}
 onChange={(e) => setChecked(e.target.checked)}
 />
 {dlg.checkbox.label}
 </label>
 )}
 </div>
 <button
 onClick={() => close(false)}
 className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
 aria-label={t('dialog.close')}
 >
 <X className="h-4 w-4" />
 </button>
 </div>
 <div className="flex justify-end gap-2 rounded-b-xl bg-slate-50 dark:bg-slate-900/60 px-5 py-3">
 <button className="btn-secondary" onClick={() => close(false)}>
 {dlg.cancelText || t('common.cancel')}
 </button>
 <button
 ref={confirmBtnRef}
 className={isDanger ? 'btn-danger' : 'btn-primary'}
 onClick={accept}
 >
 {dlg.confirmText || (dlg.kind === 'prompt' ? t('dialog.ok') : t('dialog.confirm'))}
 </button>
 </div>
 </div>
 </div>
 );
}
