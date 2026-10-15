'use client';
import { createPortal } from 'react-dom';
import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const cx = (...p: Array<string | false | undefined>) => p.filter(Boolean).join(' ');
const control = 'min-h-tap w-full rounded-control border border-separator bg-surface px-3 text-body text-label placeholder:text-label2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50';

/**
 * Label + control + hint/error. The label is a real <label for>, and hint/error text is linked with aria-describedby,
 * so a field's accessible name is just its label (not "label hint hint hint").
 */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  const id = useId();
  const note = error ?? hint;
  const noteId = note ? `${id}-note` : undefined;
  const control = isValidElement(children) && typeof children.type !== 'string';
  return (
    <div>
      <label htmlFor={control ? id : undefined} className="mb-1 block text-subhead font-medium text-label">{label}</label>
      {control ? cloneElement(children as ReactElement<Record<string, unknown>>, { id, 'aria-describedby': noteId, 'aria-invalid': error ? true : undefined }) : children}
      {note && <span id={noteId} role={error ? 'alert' : undefined} className={cx('mt-1 block text-footnote', error ? 'text-danger' : 'text-label2')}>{note}</span>}
    </div>
  );
}
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(control, className)} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(control, 'py-2', className)} />;
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(control, className)} />;

export function Alert({ tone = 'danger', children }: { tone?: 'danger' | 'success' | 'info'; children: ReactNode }) {
  const t = { danger: 'bg-danger/10 text-danger', success: 'bg-success/10 text-success', info: 'bg-accent/10 text-accent' }[tone];
  return <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('rounded-control px-4 py-3 text-subhead', t)}>{children}</div>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'danger' | 'success' }) {
  return (
    <div className="rounded-card bg-surface p-4 shadow-card sm:p-5">
      <p className="text-footnote text-label2">{label}</p>
      <p className={cx('mt-1 text-title2 font-semibold tabular-nums sm:text-title1', tone === 'danger' && 'text-danger', tone === 'success' && 'text-success')}>{value}</p>
      {sub && <p className="mt-0.5 text-caption text-label2">{sub}</p>}
    </div>
  );
}

/** Horizontally scrollable table wrapper: keeps wide data usable at phone width. */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-mx-1 overflow-x-auto rounded-card bg-surface shadow-card"><table className="w-full min-w-[560px] text-left text-subhead">{children}</table></div>;
}
export const Th = ({ children, right }: { children?: ReactNode; right?: boolean }) => <th scope="col" className={cx('whitespace-nowrap border-b border-separator px-4 py-3 text-footnote font-medium text-label2', right && 'text-right')}>{children}</th>;
export const Td = ({ children, right, className }: { children?: ReactNode; right?: boolean; className?: string }) => <td className={cx('border-b border-separator px-4 py-3 align-top', right && 'text-right tabular-nums', className)}>{children}</td>;

export interface DataColumn<T> {
  key: string; label: string; render: (row: T) => ReactNode;
  /** The column that names the row: the card's title on a phone. */
  primary?: boolean; right?: boolean;
}
/**
 * A list of records that is a table on a desktop and a stack of cards on a phone. A table squeezed to phone width either scrolls sideways (hiding
 * its actions) or wraps every cell to a sliver; a card gives each record the full width: its name on top, one label and value per line, and the
 * actions as large buttons underneath.
 */
