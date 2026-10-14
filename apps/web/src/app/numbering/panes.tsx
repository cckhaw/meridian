'use client';
import { Alert, Badge, Button, Card, DataList, Empty, LoadMore, SearchField, Select, SectionTitle, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi, useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label } from '@/lib/format';

const TIER_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = { STANDARD: 'neutral', SILVER: 'neutral', GOLD: 'warning', DIAMOND: 'success', AUCTION: 'danger' };
const STATE_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  AVAILABLE: 'success', WAREHOUSE_INVENTORY: 'success', DISTRIBUTED_DEALER: 'success', POOL_UNASSIGNED: 'success',
  RESERVED_CHECKOUT: 'warning', RESERVED: 'warning', BOUND_TO_SIM: 'warning', AUCTION_HOLD: 'warning', QUARANTINE_COOLING: 'warning', QUARANTINED: 'warning',
  DAMAGED_SCRAPPED: 'danger', DECOMMISSIONED: 'danger', BLOCKED_VIP: 'danger', PORTED_OUT: 'neutral',
};
const NUMBER_STATES = ['AVAILABLE', 'RESERVED_CHECKOUT', 'ASSIGNED_ACTIVE', 'QUARANTINE_COOLING', 'BLOCKED_VIP', 'AUCTION_HOLD', 'PORTED_OUT'];
const SIM_STATES = ['WAREHOUSE_INVENTORY', 'DISTRIBUTED_DEALER', 'RESERVED', 'ACTIVE', 'DAMAGED_SCRAPPED', 'DECOMMISSIONED'];
const IMSI_STATES = ['POOL_UNASSIGNED', 'BOUND_TO_SIM', 'ACTIVE', 'QUARANTINED', 'RECYCLED'];
const StateBadge = ({ s }: { s: string }) => <Badge tone={STATE_TONE[s] ?? 'neutral'}>{label(s)}</Badge>;

export function OverviewPane({ go }: { go: (t: 'numbers' | 'sims' | 'imsis' | 'tiers') => void }) {
  const { can } = useAuth();
  const s = useApi<any>('/numbering/summary');
  const recycle = useAction(s.reload);
  if (s.error) return <Alert>{s.error}</Alert>;
  if (!s.data) return <Spinner />;
  const group = (rows: any[], key: string) => { const m = new Map<string, number>(); for (const r of rows) m.set(r[key], (m.get(r[key]) ?? 0) + r.n); return [...m]; };
  const Counts = ({ title, rows, onOpen }: { title: string; rows: Array<[string, number]>; onOpen: () => void }) => (
    <Card>
      <div className="mb-2 flex items-center justify-between"><h3 className="text-title3 font-semibold">{title}</h3><button type="button" className="text-subhead text-accent" onClick={onOpen}>Open</button></div>
      {rows.length === 0 ? <p className="text-subhead text-label2">Nothing loaded yet.</p> : <dl className="space-y-1">{rows.map(([k, n]) => <div key={k} className="flex items-center justify-between gap-2"><dt><StateBadge s={k} /></dt><dd className="tabular-nums">{n.toLocaleString('en')}</dd></div>)}</dl>}
    </Card>
  );
  const tiers = Object.entries(s.data.availableByTier as Record<string, number>);
  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <Counts title="MSISDN · phone numbers" rows={group(s.data.msisdn, 'state')} onOpen={() => go('numbers')} />
        <Counts title="ICCID · SIM cards and eSIMs" rows={group(s.data.iccid, 'state')} onOpen={() => go('sims')} />
        <Counts title="IMSI · subscriber identities" rows={group(s.data.imsi, 'state')} onOpen={() => go('imsis')} />
      </div>
      <SectionTitle>Numbers ready to sell, by tier</SectionTitle>
      <div className="flex flex-wrap gap-2">
        {tiers.length === 0 ? <Empty>No numbers are available.</Empty> : tiers.map(([t, n]) => <button key={t} type="button" onClick={() => go('tiers')} className="rounded-control bg-surface2 px-4 py-2 text-left"><Badge tone={TIER_TONE[t] ?? 'neutral'}>{label(t)}</Badge><span className="ml-2 tabular-nums">{n.toLocaleString('en')}</span></button>)}
      </div>
      {can('numbering:manage') && (
        <div className="mt-6">
          <Button variant="secondary" disabled={recycle.busy} onClick={() => recycle.run(() => post('/numbering/recycle', {}), 'Done')}>{recycle.busy ? 'Working…' : 'Recycle what has finished cooling off now'}</Button>
          <p className="mt-2 text-footnote text-label2">IMSIs and MSISDNs return to their pools by themselves when the cooling-off ends (the daily job, or the recycling workflow). This does it right away.</p>
          {recycle.error && <div className="mt-2"><Alert>{recycle.error}</Alert></div>}{recycle.ok && <div className="mt-2"><Alert tone="success">Recycled: {recycle.ok}</Alert></div>}
        </div>
      )}
    </>
  );
}

