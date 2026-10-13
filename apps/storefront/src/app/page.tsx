'use client';
import { Alert, Badge, Button, LoadMore, SearchField, Segmented, Spinner } from '@meridian/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfig } from '@/components/config';
import { api } from '@/lib/api';

interface Offer {
  id: string; name: string; kind: string; kindName?: string; description?: string; group: string; monthlyMinor: number; upfrontMinor: number; contractMonths: number;
  requiresShipping: boolean; requiresText: string[]; excludes: string[];
  deals: Array<{ termMonths: number; subsidyMinor: number; priceMinor: number }>; hostsDevice: boolean;
  includes: Array<{ name: string; itemType: string; quantity?: number; unit?: string; unlimited?: boolean; description?: string }>;
}
interface Quote { lines: Array<{ offerId: string; name: string; quantity: number; upfrontMinor: number; monthlyMinor: number; deal?: { planName: string; termMonths: number } }>; upfrontMinor: number; monthlyMinor: number; violations: string[]; requiresShipping: boolean; taxName: string }

const TABS = [
  { value: 'all', label: 'All' }, { value: 'sim', label: 'SIM only' }, { value: 'device', label: 'SIM + device' }, { value: 'goods', label: 'Devices' }, { value: 'more', label: 'Add-ons & more' },
] as const;
type Tab = (typeof TABS)[number]['value'];
/** "100 GB" / "Unlimited" for allowances; "2 ×" for several units; nothing for a single device or SIM. */
const amountOf = (i: Offer['includes'][number]) =>
  i.unlimited ? 'Unlimited' : !i.quantity ? '' : ['unit', 'SIM'].includes(i.unit ?? '') ? (i.quantity > 1 ? `${i.quantity} ×` : '') : `${i.quantity.toLocaleString()}${i.unit ? ` ${i.unit}` : ''}`;
/** Which kinds each tab asks the server for, so filtering happens in the database and not in the browser. */
const TAB_QUERY: Record<Tab, string> = { all: '', sim: '&kind=SIM_ONLY', device: '&kind=SIM_DEVICE', goods: '&kind=PHYSICAL_GOOD', more: '&notKind=SIM_ONLY,SIM_DEVICE,PHYSICAL_GOOD' };
const KIND_LABEL: Record<string, string> = { SIM_ONLY: 'SIM only', SIM_DEVICE: 'SIM + device', WEARABLE: 'Wearable', FIBER: 'Home fibre', VAS: 'Add-on', NON_TELCO_SUBSCRIPTION: 'Subscription', PHYSICAL_GOOD: 'Device', IOT_CONNECTIVITY: 'IoT' };

