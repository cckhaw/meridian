'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Icon } from './icons';
import { ThemeToggle } from './theme-toggle';

export interface NavItem { id: string; label: string; href: string; icon: string }
export interface ShellUser { name: string; roles: string[] }
/** The operator's identity: their name, or their logo when one is uploaded (recommended 480×120px, shown at most 40px tall). */
export interface Brand { name: string; logoUrl?: string | null }

export function BrandMark({ brand, className = '' }: { brand: Brand; className?: string }) {
  return brand.logoUrl
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={brand.logoUrl} alt={brand.name} className={`max-h-10 w-auto max-w-[200px] object-contain object-left ${className}`} />
    : <span className={`truncate font-bold tracking-tight ${className}`}>{brand.name}</span>;
}

type LinkProps = { href: string; className: string; children: ReactNode; 'aria-current'?: 'page'; onClick?: () => void; title?: string };
export interface AppShellProps {
  nav: NavItem[];
  user: ShellUser;
  brand?: Brand;
  activeHref: string;
  onSignOut: () => void;
  onChangePassword: () => void;
  /** Where "My profile" lives. The name in the account block links to it. */
  profileHref?: string;
  linkComponent?: (p: LinkProps) => ReactNode;
  children: ReactNode;
}

/** The module whose href is the longest prefix of the current path is "active" (so /orders/123 highlights Orders, not New order). */
function activeId(nav: NavItem[], path: string): string | undefined {
  const hit = nav.filter((n) => (n.href === '/' ? path === '/' : path === n.href || path.startsWith(n.href + '/'))).sort((a, b) => b.href.length - a.href.length)[0];
  return hit?.id;
}

/** Sidebar sections: what you do, grouped by the job it belongs to. Modules not listed fall under "Back office". */
const GROUPS: Array<{ label: string; ids: string[] }> = [
  { label: '', ids: ['overview'] },
  { label: 'Sell', ids: ['sell', 'dealers', 'stores', 'storedesk'] },
  { label: 'Customers & service', ids: ['customers', 'orders', 'cases', 'mnp', 'kyc', 'fraud'] },
  { label: 'Money', ids: ['billing', 'finance', 'commission'] },
  { label: 'Products & stock', ids: ['catalog', 'inventory'] },
  { label: 'Administration', ids: ['users', 'settings', 'integrations', 'audit'] },
];
function grouped(nav: NavItem[]): Array<{ label: string; items: NavItem[] }> {
  const used = new Set<string>();
  const out = GROUPS.map((g) => ({ label: g.label, items: g.ids.map((id) => nav.find((n) => n.id === id)).filter(Boolean) as NavItem[] })).filter((g) => g.items.length);
  for (const g of out) for (const i of g.items) used.add(i.id);
  const rest = nav.filter((n) => !used.has(n.id));
  return rest.length ? [...out, { label: out.length ? 'Back office' : '', items: rest }] : out;
}

const KEY = 'meridian-sidebar';
const COLLAPSE_KEY = 'meridian-sidebar-collapse';
type SidebarMode = 'expanded' | 'rail' | 'hidden';
const iconFor = (n: NavItem) => (n.id in ID_ICON ? n.id : n.icon);
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/**
 * Responsive shell.
 *  - Desktop: a translucent sidebar, grouped by job. Collapsing it offers two ways: an icon rail (every place stays one click away, with its name on hover) or hiding it entirely
 *    for the full page width. Ctrl/⌘ + \ toggles between expanded and the way you last collapsed it. The choice is remembered.
 *  - Tablet: the same sidebar as a drawer.
 *  - Phone: a tab bar with the four main places and a "More" sheet for the rest.
 * Navigation is whatever the server says this user may open; nothing is hard-coded per persona.
 */
