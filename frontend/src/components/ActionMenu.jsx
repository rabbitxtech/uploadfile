import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical, ChevronDown } from 'lucide-react';
import clsx from 'clsx';

// A kebab (⋮) dropdown that gathers a row's actions into one menu. The panel is
// portal-rendered to <body> with fixed positioning computed from the trigger's
// rect, so it's never clipped by a table's `overflow-x-auto` / `overflow-hidden`
// (same approach as NotificationBell). `items` is an array of
// { label, icon?, onClick, danger? }; falsy/`hidden` entries are dropped so
// callers can inline conditionals.
const MENU_WIDTH = 184; // px (w-46-ish)

// `variant`: 'kebab' (default, bare ⋮ icon) or 'button' (a btn-secondary trigger
// with a custom `icon` + caret — e.g. a "+" New menu). `align`: which edge of the
// menu lines up with the trigger ('right' default, 'left' for left-side triggers).
export default function ActionMenu({
  items = [],
  label = 'Actions',
  buttonClassName,
  icon: Icon = MoreVertical,
  variant = 'kebab',
  align = 'right',
}) {
  const visible = items.filter((i) => i && !i.hidden);
  const asButton = variant === 'button';
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    let left = align === 'left' ? r.left : r.right - MENU_WIDTH;
    if (left + MENU_WIDTH > window.innerWidth - 8) left = window.innerWidth - 8 - MENU_WIDTH;
    if (left < 8) left = 8;
    let top = r.bottom + 4;
    // Flip above the trigger if it would overflow the viewport bottom.
    const estH = visible.length * 34 + 8;
    if (top + estH > window.innerHeight - 8) top = Math.max(8, r.top - estH - 4);
    setPos({ top, left });
  }, [open, visible.length, align]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  if (!visible.length) return null;

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((x) => !x);
        }}
        className={clsx(
          asButton
            ? clsx('btn-secondary', open && 'ring-2 ring-brand-500/40')
            : clsx(
                'rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white',
                open && 'bg-slate-100 text-slate-900 dark:bg-slate-700 dark:text-white',
              ),
          buttonClassName,
        )}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
      >
        <Icon className="h-4 w-4" />
        {asButton && <ChevronDown className="h-3.5 w-3.5 opacity-70" />}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: MENU_WIDTH }}
            className="z-50 overflow-hidden rounded-md border border-slate-200 bg-white py-1 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-800"
          >
            {visible.map((item, i) => (
              <button
                key={i}
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onClick?.();
                }}
                className={clsx(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left',
                  item.danger
                    ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10'
                    : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700/60',
                )}
              >
                {item.icon && <item.icon className="h-3.5 w-3.5 shrink-0" />}
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
