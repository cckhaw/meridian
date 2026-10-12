'use client';
import { Alert, Badge, Button, Segmented, Spinner } from '@meridian/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfig } from '@/components/config';
import { api } from '@/lib/api';

interface Offer {
  id: string; name: string; kind: string; description?: string; group: string; monthlyMinor: number; upfrontMinor: number; contractMonths: number;
  requiresShipping: boolean; requiresText: string[]; excludes: string[];
}
interface Quote { lines: Array<{ offerId: string; name: string; quantity: number; upfrontMinor: number; monthlyMinor: number }>; upfrontMinor: number; monthlyMinor: number; violations: string[]; requiresShipping: boolean; taxName: string }

const TABS = [
  { value: 'all', label: 'All' }, { value: 'sim', label: 'SIM only' }, { value: 'device', label: 'SIM + device' }, { value: 'more', label: 'Add-ons & more' },
] as const;
type Tab = (typeof TABS)[number]['value'];
const tabOf = (o: Offer): Tab => (o.kind === 'SIM_ONLY' ? 'sim' : o.kind === 'SIM_DEVICE' ? 'device' : 'more');
const KIND_LABEL: Record<string, string> = { SIM_ONLY: 'SIM only', SIM_DEVICE: 'SIM + device', WEARABLE: 'Wearable', FIBER: 'Home fibre', VAS: 'Add-on', NON_TELCO_SUBSCRIPTION: 'Subscription', PHYSICAL_GOOD: 'Device', IOT_CONNECTIVITY: 'IoT' };

export default function Home() {
  const { money, brand } = useConfig();
  const router = useRouter();
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [starting, setStarting] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    api('/catalog').then((c) => setOffers(c.offers)).catch((e) => setError(e.message));
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
  const shown = (offers ?? []).filter((o) => tab === 'all' || tabOf(o) === tab);
  const names = new Map((offers ?? []).map((o) => [o.id, o.name]));

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

      <div className="mb-5"><Segmented label="Show" value={tab} options={[...TABS]} onChange={setTab} /></div>
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!offers && !error && <Spinner />}
      {offers && shown.length === 0 && <p className="rounded-card bg-surface px-4 py-8 text-center text-subhead text-label2 shadow-card">Nothing to show here yet.</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:pr-0">
        {shown.map((o) => {
          const chosen = !!basket[o.id];
          return (
            <article key={o.id} aria-label={o.name} className={`flex flex-col rounded-card border bg-surface p-5 shadow-card ${chosen ? 'border-accent ring-2 ring-accent' : 'border-transparent'}`}>
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-title3 font-semibold">{o.name}</h2>
                <Badge>{KIND_LABEL[o.kind] ?? o.kind}</Badge>
              </div>
              {o.description && <p className="mt-1 text-subhead text-label2">{o.description}</p>}
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

      {lines.length > 0 && (
        <aside aria-label="Your basket" className="fixed inset-x-0 bottom-0 z-40 border-t border-separator bg-bg/95 px-4 pb-[calc(12px+var(--sab))] pt-3 backdrop-blur-chrome">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="truncate text-subhead font-medium">{lines.map((l) => names.get(l.offerId) ?? l.offerId).join(' + ')}</p>
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