export function DataList<T>({ rows, columns, rowKey, actions, label }: { rows: T[]; columns: Array<DataColumn<T>>; rowKey: (row: T) => string; actions?: (row: T) => ReactNode; label: string }) {
  const title = columns.find((c) => c.primary) ?? columns[0]!;
  const rest = columns.filter((c) => c !== title);
  // Room a table needs: about 7.5rem a column and 13rem for the action buttons, rounded up to one of the widths globals.css knows.
  const need = columns.length * 120 + (actions ? 210 : 0);
  const needed = [720, 900, 1100, 1300, 1500].find((w) => need <= w) ?? 1500;
  // Which layout is shown depends on the width of the space the list is in, not of the screen (see .dl-* in globals.css): a settings page beside a
  // sidebar and a menu is narrow even on a wide monitor.
  return (
    <div className="dl-root" data-dl={needed}>
      <div className="dl-table overflow-x-auto rounded-card bg-surface shadow-card">
        <table className="w-full text-left text-subhead" aria-label={label}>
          <thead><tr>{columns.map((c) => <Th key={c.key} right={c.right}>{c.label}</Th>)}{actions && <Th><span className="sr-only">Actions</span></Th>}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)}>
                {columns.map((c) => <Td key={c.key} right={c.right}>{c.render(r)}</Td>)}
                {actions && <Td right><span className="flex flex-nowrap justify-end gap-2 whitespace-nowrap">{actions(r)}</span></Td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="dl-cards space-y-3" aria-label={label}>
        {rows.map((r) => (
          <li key={rowKey(r)} className="rounded-card border border-separator bg-surface p-4">
            <div className="min-w-0">{title.render(r)}</div>
            {rest.length > 0 && (
              <dl className="mt-3 divide-y divide-separator border-t border-separator">
                {rest.map((c) => (
                  <div key={c.key} className="flex items-baseline justify-between gap-4 py-2 text-subhead">
                    <dt className="shrink-0 text-label2">{c.label}</dt>
                    <dd className="min-w-0 text-right">{c.render(r)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {actions && <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(5.5rem,1fr))] gap-2 border-t border-separator pt-3">{actions(r)}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div role="status" aria-label={label} className="flex items-center gap-2 py-6 text-label2"><span className="h-4 w-4 animate-spin rounded-full border-2 border-label2 border-t-transparent" />{label}…</div>;
}
export const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-card bg-surface px-4 py-8 text-center text-subhead text-label2 shadow-card">{children}</p>;
export const SectionTitle = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="mb-3 mt-8 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 first:mt-0"><h2 className="min-w-0 text-title3 font-semibold">{children}</h2>{action && <div className="shrink-0 [&_button]:whitespace-nowrap">{action}</div>}</div>
);

/**
 * Accessible modal dialog: labelled, closes on Escape or backdrop click, moves focus in and returns it on close, and stops the page scrolling behind it.
 */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close])');
    first?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab' || !ref.current) return;
      const f = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea')];
      if (!f.length) return;
      const firstEl = f[0]!, lastEl = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; previous?.focus(); };
  }, [onClose]);
  if (typeof document === 'undefined') return null;
  // Rendered at the end of <body>: inside a page section that is animating (it has a transform) a fixed element is placed against that section, not the
  // screen, and sat under the phone's tab bar with its buttons out of reach.
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-end bg-black/40 p-0 sm:place-items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className={cx('max-h-[92dvh] w-full overflow-y-auto rounded-t-card bg-surface p-5 pb-[max(1.25rem,var(--sab,0px))] shadow-card sm:rounded-card sm:p-6', wide ? 'sm:max-w-2xl' : 'sm:max-w-md')}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-title3 font-semibold">{title}</h2>
          <button data-close aria-label="Close" onClick={onClose} className="-mr-2 -mt-2 min-h-tap min-w-tap rounded-full text-title3 text-label2 hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">×</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Small icon-only button with a required accessible name (e.g. the pencil on an offer panel). */
export function IconButton({ label, children, onClick, href, tone }: { label: string; children: ReactNode; onClick?: () => void; href?: string; tone?: 'danger' }) {
  const cls = cx('inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-full text-body hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', tone === 'danger' ? 'text-danger' : 'text-label2 hover:text-label');
  return href ? <a href={href} aria-label={label} title={label} className={cls}>{children}</a> : <button type="button" aria-label={label} title={label} onClick={onClick} className={cls}>{children}</button>;
}

export interface MenuItem { label: string; onSelect?: () => void; href?: string; tone?: 'danger'; disabled?: boolean; hidden?: boolean; divider?: boolean }

/**
 * The "more actions" button (⋯): one tidy control instead of a row of icons. Opens a menu below the button; closes on Escape, outside
 * click or selection; arrow keys move between items.
 */
export function MenuButton({ label, items, align = 'right' }: { label: string; items: MenuItem[]; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const shown = items.filter((i) => !i.hidden);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLElement>('button')?.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const els = [...(root.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([aria-disabled=true])') ?? [])];
        const i = els.indexOf(document.activeElement as HTMLElement);
        els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
      }
    };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    root.current?.querySelector<HTMLElement>('[role=menuitem]:not([aria-disabled=true])')?.focus();
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  const cls = (i: MenuItem) => cx('flex min-h-[40px] w-full items-center px-4 text-left text-subhead hover:bg-surface2 focus-visible:bg-surface2 focus-visible:outline-none', i.tone === 'danger' ? 'text-danger' : 'text-label', i.disabled && 'opacity-40');
  return (
    <div ref={root} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-full text-title3 leading-none text-label2 hover:bg-surface2 hover:text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">⋯</button>
      {open && (
        <div role="menu" aria-label={label} className={cx('absolute z-40 mt-1 w-56 overflow-hidden rounded-card border border-separator bg-surface py-1 shadow-card', align === 'right' ? 'right-0' : 'left-0')}>
          {shown.map((i, n) => (
            <div key={n}>
              {i.divider && <div role="separator" className="my-1 border-t border-separator" />}
              {i.href && !i.disabled
                ? <a role="menuitem" href={i.href} className={cls(i)}>{i.label}</a>
                : <button type="button" role="menuitem" aria-disabled={i.disabled || undefined} className={cls(i)} onClick={() => { if (i.disabled) return; setOpen(false); i.onSelect?.(); }}>{i.label}</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


/** A search field in the platform style: leading magnifier, clear button, `type=search` semantics. Controlled. */
export function SearchField({ value, onChange, placeholder = 'Search', label, className }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string; className?: string }) {
  return (
    <div className={cx('relative', className)}>
      <svg aria-hidden viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-label2"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
      <input type="search" role="searchbox" aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false}
        className={cx(control, 'rounded-[12px] bg-label/[.06] pl-10 pr-9 [&::-webkit-search-cancel-button]:hidden')} />
      {value && <button type="button" aria-label="Clear search" onClick={() => onChange('')} className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-label2 hover:bg-label/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">×</button>}
    </div>
  );
}

/** Footer for a list that arrives in pages: says how many are shown and fetches the next page on demand. */
export function LoadMore({ shown, hasMore, loading, onMore, noun = 'items' }: { shown: number; hasMore: boolean; loading: boolean; onMore: () => void; noun?: string }) {
  return (
    <div className="mt-3 flex flex-col items-center gap-2 py-2 text-footnote text-label2" aria-live="polite">
      <span>{shown.toLocaleString()} {noun} shown{hasMore ? '' : ' · that’s everything'}</span>
      {hasMore && <button type="button" onClick={onMore} disabled={loading} className="min-h-tap rounded-control bg-surface2 px-5 text-subhead font-medium text-accent hover:opacity-80 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{loading ? 'Loading…' : `Show more ${noun}`}</button>}
    </div>
  );
}