/** The three pools share one layout: a search, a few filters, the table, and a history for whichever row is opened. */
export function IdentityPanes({ kind }: { kind: 'numbers' | 'sims' | 'imsis' }) {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [tier, setTier] = useState('');
  const [type, setType] = useState('');
  const [open, setOpen] = useState<{ type: string; id: string } | null>(null);
  const term = useDebounced(q.trim());
  const path = kind === 'numbers' ? `/numbering/numbers?limit=50&state=${state}&tier=${tier}&q=${encodeURIComponent(term)}`
    : kind === 'sims' ? `/numbering/sims?limit=50&state=${state}&kind=${type}&q=${encodeURIComponent(term)}` : `/numbering/imsis?limit=50&state=${state}&q=${encodeURIComponent(term)}`;
  const list = usePaged(path);
  const act = useAction(list.reload);
  const typeOf = kind === 'numbers' ? 'MSISDN' : kind === 'sims' ? 'ICCID' : 'IMSI';
  const idOf = (r: any): string => r.msisdn ?? r.iccid ?? r.imsi;
  const manage = can('numbering:manage');
  const states = kind === 'numbers' ? NUMBER_STATES : kind === 'sims' ? SIM_STATES : IMSI_STATES;
  return (
    <>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <SearchField label="Search" placeholder={kind === 'numbers' ? 'MSISDN starts with…' : kind === 'sims' ? 'ICCID starts with…' : 'IMSI starts with…'} value={q} onChange={setQ} className="md:max-w-md md:flex-1" />
        <Select aria-label="State" value={state} onChange={(e) => setState(e.target.value)} className="md:max-w-[220px]"><option value="">Any state</option>{states.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
        {kind === 'numbers' && <Select aria-label="Tier" value={tier} onChange={(e) => setTier(e.target.value)} className="md:max-w-[180px]"><option value="">Any tier</option>{['DIAMOND', 'GOLD', 'SILVER', 'STANDARD', 'AUCTION'].map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select>}
        {kind === 'sims' && <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className="md:max-w-[160px]"><option value="">Cards and eSIMs</option><option value="PHYSICAL">Cards</option><option value="ESIM">eSIMs</option></Select>}
      </div>
      {list.error && <Alert>{list.error}</Alert>}{act.error && <Alert>{act.error}</Alert>}{list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>Nothing matches.</Empty>}
      {list.items.length > 0 && (
        <>
          <DataList label="Resources" rows={list.items} rowKey={(r: any) => idOf(r)}
            columns={[
              ...(kind === 'numbers' ? [
                { key: 'id', label: 'MSISDN', primary: true, render: (r: any) => <span className="font-mono">{r.msisdn}</span> },
                { key: 'tier', label: 'Tier', render: (r: any) => <><Badge tone={TIER_TONE[r.tier] ?? 'neutral'}>{label(r.tier)}</Badge>{r.patternCode && <span className="ml-2 text-caption text-label2">{r.patternCode}</span>}</> },
                { key: 'state', label: 'State', render: (r: any) => <StateBadge s={r.state} /> },
                { key: 'until', label: 'Until', render: (r: any) => <span className="text-footnote text-label2">{r.reservedUntil ? dt(r.reservedUntil) : r.quarantineUntil ?? ''}</span> },
              ] : []),
              ...(kind === 'sims' ? [
                { key: 'id', label: 'ICCID', primary: true, render: (r: any) => <span className="font-mono">{r.iccid}</span> },
                { key: 'type', label: 'Type', render: (r: any) => (r.kind === 'ESIM' ? 'eSIM' : 'Card') },
                { key: 'state', label: 'State', render: (r: any) => <StateBadge s={r.state} /> },
                { key: 'loc', label: 'Location', render: (r: any) => r.locationId ?? '' },
                { key: 'imsi', label: 'IMSI', render: (r: any) => <span className="font-mono text-footnote">{r.imsi ?? ''}</span> },
              ] : []),
              ...(kind === 'imsis' ? [
                { key: 'id', label: 'IMSI', primary: true, render: (r: any) => <span className="font-mono">{r.imsi}</span> },
                { key: 'state', label: 'State', render: (r: any) => <StateBadge s={r.state} /> },
                { key: 'iccid', label: 'ICCID', render: (r: any) => <span className="font-mono text-footnote">{r.iccid ?? ''}</span> },
                { key: 'until', label: 'Until', render: (r: any) => <span className="text-footnote text-label2">{r.quarantineUntil ?? ''}</span> },
              ] : []),
            ]}
            actions={(r: any) => (<>
                      <Button variant="secondary" onClick={() => setOpen(open?.id === idOf(r) ? null : { type: typeOf, id: idOf(r) })}>History</Button>
                      {manage && kind === 'numbers' && r.state === 'AVAILABLE' && <Button variant="secondary" disabled={act.busy} onClick={() => act.run(() => post('/numbering/auction/hold', { msisdns: [r.msisdn] }))}>Hold for auction</Button>}
                      {manage && kind === 'numbers' && r.state === 'AUCTION_HOLD' && <Button variant="secondary" disabled={act.busy} onClick={() => act.run(() => post('/numbering/auction/release', { msisdns: [r.msisdn] }))}>Back on sale</Button>}
                      {manage && kind === 'sims' && ['WAREHOUSE_INVENTORY', 'DISTRIBUTED_DEALER'].includes(r.state) && <Button variant="secondary" disabled={act.busy} onClick={() => { const reason = prompt('Why is this SIM scrapped?'); if (reason) void act.run(() => post(`/numbering/sims/${r.iccid}/transition`, { to: 'DAMAGED_SCRAPPED', reason })); }}>Scrap</Button>}
                      {manage && kind === 'sims' && r.state === 'DAMAGED_SCRAPPED' && <Button variant="secondary" disabled={act.busy} onClick={() => act.run(() => post(`/numbering/sims/${r.iccid}/transition`, { to: 'DECOMMISSIONED', reason: 'written off' }))}>Decommission</Button>}
                    </>)} />
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun={kind === 'numbers' ? 'numbers' : kind === 'sims' ? 'SIMs' : 'identities'} />
        </>
      )}
      {open && <History type={open.type} id={open.id} onClose={() => setOpen(null)} />}
    </>
  );
}

function History({ type, id, onClose }: { type: string; id: string; onClose: () => void }) {
  const h = useApi<{ items: any[] }>(`/numbering/history?type=${type}&id=${encodeURIComponent(id)}`);
  return (
    <Card className="mt-4">
      <div className="mb-2 flex items-center justify-between"><h3 className="text-title3 font-semibold">History of <span className="font-mono">{id}</span></h3><button type="button" className="text-accent" onClick={onClose}>Close</button></div>
      {!h.data ? <Spinner /> : h.data.items.length === 0 ? <p className="text-subhead text-label2">No changes recorded.</p> : (
        <ul className="space-y-1 text-subhead">{h.data.items.map((e) => <li key={e.id}><span className="text-label2">{dt(e.at)}</span> · {e.fromState ? `${label(e.fromState)} → ` : ''}<strong>{label(e.toState)}</strong> · {e.actor}{e.reason ? ` · ${e.reason}` : ''}</li>)}</ul>
      )}
    </Card>
  );
}
