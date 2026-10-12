'use client';
import { useTheme } from '../theme';

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <button onClick={toggle} role="switch" aria-checked={dark} aria-label="Dark mode"
      className="inline-flex min-h-tap min-w-tap items-center justify-center rounded-full text-label2 hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <span aria-hidden className="text-xl">{dark ? '☾' : '☀︎'}</span>
    </button>
  );
}
