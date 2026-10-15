'use client';
import { Alert, Badge, Card, LargeTitle, SearchField, Segmented, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApi } from '@/lib/api';
import { dt } from '@/lib/format';
import { KycPanel, PaymentsPanel, StorefrontPanel } from './storefront';

type Status = 'CONNECTED' | 'NEEDS_SETUP' | 'LISTENING' | 'WAITING' | 'MANUAL' | 'STAND_IN' | 'REMOTE';
interface Item {
  id: string; group: string; name: string; with: string; summary: string; maturity: 'BUILT' | 'OUTBOX' | 'ENDPOINT' | 'MANUAL' | 'STUB'; direction: 'OUT' | 'IN' | 'BOTH'; keywords?: string; doc?: string;
  env?: Array<{ name: string; purpose: string; on: string; required?: boolean }>;
  endpoints?: Array<{ method: string; path: string; purpose: string; auth: string }>;
  outbox?: { kind: string; instructions: string[] };
  needs: string[]; configure?: { label: string; href: string };
  state: { status: Status; detail: string; env: Array<{ name: string; set: boolean | null }>; pending: number; delivered: number; lastDeliveredAt: string | null; oldestPendingAt: string | null };
}
interface Overview { groups: string[]; items: Item[]; outbox: Array<{ kind: string; instruction: string; pending: number; delivered: number }> }

const STATUS: Record<Status, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger'; bucket: 'working' | 'action' | 'hand' }> = {
  CONNECTED: { label: 'Connected', tone: 'success', bucket: 'working' },
  REMOTE: { label: 'Set elsewhere', tone: 'success', bucket: 'working' },
  LISTENING: { label: 'Ready for calls', tone: 'neutral', bucket: 'working' },
  NEEDS_SETUP: { label: 'Needs setup', tone: 'warning', bucket: 'action' },
  WAITING: { label: 'Needs a connector', tone: 'warning', bucket: 'action' },
  MANUAL: { label: 'By hand', tone: 'neutral', bucket: 'hand' },
  STAND_IN: { label: 'Stand-in', tone: 'neutral', bucket: 'hand' },
};
const MATURITY: Record<Item['maturity'], string> = {
  BUILT: 'Built in: needs configuring', OUTBOX: 'Meridian queues instructions; a connector delivers them', ENDPOINT: 'Meridian offers an API; the other system calls it',
  MANUAL: 'No connector: done by hand', STUB: 'Interface exists; a stand-in answers',
};
const DIRECTION: Record<Item['direction'], string> = { OUT: 'Meridian sends', IN: 'Meridian receives', BOTH: 'Both ways' };
const FILTERS = [{ value: 'all', label: 'All' }, { value: 'action', label: 'Needs action' }, { value: 'working', label: 'Working' }, { value: 'hand', label: 'By hand' }] as const;

export default function IntegrationPage() {
  return <Suspense fallback={<Spinner />}><Integrations /></Suspense>;
}

