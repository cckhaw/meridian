'use client';
import { cloneElement, isValidElement, useEffect, useId, useRef, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

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

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div role="status" aria-label={label} className="flex items-center gap-2 py-6 text-label2"><span className="h-4 w-4 animate-spin rounded-full border-2 border-label2 border-t-transparent" />{label}…</div>;
}
export const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-card bg-surface px-4 py-8 text-center text-subhead text-label2 shadow-card">{children}</p>;
export const SectionTitle = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="mb-3 mt-8 flex items-center justify-between gap-3 first:mt-0"><h2 className="text-title3 font-semibold">{children}</h2>{action}</div>
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
  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-black/40 p-0 sm:place-items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className={cx('max-h-[92dvh] w-full overflow-y-auto rounded-t-card bg-surface p-5 shadow-card sm:rounded-card sm:p-6', wide ? 'sm:max-w-2xl' : 'sm:max-w-md')}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-title3 font-semibold">{title}</h2>
          <button data-close aria-label="Close" onClick={onClose} className="-mr-2 -mt-2 min-h-tap min-w-tap rounded-full text-title3 text-label2 hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Small icon-only button with a required accessible name (e.g. the pencil on an offer panel). */
export function IconButton({ label, children, onClick, href, tone }: { label: string; children: ReactNode; onClick?: () => void; href?: string; tone?: 'danger' }) {
  const cls = cx('inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-full text-body hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', tone === 'danger' ? 'text-danger' : 'text-label2 hover:text-label');
  return href ? <a href={href} aria-label={label} title={label} className={cls}>{children}</a> : <button type="button" aria-label={label} title={label} onClick={onClick} className={cls}>{children}</button>;
}
