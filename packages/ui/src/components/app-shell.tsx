'use client';
import { useState, type ReactNode } from 'react';
import { ThemeToggle } from './theme-toggle';

export interface NavItem { id: string; label: string; href: string; icon: string }
export interface ShellUser { name: string; roles: string[] }

const ICON: Record<string, string> = { house: '⌂', people: '☺', list: '☰', grid: '▦', flow: '⇢', calendar: '▤', doc: '▭', tag: '◈', bag: '◫', box: '▣', person: '◉', bubble: '◌', cube: '◇', coins: '◎', swap: '⇄', ledger: '▥', check: '✓', shield: '⛨', gauge: '◔' };

type LinkProps = { href: string; className: string; children: ReactNode; 'aria-current'?: 'page' };
export interface AppShellProps {
  nav: NavItem[];
  user: ShellUser;
  activeHref: string;
  onSignOut: () => void;
  onChangePassword: () => void;
  linkComponent?: (p: LinkProps) => ReactNode;
  children: ReactNode;
}

/** The module whose href is the longest prefix of the current path is "active" (so /orders/123 highlights Orders, not New order). */
function activeId(nav: NavItem[], path: string): string | undefined {
  const hit = nav.filter((n) => (n.href === '/' ? path === '/' : path === n.href || path.startsWith(n.href + '/'))).sort((a, b) => b.href.length - a.href.length)[0];
  return hit?.id;
}

/**
 * Responsive shell: sidebar on desktop, drawer on tablet, scrollable bottom tab bar on phones (with safe-area padding).
 * Navigation is whatever the server says this user may open; nothing is hard-coded per persona.
 */
export function AppShell({ nav, user, activeHref, onSignOut, onChangePassword, linkComponent, children }: AppShellProps) {
  const [drawer, setDrawer] = useState(false);
  const Link = linkComponent ?? (({ href, className, children: c, ...r }: LinkProps) => <a href={href} className={className} {...r}>{c}</a>);
  const active = activeId(nav, activeHref);

  const items = nav.map((n) => (
    <Link key={n.id} href={n.href} aria-current={n.id === active ? 'page' : undefined}
      className={`flex min-h-tap items-center gap-3 rounded-control px-3 text-body ${n.id === active ? 'bg-accent/10 font-semibold text-accent' : 'text-label hover:bg-surface2'}`}>
      <span aria-hidden className="w-6 text-center text-title3">{ICON[n.icon] ?? '•'}</span>{n.label}
    </Link>
  ));

  const account = (
    <div className="rounded-control bg-surface2 p-3">
      <p className="truncate font-medium">{user.name}</p>
      <p className="truncate text-footnote text-label2">{user.roles.join(' · ')}</p>
      <div className="mt-2 flex gap-2">
        <button onClick={onChangePassword} className="min-h-[36px] flex-1 rounded-control bg-surface px-3 text-subhead text-label hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Password</button>
        <button onClick={onSignOut} className="min-h-[36px] flex-1 rounded-control bg-surface px-3 text-subhead text-danger hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Sign out</button>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:pl-72">
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-separator bg-bg/70 px-4 pt-[var(--sat)] backdrop-blur-chrome lg:hidden">
        <button className="min-h-tap min-w-tap text-title3 max-md:hidden" aria-label="Menu" aria-expanded={drawer} onClick={() => setDrawer((d) => !d)}>☰</button>
        <span className="flex-1 truncate text-body font-semibold">Meridian</span>
        <span className="max-w-[40%] truncate text-footnote text-label2">{user.name}</span>
        <ThemeToggle />
        <button onClick={onSignOut} className="min-h-tap px-2 text-subhead text-accent md:hidden">Sign out</button>
      </header>

      <aside className={`fixed inset-y-0 left-0 z-20 w-72 flex-col gap-4 border-r border-separator bg-bg/80 p-4 backdrop-blur-chrome max-md:hidden lg:flex ${drawer ? 'flex pt-20' : 'hidden'}`}>
        <div className="hidden items-center justify-between lg:flex"><span className="text-title3 font-bold">Meridian</span><ThemeToggle /></div>
        <nav aria-label="Primary" className="flex flex-1 flex-col gap-1 overflow-y-auto">{items}</nav>
        {account}
      </aside>

      <main className="mx-auto max-w-6xl px-4 pb-[calc(88px+var(--sab))] pt-6 sm:px-6 md:pb-10 md:pt-8 lg:px-10">{children}</main>

      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 flex overflow-x-auto border-t border-separator bg-bg/80 pb-[var(--sab)] backdrop-blur-chrome md:hidden">
        {nav.map((n) => (
          <Link key={n.id} href={n.href} aria-current={n.id === active ? 'page' : undefined}
            className={`flex min-h-[56px] min-w-[76px] flex-1 shrink-0 flex-col items-center justify-center whitespace-nowrap px-2 text-caption ${n.id === active ? 'text-accent' : 'text-label2'}`}>
            <span aria-hidden className="text-title3 leading-none">{ICON[n.icon] ?? '•'}</span>{n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
