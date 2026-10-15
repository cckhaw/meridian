'use client';
import { Alert, Badge, Card, Empty, LargeTitle, SearchField, Spinner } from '@meridian/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useApi } from '@/lib/api';
import { Deliveries, Events, Gateway, Webhooks, useHub, type Hub } from './integration-hub';
import { GROUPS, SECTIONS, searchSections, sectionById, type IntegrationSection } from './sections';
import { Count, STATUS, SystemList, type Item, type Overview } from './systems';

/**
 * Integration: one menu of sections on the left (grouped by what you are trying to do, searchable) and the chosen section on the right, the same way Settings works.
 * On a phone the menu is the first screen and a section slides in over it. The section is in the address (?section=…) so it can be linked and Back works.
 */
export default function IntegrationPage() {
  return <Suspense fallback={<Spinner />}><Integration /></Suspense>;
}

const itemsOf = (ov: Overview | null | undefined, s: IntegrationSection): Item[] => (ov?.items ?? []).filter((i) => s.groups?.includes(i.group));
const needsAction = (i: Item) => STATUS[i.state.status].bucket === 'action';

function Integration() {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const current = sectionById(sp.get('section'));
  const target = sp.get('item');
  const [q, setQ] = useState('');
  const ov = useApi<Overview>('/integrations');
  const hub = useHub();
  const open = (id: string | null, item?: string) => router.push(id ? `${path}?section=${id}${item ? `&item=${item}` : ''}` : path, { scroll: false });

  // Older addresses still land in the right place: ?item=stripe finds the section that holds it, ?view=hub is API access.
  useEffect(() => {
    if (sp.get('view') === 'hub' && !sp.get('section')) router.replace(`${path}?section=api-access`);
    if (target && !sp.get('section') && ov.data) {
      const it = ov.data.items.find((i) => i.id === target);
      const sec = it && SECTIONS.find((s) => s.groups?.includes(it.group));
      router.replace(sec ? `${path}?section=${sec.id}&item=${target}` : path);
    }
  }, [sp, target, ov.data, router, path]);

  const attention = (s: IntegrationSection) => itemsOf(ov.data, s).filter(needsAction).length;
  const found = searchSections(q);
  // Searching also finds a system by name, e.g. "SAP" or "Kafka", and takes you to its section.
  const byName = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [] as Item[];
    return (ov.data?.items ?? []).filter((i) => words.every((w) => `${i.name} ${i.with} ${i.summary} ${i.keywords ?? ''}`.toLowerCase().includes(w)));
  }, [q, ov.data]);
  const hitSections = new Set([...found.map((s) => s.id), ...byName.map((i) => SECTIONS.find((s) => s.groups?.includes(i.group))?.id).filter(Boolean) as string[]]);

  const menu = (
    <nav aria-label="Integration sections" className="space-y-5">
      <SearchField label="Search integrations" placeholder="Search: SAP, SMS, Kafka, courier…" value={q} onChange={setQ} />
      {hitSections.size === 0 && <Empty>Nothing matches “{q}”.</Empty>}
      {GROUPS.map((g) => {
        const items = SECTIONS.filter((s) => s.group === g && hitSections.has(s.id));
        if (!items.length) return null;
        return (
          <div key={g}>
            <h2 className="mb-1.5 px-3 text-footnote font-semibold uppercase tracking-wide text-label2">{g}</h2>
            <ul className="overflow-hidden rounded-card bg-surface shadow-card">
              {items.map((s) => {
                const on = current?.id === s.id, n = attention(s);
                return (
                  <li key={s.id} className="border-b border-separator last:border-0">
                    <button onClick={() => open(s.id)} aria-current={on ? 'page' : undefined}
                      className={`flex min-h-[56px] w-full items-center gap-3 px-4 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${on ? 'bg-accent/10' : 'hover:bg-surface2'}`}>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate ${on ? 'font-semibold text-accent' : 'font-medium'}`}>{s.label}</span>
                        <span className="block truncate text-footnote text-label2">{s.description}</span>
                      </span>
                      {n > 0 && <Badge tone="warning">{n} to set up</Badge>}
                      <span aria-hidden className="text-label2 lg:hidden">›</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );

  return (
    <>
      <LargeTitle subtitle="Everything that connects Meridian to other systems: the systems it talks to, the channels and partners that call it, and the events it shares. Only the super user sees this. Keys are never shown after they are saved.">Integration</LargeTitle>
      {(ov.error || hub.error) && <Alert>{ov.error ?? hub.error}</Alert>}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(260px,330px)_minmax(0,1fr)] lg:items-start">
        <div className={`${current ? 'hidden lg:block' : 'block'} lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto`}>{menu}</div>
        <div className={`${current ? 'block' : 'hidden lg:block'} min-w-0`}>
          {current ? (
            <div key={current.id} className="push-fwd">
              <button onClick={() => open(null)} className="mb-3 inline-flex min-h-tap items-center gap-1 text-subhead text-accent lg:hidden"><span aria-hidden>‹</span> Integration</button>
              <header className="mb-4">
                <p className="text-footnote font-medium uppercase tracking-wide text-label2">{current.group}</p>
                <h2 className="text-title1 font-bold tracking-tight">{current.label}</h2>
                <p className="mt-1 text-subhead text-label2">{current.description}</p>
              </header>
              {(ov.loading && !ov.data) || (hub.loading && !hub.data) ? <Spinner /> : ov.data && hub.data && <SectionBody s={current} ov={ov.data} hub={hub.data} reload={async () => { await Promise.all([ov.reload(), hub.reload()]); }} target={target} open={open} />}
            </div>
          ) : (
            <div className="hidden lg:block"><OverviewPanel ov={ov.data} open={open} /></div>
          )}
        </div>
      </div>
    </>
  );
}

function SectionBody({ s, ov, hub, reload, target, open }: { s: IntegrationSection; ov: Overview; hub: Hub; reload: () => void | Promise<void>; target: string | null; open: (id: string | null) => void }) {
  switch (s.id) {
    case 'overview': return <OverviewPanel ov={ov} open={open} />;
    case 'api-access': return <Gateway h={hub} reload={reload} />;
    case 'callbacks': return <Webhooks h={hub} reload={reload} only="INBOUND" />;
    case 'webhooks': return <Webhooks h={hub} reload={reload} only="OUTBOUND" />;
    case 'deliveries': return <Deliveries />;
    case 'streams': return (
      <div className="space-y-6">
        <SystemList items={itemsOf(ov, s)} hub={hub} reload={reload} target={target} />
        <Events h={hub} reload={reload} />
      </div>
    );
    default: return <SystemList items={itemsOf(ov, s)} hub={hub} reload={reload} target={target} />;
  }
}

/** The landing view: how healthy the connections are, what needs doing first, and how the area is organised. */
function OverviewPanel({ ov, open }: { ov: Overview | null | undefined; open: (id: string | null) => void }) {
  const failed = useApi<any[]>('/settings/integration-hub/deliveries?status=FAILED&limit=20');
  if (!ov) return <Spinner />;
  const counts = { working: 0, action: 0, hand: 0 };
  for (const i of ov.items) counts[STATUS[i.state.status].bucket]++;
  const todo = ov.items.filter(needsAction);
  const sectionOf = (i: Item) => SECTIONS.find((s) => s.groups?.includes(i.group));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-3">
        <Count n={counts.working} label="Working" tone="text-success" />
        <Count n={counts.action} label="Need setup" tone="text-warning" />
        <Count n={counts.hand} label="By hand or stand-in" tone="text-label2" />
      </div>
      {(failed.data?.length ?? 0) > 0 && (
        <Alert tone="danger"><button type="button" className="text-left underline" onClick={() => open('deliveries')}>{failed.data!.length} event deliveries failed. Review them in the delivery queue.</button></Alert>
      )}
      <section aria-label="To do first">
        <h2 className="mb-2 text-title3 font-semibold">{todo.length ? 'To set up' : 'Nothing needs setup'}</h2>
        {todo.length === 0 ? <Card><p className="text-subhead text-label2">Every connection that Meridian can run itself is working or set up. Systems marked “by hand” or “stand-in” need a connector to be built before they run on their own.</p></Card> : (
          <ul className="overflow-hidden rounded-card bg-surface shadow-card">
            {todo.map((i) => (
              <li key={i.id} className="border-b border-separator last:border-0">
                <button onClick={() => { const s = sectionOf(i); if (s) open(s.id); }} className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium">{i.name}</span><span className="block truncate text-footnote text-label2">{i.state.detail}</span></span>
                  <Badge tone="warning">{STATUS[i.state.status].label}</Badge><span aria-hidden className="text-label2">›</span>
                </button>
              </li>))}
          </ul>)}
      </section>
      <section aria-label="How this is organised">
        <h2 className="mb-2 text-title3 font-semibold">How this is organised</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ['Systems Meridian connects to', 'Meridian calls them: network, payments, identity and credit, field service, messaging. Each system shows its status and its connection details together.', 'network'],
            ['Channels and partners that connect to Meridian', 'They call Meridian: the store-front, apps and partners using API credentials, and callbacks from payment providers and couriers.', 'api-access'],
            ['Events Meridian shares', 'Meridian tells others what happened: webhooks, event streams, TM Forum subscriptions, and the queue they go through.', 'webhooks'],
            ['Platform', 'What Meridian runs on: database, workflow engine, scheduler, and the keys that protect data.', 'platform'],
          ].map(([t, d, id]) => (
            <button key={t} onClick={() => open(id!)} className="rounded-card bg-surface p-4 text-left shadow-card transition hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <span className="block font-semibold">{t}</span><span className="mt-1 block text-subhead text-label2">{d}</span>
            </button>))}
        </div>
      </section>
    </div>
  );
}
