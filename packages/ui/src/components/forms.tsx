import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

const cx = (...p: Array<string | false | undefined>) => p.filter(Boolean).join(' ');
const control = 'min-h-tap w-full rounded-control border border-separator bg-surface px-3 text-body text-label placeholder:text-label2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50';

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-subhead font-medium text-label">{label}</span>
      {children}
      {error ? <span role="alert" className="mt-1 block text-footnote text-danger">{error}</span> : hint ? <span className="mt-1 block text-footnote text-label2">{hint}</span> : null}
    </label>
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