export function AppShell({ nav, user, brand = { name: 'Meridian' }, activeHref, onSignOut, onChangePassword, profileHref = '/profile', linkComponent, children }: AppShellProps) {
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [mode, setModeState] = useState<SidebarMode>('expanded');
  const [collapseMenu, setCollapseMenu] = useState(false);
  const rail = mode === 'rail';
  const Link = linkComponent ?? (({ href, className, children: c, ...r }: LinkProps) => <a href={href} className={className} {...r}>{c}</a>);
  const active = activeId(nav, activeHref);
  const groups = grouped(nav);

  const setMode = useCallback((m: SidebarMode) => {
    document.documentElement.dataset.sidebar = m;
    try { localStorage.setItem(KEY, m); if (m !== 'expanded') localStorage.setItem(COLLAPSE_KEY, m); } catch { /* private mode: still works for this visit */ }
    setModeState(m); setCollapseMenu(false);
  }, []);
  useEffect(() => { const m = document.documentElement.dataset.sidebar; setModeState(m === 'hidden' || m === 'rail' ? m : 'expanded'); }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && e.key === '\\')) return;
      e.preventDefault();
      let to: SidebarMode = 'hidden';
      try { if (localStorage.getItem(COLLAPSE_KEY) === 'rail') to = 'rail'; } catch { /* default */ }
      setMode(document.documentElement.dataset.sidebar === 'rail' || document.documentElement.dataset.sidebar === 'hidden' ? 'expanded' : to);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [setMode]);
  useEffect(() => {
    if (!collapseMenu) return;
    const close = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as HTMLElement).closest('[data-collapse-menu]')) setCollapseMenu(false); };
    document.addEventListener('keydown', close); document.addEventListener('mousedown', close);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('mousedown', close); };
  }, [collapseMenu]);
  useEffect(() => { setDrawer(false); setSheet(false); }, [activeHref]);
  useEffect(() => {
    if (!drawer && !sheet) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDrawer(false); setSheet(false); } };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [drawer, sheet]);

  const navList = (
    <nav aria-label="Primary" className="rail-nav flex flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-3 pb-3">
      {groups.map((g) => (
        <div key={g.label || 'top'} className="flex flex-col gap-0.5">
          {g.label && <p className="rail-hide px-3 pb-1 pt-1 text-caption font-semibold uppercase tracking-wider text-label2">{g.label}</p>}
          {g.label && <div aria-hidden className="rail-only mx-3 my-1 h-px bg-separator" />}
          {g.items.map((n) => {
            const on = n.id === active;
            return (
              <Link key={n.id} href={n.href} aria-current={on ? 'page' : undefined} title={rail ? n.label : undefined}
                className={`rail-center group flex min-h-[40px] items-center gap-3 rounded-[10px] px-2.5 text-[15px] transition-colors active:scale-[.99] ${focusRing} ${on ? 'bg-accent/15 font-semibold text-accent' : 'text-label hover:bg-label/[.06]'}`}>
                <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-[8px] ${on ? 'bg-accent text-accent-fg' : 'bg-label/[.07] text-label2 group-hover:text-label'}`}><Icon name={iconFor(n)} size={17} /></span>
                <span className="rail-hide truncate">{n.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );

  const account = (
    <div className="rail-account mx-3 mb-3 rounded-[14px] bg-label/[.05] p-2.5">
      <Link href={profileHref} aria-current={activeHref === profileHref ? 'page' : undefined} title="My profile" className={`flex items-center gap-2.5 rounded-[10px] rail-center hover:bg-label/[.05] ${focusRing}`}>
        <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent/15 text-subhead font-semibold text-accent">{initials(user.name)}</span>
        <div className="rail-hide min-w-0"><p className="truncate text-subhead font-medium">{user.name}</p><p className="truncate text-caption text-label2">{user.roles.join(' · ')} · My profile</p></div>
      </Link>
      <div className="rail-col mt-2 flex gap-1.5">
        <button onClick={onChangePassword} aria-label="Change password" title={rail ? 'Change password' : undefined} className={`flex min-h-[34px] max-lg:min-h-tap flex-1 items-center justify-center gap-1.5 rounded-[9px] bg-surface text-footnote hover:opacity-80 ${focusRing}`}><Icon name="key" size={15} /><span className="rail-hide">Password</span></button>
        <button onClick={onSignOut} aria-label="Sign out" title={rail ? 'Sign out' : undefined} className={`flex min-h-[34px] max-lg:min-h-tap flex-1 items-center justify-center gap-1.5 rounded-[9px] bg-surface text-footnote text-danger hover:opacity-80 ${focusRing}`}><Icon name="signout" size={15} /><span className="rail-hide">Sign out</span></button>
      </div>
    </div>
  );

  const sidebarHeader = (
    <div className="rail-col relative flex min-h-[56px] items-center gap-2 px-4">
      <span className="rail-hide min-w-0 flex-1"><BrandMark brand={brand} className="text-title3" /></span>
      <ThemeToggle />
      {rail ? (
        <button onClick={() => setMode('expanded')} aria-label="Expand sidebar" title="Expand sidebar (Ctrl or ⌘ + \\)"
          className={`inline-flex min-h-tap min-w-tap items-center justify-center rounded-full text-label2 hover:bg-label/[.07] hover:text-label ${focusRing}`}><Icon name="sidebar" size={20} /></button>
      ) : (
        <span data-collapse-menu className="relative">
          <button onClick={() => (drawer ? setDrawer(false) : setCollapseMenu((o) => !o))} aria-label="Collapse sidebar" aria-haspopup="menu" aria-expanded={collapseMenu} title="Collapse sidebar (Ctrl or ⌘ + \\)"
            className={`inline-flex min-h-tap min-w-tap items-center justify-center rounded-full text-label2 hover:bg-label/[.07] hover:text-label ${focusRing}`}><Icon name="sidebar" size={20} /></button>
          {collapseMenu && (
            <div role="menu" aria-label="Collapse the sidebar" className="material-thick absolute right-0 top-full z-50 mt-1 w-56 rounded-[12px] border border-separator p-1 shadow-card">
              <button role="menuitem" onClick={() => setMode('rail')} className={`flex min-h-tap w-full flex-col items-start justify-center rounded-[9px] px-3 text-left hover:bg-label/[.07] ${focusRing}`}><span className="text-subhead font-medium">Icons only</span><span className="text-caption text-label2">Keep a slim bar of icons</span></button>
              <button role="menuitem" onClick={() => setMode('hidden')} className={`flex min-h-tap w-full flex-col items-start justify-center rounded-[9px] px-3 text-left hover:bg-label/[.07] ${focusRing}`}><span className="text-subhead font-medium">Hide completely</span><span className="text-caption text-label2">Full width for the page</span></button>
            </div>
          )}
        </span>
      )}
    </div>
  );

  // Phone: four main places + More.
  const primary = nav.slice(0, 4);
  const moreActive = !!active && !primary.some((n) => n.id === active);

  return (
    <div className="shell-content min-h-dvh lg:pl-64">
      {/* Phone / tablet top bar */}
      <header className="material sticky top-0 z-30 flex items-center gap-1 border-b border-separator px-3 pt-[var(--sat)] lg:hidden">
        <button className={`hidden min-h-tap min-w-tap items-center justify-center rounded-full text-label2 hover:bg-label/[.07] md:inline-flex ${focusRing}`} aria-label="Menu" aria-expanded={drawer} onClick={() => setDrawer((d) => !d)}><Icon name="sidebar" size={22} /></button>
        <span className="flex min-w-0 flex-1 items-center px-1 py-1"><BrandMark brand={brand} className="text-body" /></span>
        <ThemeToggle />
        <button onClick={onSignOut} className={`min-h-tap rounded-control px-2 text-subhead text-accent md:hidden ${focusRing}`}>Sign out</button>
      </header>

      {/* Desktop: reveal button, only present while the sidebar is hidden */}
      <div className="shell-reveal fixed left-3 top-3 z-30 items-center gap-1 rounded-full border border-separator p-1 material-thick shadow-card">
        <button onClick={() => setMode('expanded')} aria-label="Show sidebar" title="Show sidebar (Ctrl or ⌘ + \)" aria-expanded={mode !== 'hidden'}
          className={`inline-flex min-h-tap min-w-tap items-center justify-center rounded-full text-label hover:bg-label/[.07] ${focusRing}`}><Icon name="sidebar" size={20} /></button>
        <span className="pr-3"><BrandMark brand={brand} className="text-subhead" /></span>
      </div>

      {/* Scrim behind the tablet drawer */}
      {drawer && <button aria-label="Close menu" onClick={() => setDrawer(false)} className="fixed inset-0 z-10 bg-black/30 max-md:hidden lg:hidden" />}

      <aside aria-label="Sidebar" className={`shell-sidebar material-thick fixed inset-y-0 left-0 z-20 w-64 flex-col border-r border-separator max-md:hidden lg:flex ${drawer ? 'flex' : 'hidden'}`} style={drawer ? { transform: 'none' } : undefined}>
        {sidebarHeader}
        {navList}
        {account}
      </aside>

      <main className="shell-main mx-auto max-w-6xl px-4 pb-[calc(96px+var(--sab))] pt-6 sm:px-6 md:pb-10 md:pt-8 lg:px-10 lg:pt-8">{children}</main>

      {/* Phone tab bar */}
      <nav aria-label="Main tabs" className="material fixed inset-x-0 bottom-0 z-30 flex border-t border-separator pb-[var(--sab)] md:hidden">
        {primary.map((n) => (
          <Link key={n.id} href={n.href} aria-current={n.id === active ? 'page' : undefined}
            className={`flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] ${focusRing} ${n.id === active ? 'text-accent' : 'text-label2'}`}>
            <Icon name={iconFor(n)} size={24} /><span className="max-w-full truncate">{n.label}</span>
          </Link>
        ))}
        {nav.length > 4 && (
          <button onClick={() => setSheet(true)} aria-haspopup="dialog" aria-expanded={sheet}
            className={`flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] ${focusRing} ${moreActive ? 'text-accent' : 'text-label2'}`}><Icon name="more" size={24} /><span>More</span></button>
        )}
      </nav>

      {/* Phone "More" sheet: every place, grouped, as large tap targets */}
      {sheet && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="All sections">
          <button aria-label="Close" className="absolute inset-0 bg-black/40" onClick={() => setSheet(false)} />
          <div className="sheet-in material-thick absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-[22px] border-t border-separator px-4 pb-[calc(20px+var(--sab))] pt-3">
            <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-label/20" aria-hidden />
            {groups.map((g) => (
              <section key={g.label || 'top'} className="mb-4">
                {g.label && <h2 className="mb-1 px-1 text-caption font-semibold uppercase tracking-wider text-label2">{g.label}</h2>}
                <div className="grid grid-cols-3 gap-2">
                  {g.items.map((n) => (
                    <Link key={n.id} href={n.href} aria-current={n.id === active ? 'page' : undefined} onClick={() => setSheet(false)}
                      className={`flex min-h-[76px] flex-col items-center justify-center gap-1 rounded-[14px] px-1 text-center text-footnote ${focusRing} ${n.id === active ? 'bg-accent/15 text-accent' : 'bg-label/[.05] text-label'}`}>
                      <Icon name={iconFor(n)} size={24} /><span className="max-w-full truncate">{n.label}</span>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
            <Link href={profileHref} onClick={() => setSheet(false)} className={`mb-2 flex min-h-tap items-center gap-3 rounded-control bg-label/[.05] px-3 ${focusRing}`}>
              <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent/15 text-subhead font-semibold text-accent">{initials(user.name)}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-subhead font-medium">{user.name}</span><span className="block truncate text-caption text-label2">My profile</span></span><span aria-hidden className="text-label2">›</span>
            </Link>
            <div className="flex gap-2">
              <button onClick={() => { setSheet(false); onChangePassword(); }} className={`flex min-h-tap flex-1 items-center justify-center gap-2 rounded-control bg-label/[.05] ${focusRing}`}><Icon name="key" size={18} />Password</button>
              <button onClick={onSignOut} className={`flex min-h-tap flex-1 items-center justify-center gap-2 rounded-control bg-label/[.05] text-danger ${focusRing}`}><Icon name="signout" size={18} />Sign out</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Modules that have their own icon (anything else falls back to the icon name the server sent). */
const ID_ICON: Record<string, true> = { overview: true, customers: true, sell: true, dealers: true, stores: true, orders: true, billing: true, cases: true, kyc: true, mnp: true, catalog: true, inventory: true, finance: true, commission: true, users: true, settings: true, integrations: true, migration: true, audit: true, account: true };
