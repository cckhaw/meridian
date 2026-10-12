'use client';
import { PERSONAS, type Persona, type PersonaId } from '@nexus/types';
import { useState, type ReactNode } from 'react';
import { ThemeToggle } from './theme-toggle';

const ICON: Record<string, string> = { house: '⌂', people: '☺', list: '☰', grid: '▦', flow: '⇢', calendar: '▤', doc: '▭', tag: '◈', bag: '◫', box: '▣', person: '◉', bubble: '◌', cube: '◇', coins: '◎', swap: '⇄', ledger: '▥', check: '✓', shield: '⛨', gauge: '◔' };

export interface AppShellProps {
  persona: PersonaId;
  onPersonaChange: (id: PersonaId) => void;
  activeHref: string;
  linkComponent?: (p: { href: string; className: string; children: ReactNode; 'aria-current'?: 'page' }) => ReactNode;
  children: ReactNode;
}

/**
 * Responsive shell:
 *  - >= lg  : fixed translucent sidebar
 *  - md     : collapsible sidebar drawer
 *  - < md   : bottom tab bar (max 5 items) with safe-area padding, as on iOS
 */
export function AppShell({ persona, onPersonaChange, activeHref, linkComponent, children }: AppShellProps) {
  const [drawer, setDrawer] = useState(false);
  const current: Persona = PERSONAS.find((p) => p.id === persona) ?? PERSONAS[0]!;
  const Link = linkComponent ?? (({ href, className, children: c, ...r }) => <a href={href} className={className} {...r}>{c}</a>);

  const items = current.nav.map((n) => {
    const active = n.href === activeHref;
    return (
      <Link key={n.id} href={n.href} aria-current={active ? 'page' : undefined}
        className={`flex min-h-tap items-center gap-3 rounded-control px-3 text-body ${active ? 'bg-accent/10 font-semibold text-accent' : 'text-label hover:bg-surface2'}`}>
        <span aria-hidden className="w-6 text-center text-title3">{ICON[n.icon] ?? '•'}</span>{n.label}
      </Link>
    );
  });

  const switcher = (
    <label className="block">
      <span className="mb-1 block px-1 text-caption uppercase tracking-wide text-label2">Persona</span>
      <select value={persona} onChange={(e) => onPersonaChange(e.target.value as PersonaId)}
        className="min-h-tap w-full rounded-control bg-surface2 px-3 text-body text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {PERSONAS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
    </label>
  );

  return (
    <div className="min-h-dvh lg:pl-72">
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-separator bg-bg/70 px-4 pt-[var(--sat)] backdrop-blur-chrome lg:hidden">
        <button className="min-h-tap min-w-tap text-title3 max-md:hidden" aria-label="Menu" aria-expanded={drawer} onClick={() => setDrawer((d) => !d)}>☰</button>
        <span className="flex-1 truncate text-body font-semibold">Nexus · {current.label}</span>
        <ThemeToggle />
      </header>

      <aside className={`fixed inset-y-0 left-0 z-20 w-72 flex-col gap-4 border-r border-separator bg-bg/80 p-4 backdrop-blur-chrome max-md:hidden lg:flex ${drawer ? 'flex pt-20' : 'hidden'}`}>
        <div className="hidden items-center justify-between lg:flex"><span className="text-title3 font-bold">Nexus</span><ThemeToggle /></div>
        {switcher}
        <nav aria-label="Primary" className="flex flex-col gap-1">{items}</nav>
      </aside>

      <main className="mx-auto max-w-6xl px-4 pb-[calc(88px+var(--sab))] pt-6 sm:px-6 md:pb-10 md:pt-8 lg:px-10">
        <div className="mb-6 md:hidden">{switcher}</div>
        {children}
      </main>

      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t border-separator bg-bg/80 pb-[var(--sab)] backdrop-blur-chrome md:hidden">
        {current.nav.slice(0, 5).map((n) => {
          const active = n.href === activeHref;
          return (
            <Link key={n.id} href={n.href} aria-current={active ? 'page' : undefined}
              className={`flex min-h-[56px] min-w-tap flex-1 flex-col items-center justify-center text-caption ${active ? 'text-accent' : 'text-label2'}`}>
              <span aria-hidden className="text-title3 leading-none">{ICON[n.icon] ?? '•'}</span>{n.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
