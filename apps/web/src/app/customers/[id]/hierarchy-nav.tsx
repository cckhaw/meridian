'use client';
import { SearchField } from '@meridian/ui';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useDebounced, usePaged, type PagedState } from '@/lib/api';
import { label, money } from '@/lib/format';
import { useSegments } from '@/lib/segments';

const DOT: Record<string, string> = { ACTIVE: 'bg-success', SUSPENDED: 'bg-warning', PORTING_OUT: 'bg-warning', TERMINATED: 'bg-label2/50', PENDING: 'bg-warning', CLOSED: 'bg-label2/50' };
const Dot = ({ status }: { status: string }) => <span role="img" aria-label={label(status)} className={`h-2 w-2 shrink-0 rounded-full ${DOT[status] ?? 'bg-label2/50'}`} />;

const Chevron = ({ open }: { open: boolean }) => (
  <svg aria-hidden viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] ${open ? 'rotate-90' : ''}`}><path d="m9 6 6 6-6 6" /></svg>
);

const More = ({ list }: { list: PagedState<any> }) => list.hasMore
  ? <button onClick={list.loadMore} disabled={list.loadingMore} className="min-h-[36px] w-full rounded-control px-3 text-left text-footnote font-medium text-accent hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">{list.loadingMore ? 'Loading…' : `Show more (${list.items.length} shown)`}</button>
  : null;

const Initial = ({ name, square }: { name: string; square?: boolean }) => (
  <span aria-hidden className={`grid h-7 w-7 shrink-0 place-items-center bg-accent/12 text-footnote font-semibold text-accent ${square ? 'rounded-[8px]' : 'rounded-full'}`}>{(name.trim()[0] ?? '?').toUpperCase()}</span>
);

/** A row that is a link to another customer (group, parent, department, member). */
function CustomerLink({ id, name, hint, indent = 0 }: { id: string; name: string; hint?: string; indent?: number }) {
  return (
    <Link href={`/customers/${id}`} style={{ paddingLeft: 8 + indent * 14 }} className="flex min-h-[44px] items-center gap-2 rounded-control pr-2 text-subhead hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <Initial name={name} /><span className="min-w-0 flex-1"><span className="block truncate">{name}</span>{hint && <span className="block truncate text-caption text-label2">{hint}</span>}</span>
      <span aria-hidden className="text-label2">›</span>
    </Link>
  );
}

/** A collapsible section whose rows are fetched only when it is opened, a page at a time, with a search once it gets long. */
function Section({ title, count, url, defaultOpen = false, searchLabel, row, empty }: { title: string; count: number; url: (term: string) => string; defaultOpen?: boolean; searchLabel: string; row: (item: any) => ReactNode; empty?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const list = usePaged<any>(open ? url(term) : null);
  return (
    <div role="none">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-[40px] w-full items-center gap-2 rounded-control px-2 text-left text-footnote font-semibold uppercase tracking-wide text-label2 hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <Chevron open={open} /><span className="flex-1">{title}</span><span className="tabular-nums font-normal normal-case tracking-normal">{count.toLocaleString()}</span>
      </button>
      {open && (
        <div role="group" className="push-fwd pb-1 pl-2">
          {count > 8 && <div className="px-1 pb-1"><SearchField label={searchLabel} placeholder={searchLabel} value={q} onChange={setQ} /></div>}
          {list.loading && list.items.length === 0 && <p className="px-3 py-2 text-footnote text-label2">Loading…</p>}
          {!list.loading && list.items.length === 0 && <p className="px-3 py-2 text-footnote text-label2">{term ? 'No matches.' : empty ?? 'Nothing here.'}</p>}
          {list.items.map((it) => <div key={it.id} role="none">{row(it)}</div>)}
          <More list={list} />
        </div>
      )}
    </div>
  );
}

export interface NavProps {
  customer: { id: string; displayName: string; segment: string };
  ancestors: Array<{ id: string; displayName: string; segment: string }>;
  counts: { accounts: number; children: number };
  canBrowse: boolean;           // staff can move to other customers; a portal customer only sees their own
  canBilling: boolean;
  accountId: string | null;
  serviceId: string | null;
  onAccount: (id: string | null) => void;
  onService: (accountId: string, serviceId: string) => void;
}

/**
 * Where am I? Customer → account → service (with departments above or below), as one tree you can walk. Everything below the customer loads when you open it, a page at a time,
 * so an enterprise with thousands of departments, accounts and lines stays instant.
 */
export function HierarchyNav(p: NavProps) {
  const segs = useSegments();
  const onCustomer = !p.accountId;
  return (
    <nav aria-label="Customer, account and services" className="rounded-card bg-surface p-1.5 shadow-card">
      <div role="tree" aria-label="Hierarchy">
        {p.canBrowse && p.ancestors.length > 0 && (
          <div role="none" className="mb-1">
            <p className="px-2 pb-0.5 pt-1.5 text-caption font-semibold uppercase tracking-wide text-label2">Parent</p>
            {p.ancestors.map((a, i) => <CustomerLink key={a.id} id={a.id} name={a.displayName} hint={segs.name(a.segment)} indent={i} />)}
          </div>
        )}

        <div role="none" className="mt-1 border-t border-separator pt-1">
          <p className="px-2 pb-0.5 pt-1.5 text-caption font-semibold uppercase tracking-wide text-label2">Customer</p>
          <button role="treeitem" aria-selected={onCustomer} aria-current={onCustomer ? 'page' : undefined} onClick={() => p.onAccount(null)} style={{ marginLeft: p.ancestors.length * 14 }} className={`flex min-h-[44px] items-center gap-2 rounded-control px-2 text-left text-subhead focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${onCustomer ? 'bg-accent/12 font-semibold text-accent' : 'hover:bg-surface2'}`}>
            <Initial name={p.customer.displayName} /><span className="min-w-0 flex-1"><span className="block truncate">{p.customer.displayName}</span><span className="block truncate text-caption font-normal text-label2">{segs.name(p.customer.segment)}</span></span>
          </button>

          <div role="group" className="ml-3 border-l border-separator pl-1">
            <Section title="Accounts" count={p.counts.accounts} defaultOpen searchLabel="Find account" empty="No accounts yet."
              url={(t) => `/customers/${p.customer.id}/accounts?limit=10&q=${encodeURIComponent(t)}`}
              row={(a) => <AccountNode a={a} selected={p.accountId === a.id} serviceId={p.serviceId} canBilling={p.canBilling} onAccount={p.onAccount} onService={p.onService} />} />
            {p.canBrowse && p.counts.children > 0 && (
              <Section title="Departments" count={p.counts.children} searchLabel="Find department" url={(t) => `/customers/${p.customer.id}/children?limit=10&q=${encodeURIComponent(t)}`}
                row={(k) => <CustomerLink id={k.id} name={k.displayName} hint={`${segs.name(k.segment)} · ${(k.serviceCount ?? 0).toLocaleString()} services`} />} />
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}

function AccountNode({ a, selected, serviceId, canBilling, onAccount, onService }: { a: any; selected: boolean; serviceId: string | null; canBilling: boolean; onAccount: (id: string | null) => void; onService: (accountId: string, serviceId: string) => void }) {
  const [open, setOpen] = useState(selected);
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const list = usePaged<any>(open ? `/services?accountId=${a.id}&limit=10&q=${encodeURIComponent(term)}` : null);
  return (
    <div role="none">
      <div role="treeitem" aria-expanded={open} aria-selected={selected && !serviceId} className="flex items-center">
        <button aria-label={`${open ? 'Collapse' : 'Expand'} ${a.name}`} onClick={() => setOpen(!open)} className="grid h-11 w-8 shrink-0 place-items-center text-label2 hover:text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><Chevron open={open} /></button>
        <button onClick={() => { onAccount(a.id); setOpen(true); }} aria-current={selected && !serviceId ? 'page' : undefined}
          className={`flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-control px-2 text-left text-subhead focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${selected && !serviceId ? 'bg-accent/12 font-semibold text-accent' : 'hover:bg-surface2'}`}>
          <Dot status={a.status} />
          <span className="min-w-0 flex-1"><span className="block truncate">{a.name}</span>
            <span className="block truncate text-caption font-normal text-label2">{a.serviceCount.toLocaleString()} service{a.serviceCount === 1 ? '' : 's'}{canBilling && a.balanceMinor ? ` · ${money(a.balanceMinor, a.currency)} due` : ''}</span></span>
        </button>
      </div>
      {open && (
        <div role="group" className="push-fwd ml-5 border-l border-separator pl-1">
          {a.serviceCount > 8 && <div className="px-1 pb-1 pt-0.5"><SearchField label="Find number" placeholder="Number starts with…" value={q} onChange={setQ} /></div>}
          {list.loading && list.items.length === 0 && <p className="px-3 py-2 text-footnote text-label2">Loading…</p>}
          {!list.loading && list.items.length === 0 && <p className="px-3 py-2 text-footnote text-label2">{term ? 'No matches.' : 'No services.'}</p>}
          {list.items.map((s) => {
            const on = serviceId === s.id;
            return (
              <button key={s.id} role="treeitem" aria-selected={on} aria-current={on ? 'page' : undefined} onClick={() => onService(a.id, s.id)}
                className={`flex min-h-[40px] w-full items-center gap-2 rounded-control px-2 text-left text-subhead focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${on ? 'bg-accent/12 font-semibold text-accent' : 'hover:bg-surface2'}`}>
                <Dot status={s.status} /><span className="min-w-0 flex-1 truncate font-mono text-footnote">{s.identifier}</span>
              </button>
            );
          })}
          <More list={list} />
        </div>
      )}
    </div>
  );
}
