'use client';
import { Alert, Badge, Button, LoadMore, SearchField, Segmented, Spinner } from '@meridian/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfig } from '@/components/config';
import { api } from '@/lib/api';

interface Offer {
  id: string; name: string; kind: string; kindName?: string; description?: string; group: string; monthlyMinor: number; upfrontMinor: number; contractMonths: number;
  requiresShipping: boolean; requiresText: string[]; excludes: string[];
  includes: Array<{ name: string; itemType: string; quantity?: number; unit?: string; unlimited?: boolean; description?: string }>;
}
interface Quote { lines: Array<{ offerId: string; name: string; quantity: number; upfrontMinor: number; monthlyMinor: number }>; upfrontMinor: number; monthlyMinor: number; violations: string[]; requiresShipping: boolean; taxName: string }

const TABS = [
  { value: 'all', label: 'All' }, { value: 'sim', label: 'SIM only' }, { value: 'device', label: 'SIM + device' }, { value: 'more', label: 'Add-ons & more' },
] as const;
type Tab = (typeof TABS)[number]['value'];
/** "100 GB" / "Unlimited" for allowances; "2 ×" for several units; nothing for a single device or SIM. */
const amountOf = (i: Offer['includes'][number]) =>
  i.unlimited ? 'Unlimited' : !i.quantity ? '' : ['unit', 'SIM'].includes(i.unit ?? '') ? (i.quantity > 1 ? `${i.quantity} ×` : '') : `${i.quantity.toLocaleString()}${i.unit ? ` ${i.unit}` : ''}`;
/** Which kinds each tab asks the server for, so filtering happens in the database and not in the browser. */
const TAB_QUERY: Record<Tab, string> = { all: '', sim: '&kind=SIM_ONLY', device: '&kind=SIM_DEVICE', more: '&notKind=SIM_ONLY,SIM_DEVICE' };
const KIND_LABEL: Record<string, string> = { SIM_ONLY: 'SIM only', SIM_DEVICE: 'SIM + device', WEARABLE: 'Wearable', FIBER: 'Home fibre', VAS: 'Add-on', NON_TELCO_SUBSCRIPTION: 'Subscription', PHYSICAL_GOOD: 'Device', IOT_CONNECTIVITY: 'IoT' };

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
  const [quote, setQuote] = useState<Quote | null>(null);
  const [starting, setStarting] = useState(false);
  const seq = useRef(0);

  const remember = (list: Offer[]) => setKnown((k) => ({ ...k, ...Object.fromEntries(list.map((o) => [o.id, o.name])) }));
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
    try { const s = JSON.parse(sessionStorage.getItem('basket') ?? '{}'); if (s && typeof s === 'object') setBasket(s); } catch { /* private mode */ }
  }, []);
  useEffect(() => { try { sessionStorage.setItem('basket', JSON.stringify(basket)); } catch { /* ignore */ } }, [basket]);

  // Prices always come from the server; this only asks it to total the basket.
  const lines = useMemo(() => Object.entries(basket).map(([offerId, quantity]) => ({ offerId, quantity })), [basket]);
  const requote = useCallback(async () => {
    const n = ++seq.current;
    if (!lines.length) { setQuote(null); return; }
    try { const q = await api<Quote>('/quote', { method: 'POST', json: { lines } }); if (n === seq.current) { setQuote(q); setError(null); } }
    catch (e) { if (n === seq.current) { setQuote(null); setError((e as Error).message); } }
  }, [lines]);
  useEffect(() => { void requote(); }, [requote]);

  const toggle = (id: string) => setBasket((b) => { const n = { ...b }; if (n[id]) delete n[id]; else n[id] = 1; return n; });
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
              {o.requiresText.length > 0 && <p className="mt-2 rounded-control bg-accent/10 px-3 py-2 text-footnote text-accent">Needs {o.requiresText.join(' + ')} in your order</p>}
              {o.requiresShipping && <p className="mt-1 text-footnote text-label2">Delivered to your door</p>}
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
