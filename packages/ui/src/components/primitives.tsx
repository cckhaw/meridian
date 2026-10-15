import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

const cx = (...p: Array<string | false | undefined>) => p.filter(Boolean).join(' ');
const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg';

type Variant = 'primary' | 'secondary' | 'plain' | 'destructive';
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90',
  secondary: 'border border-separator bg-surface2 text-label hover:opacity-80',
  plain: 'bg-transparent text-accent hover:bg-surface2',
  destructive: 'bg-danger text-white hover:opacity-90',
};

export function Button({ variant = 'primary', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button {...p} className={cx('inline-flex min-h-tap min-w-tap items-center justify-center gap-2 whitespace-nowrap rounded-control px-5 text-body font-medium transition active:scale-[.98] disabled:opacity-40', focus, variants[variant], className)} />;
}

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div {...p} className={cx('rounded-card bg-surface p-5 shadow-card sm:p-6', className)} />;
}

export function LargeTitle({ children, subtitle }: { children: ReactNode; subtitle?: ReactNode }) {
  return (
    <header className="mb-6 sm:mb-8">
      <h1 className="text-title1 font-bold tracking-tight sm:text-large-title">{children}</h1>
      {subtitle && <p className="mt-1 text-body text-label2">{subtitle}</p>}
    </header>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning' | 'danger'; children: ReactNode }) {
  const t = { neutral: 'bg-surface2 text-label2', success: 'bg-success/15 text-success', warning: 'bg-warning/15 text-warning', danger: 'bg-danger/15 text-danger' }[tone];
  return <span className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-caption font-medium', t)}>{children}</span>;
}

/** iOS-style segmented control (radiogroup semantics). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-nowrap overflow-x-auto rounded-control bg-surface2 p-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}
          className={cx('min-h-[36px] shrink-0 whitespace-nowrap rounded-[10px] px-4 text-subhead font-medium transition', focus, o.value === value ? 'bg-surface text-label shadow-card' : 'text-label2')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