function Integrations() {
  const { data, error, loading } = useApi<Overview>('/integrations');
  const target = useSearchParams().get('item');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['value']>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  useEffect(() => {
    if (!target || !data) return;
    setOpen((s) => new Set(s).add(target));
    setQ(''); setFilter('all');
    const t = setTimeout(() => document.getElementById(`int-${target}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 80);
    return () => clearTimeout(t);
  }, [target, data]);

  const counts = useMemo(() => {
    const c = { working: 0, action: 0, hand: 0 };
    for (const i of data?.items ?? []) c[STATUS[i.state.status].bucket]++;
    return c;
  }, [data]);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.items ?? []).filter((i) => (filter === 'all' || STATUS[i.state.status].bucket === filter)
      && words.every((w) => `${i.name} ${i.with} ${i.group} ${i.summary} ${i.keywords ?? ''}`.toLowerCase().includes(w)));
  }, [data, q, filter]);
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <>
      <LargeTitle subtitle="Every connection between Meridian and another system: what it is for, how it connects, what you have to provide, and whether it is working. Only the super user sees this page. Keys are shown as set or not set, never their value.">Integration</LargeTitle>
      {error && <Alert>{error}</Alert>}
      {loading && !data && <Spinner />}
      {data && (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-3">
            <Count n={counts.working} label="Working" tone="text-success" />
            <Count n={counts.action} label="Need action" tone="text-warning" />
            <Count n={counts.hand} label="By hand or stand-in" tone="text-label2" />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="sm:flex-1"><SearchField label="Search integrations" placeholder="Search: SAP, SMS, courier, HLR…" value={q} onChange={setQ} /></div>
            <Segmented label="Show" value={filter} options={[...FILTERS]} onChange={setFilter} />
          </div>
          {shown.length === 0 && <Card><p className="text-subhead text-label2">No integration matches.</p></Card>}
          {data.groups.map((g) => {
            const items = shown.filter((i) => i.group === g);
            if (!items.length) return null;
            return (
              <section key={g} aria-labelledby={`g-${g}`}>
                <h2 id={`g-${g}`} className="mb-1.5 px-1 text-footnote font-semibold uppercase tracking-wide text-label2">{g}</h2>
                <ul className="space-y-3">
                  {items.map((i) => <li key={i.id}><Row item={i} open={open.has(i.id)} onToggle={() => toggle(i.id)} origin={origin} /></li>)}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function Count({ n, label, tone }: { n: number; label: string; tone: string }) {
  return <div className="rounded-card bg-surface p-3 shadow-card sm:p-4"><div className={`text-title1 font-bold tabular-nums ${tone}`}>{n}</div><div className="text-footnote text-label2">{label}</div></div>;
}

function Row({ item: i, open, onToggle, origin }: { item: Item; open: boolean; onToggle: () => void; origin: string }) {
  const st = STATUS[i.state.status];
  const panel = `int-panel-${i.id}`;
  return (
    <div id={`int-${i.id}`} className="scroll-mt-4 overflow-hidden rounded-card bg-surface shadow-card">
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={panel}
        className="flex min-h-[64px] w-full items-start gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">{i.name}</span>
          <span className="block text-footnote text-label2">{i.with}</span>
          <span className="mt-1 block text-subhead text-label2">{i.state.detail}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge tone={st.tone}>{st.label}</Badge>
          {i.state.pending > 0 && <span className="text-caption text-label2">{i.state.pending} waiting</span>}
          <span aria-hidden className={`text-label2 transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        </span>
      </button>
      {open && (
        <div id={panel} className="space-y-4 border-t border-separator px-4 py-4 text-subhead">
          <p>{i.summary}</p>
          <dl className="grid gap-x-6 gap-y-1 text-footnote sm:grid-cols-2">
            <div><dt className="inline text-label2">How it works: </dt><dd className="inline">{MATURITY[i.maturity]}</dd></div>
            <div><dt className="inline text-label2">Direction: </dt><dd className="inline">{DIRECTION[i.direction]}</dd></div>
          </dl>

          <Block title="What you need to do">
            <ul className="list-disc space-y-1 pl-5">{i.needs.map((n) => <li key={n}>{n}</li>)}</ul>
          </Block>

          {i.state.env.length > 0 && (
            <Block title="Settings in the environment">
              <ul className="divide-y divide-separator rounded-control bg-surface2">
                {i.env!.map((v, n) => {
                  const set = i.state.env[n]?.set;
                  return (
                    <li key={v.name} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
                      <div className="min-w-0 sm:flex-1"><code className="break-all text-footnote font-medium">{v.name}</code><div className="text-footnote text-label2">{v.purpose}</div></div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-caption text-label2">on {v.on === 'web' ? 'this portal' : `the ${v.on}`}{v.required ? ', required' : ''}</span>
                        {set === null ? <Badge>Not visible here</Badge> : <Badge tone={set ? 'success' : v.required ? 'warning' : 'neutral'}>{set ? 'Set' : 'Not set'}</Badge>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Block>
          )}

          {i.endpoints && i.endpoints.length > 0 && (
            <Block title={i.direction === 'OUT' ? 'API a connector uses' : 'API the other system calls'}>
              <ul className="space-y-2">
                {i.endpoints.map((e) => (
                  <li key={`${e.method} ${e.path}`} className="rounded-control bg-surface2 px-3 py-2">
                    <div className="flex items-start gap-2"><span className="shrink-0 rounded bg-label/10 px-1.5 py-0.5 text-caption font-semibold">{e.method}</span><code className="min-w-0 break-all text-footnote">{origin}{e.path}</code></div>
                    <div className="mt-1 text-footnote text-label2">{e.purpose}. <span className="whitespace-nowrap">Auth: {e.auth}.</span></div>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {i.outbox && (
            <Block title={`Instructions Meridian queues (${i.outbox.kind})`}>
              <div className="flex flex-wrap gap-1.5">{i.outbox.instructions.map((x) => <code key={x} className="rounded bg-surface2 px-2 py-0.5 text-footnote">{x}</code>)}</div>
              <p className="mt-2 text-footnote text-label2">
                {i.state.pending} waiting, {i.state.delivered} delivered{i.state.lastDeliveredAt ? `, last delivered ${dt(i.state.lastDeliveredAt)}` : ''}{i.state.oldestPendingAt ? `. Oldest waiting since ${dt(i.state.oldestPendingAt)}` : ''}.
              </p>
            </Block>
          )}

          {i.id === 'storefront' && <StorefrontPanel />}
          {i.id === 'stripe' && <PaymentsPanel />}
          {i.id === 'ekyc' && <KycPanel />}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-footnote">
            {i.configure && !['storefront', 'stripe', 'ekyc'].includes(i.id) && <Link href={i.configure.href} className="inline-flex min-h-[32px] items-center text-accent">{i.configure.label} ›</Link>}
            {i.doc && <span className="text-label2">Guide: docs/{i.doc}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return <div><h3 className="mb-1.5 text-footnote font-semibold uppercase tracking-wide text-label2">{title}</h3>{children}</div>;
}