/** How a device in the basket is bought: outright, or on a contract with one of the plans in the basket. */
function ContractChoice({ offer, value, plans, names, money, onChange }: { offer: Offer; value?: { planId: string; term: number }; plans: string[]; names: Map<string, string>; money: (n: number) => string; onChange: (v: { planId: string; term: number } | null) => void }) {
  return (
    <div className="mt-3 space-y-2">
      <Segmented label={`How to buy ${offer.name}`} value={value ? 'contract' : 'outright'} options={[{ value: 'outright', label: 'Outright' }, { value: 'contract', label: 'On a contract' }]}
        onChange={(v) => (v === 'outright' ? onChange(null) : plans[0] && onChange({ planId: plans[0], term: offer.deals[0]!.termMonths }))} />
      {!value && plans.length === 0 && <p className="text-footnote text-label2">Choose a SIM plan too to buy this on a contract.</p>}
      {value && (
        <div className="grid gap-2 text-subhead">
          <label className="grid gap-1"><span className="text-footnote text-label2">With plan</span>
            <select className="min-h-tap rounded-control border border-separator bg-surface px-3" value={value.planId} onChange={(e) => onChange({ ...value, planId: e.target.value })}>
              {plans.map((id) => <option key={id} value={id}>{names.get(id) ?? id}</option>)}</select></label>
          <label className="grid gap-1"><span className="text-footnote text-label2">Contract</span>
            <select className="min-h-tap rounded-control border border-separator bg-surface px-3" value={value.term} onChange={(e) => onChange({ ...value, term: Number(e.target.value) })}>
              {offer.deals.map((d) => <option key={d.termMonths} value={d.termMonths}>{d.termMonths} months · {money(d.priceMinor)} today</option>)}</select></label>
          <p className="text-footnote text-label2">If you leave before the contract ends, you repay the part of the saving that is left.</p>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const { money, brand } = useConfig();
  const router = useRouter();
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [known, setKnown] = useState<Record<string, string>>({}); // names of everything seen so far, so the basket can name items from other pages
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => { const t = setTimeout(() => setTerm(search.trim()), 250); return () => clearTimeout(t); }, [search]);
  const [basket, setBasket] = useState<Record<string, number>>({});
  /** Devices the shopper wants on a contract: which plan in the basket, and for how long. */
  const [deals, setDeals] = useState<Record<string, { planId: string; term: number }>>({});
  const [hosts, setHosts] = useState<Record<string, boolean>>({}); // which products seen so far can carry a device on a contract
  const [quote, setQuote] = useState<Quote | null>(null);
  const [starting, setStarting] = useState(false);
  const seq = useRef(0);

  const remember = (list: Offer[]) => { setKnown((k) => ({ ...k, ...Object.fromEntries(list.map((o) => [o.id, o.name])) })); setHosts((h) => ({ ...h, ...Object.fromEntries(list.map((o) => [o.id, o.hostsDevice])) })); };
  // The shop shows a dozen plans at a time and searches the rest on the server, so a large catalog stays quick.
  useEffect(() => {
    let live = true;
    setOffers(null);
    api(`/catalog?limit=12${TAB_QUERY[tab]}&q=${encodeURIComponent(term)}`).then((c) => { if (!live) return; setOffers(c.offers); setCursor(c.nextCursor); remember(c.offers); }).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [tab, term]);
  const more = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try { const c = await api(`/catalog?limit=12${TAB_QUERY[tab]}&q=${encodeURIComponent(term)}&cursor=${encodeURIComponent(cursor)}`); setOffers((cur) => [...(cur ?? []), ...c.offers]); setCursor(c.nextCursor); remember(c.offers); }
    catch (e) { setError((e as Error).message); } finally { setLoadingMore(false); }
  };
  useEffect(() => {
    try {
      const s = JSON.parse(sessionStorage.getItem('basket') ?? '{}'); if (s && typeof s === 'object') setBasket(s);
      const d = JSON.parse(sessionStorage.getItem('deals') ?? '{}'); if (d && typeof d === 'object') setDeals(d);
      const h = JSON.parse(sessionStorage.getItem('hosts') ?? '{}'); if (h && typeof h === 'object') setHosts(h);
    } catch { /* private mode */ }
  }, []);
  useEffect(() => { try { sessionStorage.setItem('basket', JSON.stringify(basket)); sessionStorage.setItem('deals', JSON.stringify(deals)); sessionStorage.setItem('hosts', JSON.stringify(hosts)); } catch { /* ignore */ } }, [basket, deals, hosts]);

  // Prices always come from the server; this only asks it to total the basket.
  const lines = useMemo(() => Object.entries(basket).map(([offerId, quantity]) => {
    const d = deals[offerId];
    return d && basket[d.planId] ? { offerId, quantity, attachTo: d.planId, dealTermMonths: d.term } : { offerId, quantity }; // a contract only counts while its plan is in the basket
  }), [basket, deals]);
  const requote = useCallback(async () => {
    const n = ++seq.current;
    if (!lines.length) { setQuote(null); return; }
    try { const q = await api<Quote>('/quote', { method: 'POST', json: { lines } }); if (n === seq.current) { setQuote(q); setError(null); } }
    catch (e) { if (n === seq.current) { setQuote(null); setError((e as Error).message); } }
  }, [lines]);
  useEffect(() => { void requote(); }, [requote]);

  const toggle = (id: string) => { setBasket((b) => { const n = { ...b }; if (n[id]) delete n[id]; else n[id] = 1; return n; }); setDeals((d) => { const n = { ...d }; delete n[id]; return n; }); };
  const plansInBasket = Object.keys(basket).filter((id) => hosts[id] && !Object.entries(deals).some(([dev, v]) => v.planId === id && basket[dev]));
  const shown = offers ?? [];
  const names = new Map(Object.entries(known));

  const start = async () => {
    setStarting(true); setError(null);
    try { await api('/start', { method: 'POST', json: { lines } }); router.push('/apply'); }
    catch (e) { setError((e as Error).message); setStarting(false); }
  };

  return (
    <>
      <section className="mb-8">
        <h1 className="text-title1 font-bold tracking-tight sm:text-large-title">Get connected with {brand.name}</h1>
        <p className="mt-1 max-w-2xl text-body text-label2">Pick a SIM-only plan or a plan with a new device, add what you need, then verify your identity and pay. It takes a few minutes.</p>
      </section>

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Segmented label="Show" value={tab} options={[...TABS]} onChange={setTab} />
        <SearchField label="Search plans" placeholder="Search plans and devices" value={search} onChange={setSearch} className="sm:w-72" />
      </div>
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!offers && !error && <Spinner />}
      {offers && shown.length === 0 && <p className="rounded-card bg-surface px-4 py-8 text-center text-subhead text-label2 shadow-card">{term ? 'No plans match your search.' : 'Nothing to show here yet.'}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:pr-0">
        {shown.map((o) => {
          const chosen = !!basket[o.id];
          return (
            <article key={o.id} aria-label={o.name} className={`flex flex-col rounded-card border bg-surface p-5 shadow-card ${chosen ? 'border-accent ring-2 ring-accent' : 'border-transparent'}`}>
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-title3 font-semibold">{o.name}</h2>
                <Badge>{KIND_LABEL[o.kind] ?? o.kindName ?? o.kind}</Badge>
              </div>
              {o.description && <p className="mt-1 text-subhead text-label2">{o.description}</p>}
              {o.includes?.length > 0 && (
                <ul aria-label={`What ${o.name} includes`} className="mt-3 space-y-1 text-subhead">
                  {o.includes.map((i, n) => (
                    <li key={n} className="flex gap-2"><span aria-hidden className="text-success">✓</span>
                      <span>{amountOf(i)} {i.name}</span></li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-title2 font-bold tabular-nums">{o.monthlyMinor ? money(o.monthlyMinor) : money(o.upfrontMinor)}<span className="text-subhead font-normal text-label2">{o.monthlyMinor ? ' /month' : ' once'}</span></p>
              <p className="text-footnote text-label2">
                {o.monthlyMinor && o.upfrontMinor ? `${money(o.upfrontMinor)} upfront · ` : ''}{o.contractMonths ? `${o.contractMonths}-month contract` : o.monthlyMinor ? 'No contract' : ''}
              </p>
              {o.deals?.length > 0 && (
                <div className="mt-3 rounded-control bg-accent/10 px-3 py-2 text-footnote">
                  <p className="font-medium text-accent">Or on a contract with a SIM plan</p>
                  <ul className="mt-0.5 text-label2">{o.deals.map((d) => <li key={d.termMonths}>{d.termMonths} months: <strong className="tabular-nums text-label">{money(d.priceMinor)}</strong> today, save {money(d.subsidyMinor)}</li>)}</ul>
                </div>
              )}
              {o.requiresText.length > 0 && <p className="mt-2 rounded-control bg-accent/10 px-3 py-2 text-footnote text-accent">Needs {o.requiresText.join(' + ')} in your order</p>}
              {o.requiresShipping && <p className="mt-1 text-footnote text-label2">Delivered to your door</p>}
              {chosen && o.deals?.length > 0 && (
                <ContractChoice offer={o} value={deals[o.id]} plans={[...plansInBasket, ...(deals[o.id] ? [deals[o.id]!.planId] : [])].filter((x, i, a) => a.indexOf(x) === i)} names={names} money={money}
                  onChange={(v) => setDeals((d) => { const n = { ...d }; if (v) n[o.id] = v; else delete n[o.id]; return n; })} />
              )}
              <div className="mt-auto pt-4">
                <Button variant={chosen ? 'secondary' : 'primary'} className="w-full" aria-pressed={chosen} onClick={() => toggle(o.id)}>{chosen ? 'Remove from basket' : o.kind === 'SIM_ONLY' || o.kind === 'SIM_DEVICE' ? 'Choose this plan' : 'Add to basket'}</Button>
              </div>
            </article>
          );
        })}
      </div>
      {offers && offers.length > 0 && <LoadMore shown={offers.length} hasMore={!!cursor} loading={loadingMore} onMore={() => void more()} noun="plans" />}

      {lines.length > 0 && (
        <aside aria-label="Your basket" className="fixed inset-x-0 bottom-0 z-40 border-t border-separator bg-bg/95 px-4 pb-[calc(12px+var(--sab))] pt-3 backdrop-blur-chrome">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="truncate text-subhead font-medium">{lines.map((l) => names.get(l.offerId) ?? quote?.lines.find((x) => x.offerId === l.offerId)?.name ?? l.offerId).join(' + ')}</p>
              {quote && (
                <p className="text-footnote text-label2 tabular-nums">
                  {quote.monthlyMinor > 0 && <>{money(quote.monthlyMinor)}/month</>}{quote.monthlyMinor > 0 && quote.upfrontMinor > 0 && ' + '}{quote.upfrontMinor > 0 && <>{money(quote.upfrontMinor)} today</>}
                  {quote.monthlyMinor === 0 && quote.upfrontMinor === 0 && 'Nothing to pay today'} · prices include {quote.taxName}
                </p>
              )}
              {quote?.violations.map((v) => <p key={v} role="alert" className="text-footnote text-danger">{v}</p>)}
            </div>
            <Button onClick={start} disabled={starting || !quote || quote.violations.length > 0}>{starting ? 'Starting…' : 'Sign up & continue'}</Button>
          </div>
        </aside>
      )}
    </>
  );
}
