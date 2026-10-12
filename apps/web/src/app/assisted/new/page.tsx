'use client';
import { Alert, Badge, Button, Card, Field, Input, LargeTitle, LoadMore, SearchField, SectionTitle, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { api, post, useAction, useDebounced, usePaged } from '@/lib/api';
import { label, money } from '@/lib/format';

interface Offer { id: string; name: string; kind: string; group: string; monthlyMinor: number; upfrontMinor: number; contractMonths: number; requiresText: string[] }

export default function NewAssisted() {
  const router = useRouter();
  const [offerQ, setOfferQ] = useState('');
  const offerTerm = useDebounced(offerQ.trim());
  const cat = usePaged<Offer>(`/assisted/catalog?limit=24&q=${encodeURIComponent(offerTerm)}`);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => { setNames((n) => ({ ...n, ...Object.fromEntries(cat.items.map((o) => [o.id, o.name])) })); }, [cat.items]);
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [customer, setCustomer] = useState<{ id: string; displayName: string; kycStatus?: string } | null>(null);
  const [quote, setQuote] = useState<any>(null);
  const act = useAction();

  useEffect(() => { // look up an existing customer by name / phone / email
    if (q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => { api(`/customers?limit=5&q=${encodeURIComponent(q)}`).then((r) => setFound(r.items)).catch(() => setFound([])); }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const lines = useMemo(() => Object.entries(basket).map(([offerId, quantity]) => ({ offerId, quantity })), [basket]);
  useEffect(() => {
    if (!lines.length) { setQuote(null); return; }
    let live = true;
    api('/assisted/quote', { method: 'POST', json: { lines, customerId: customer?.id } }).then((r) => live && setQuote(r)).catch((e) => live && setQuote({ violations: [e.message], lines: [], upfrontMinor: 0, monthlyMinor: 0 }));
    return () => { live = false; };
  }, [lines, customer]);

  const offers: Offer[] = cat.items;
  const groups = useMemo(() => { const m = new Map<string, Offer[]>(); for (const o of offers) m.set(o.group, [...(m.get(o.group) ?? []), o]); return [...m]; }, [offers]);
  const start = async () => {
    const r = await act.run(() => post('/assisted/applications', { lines, customerId: customer?.id }));
    if (r) router.push(`/assisted/${r.id}`);
  };

  return (
    <>
      <LargeTitle subtitle="Choose who is buying and what they want. Prices are worked out by the system.">New assisted sale</LargeTitle>
      <p className="mb-4"><Link href="/assisted" className="text-subhead text-accent">← Assisted sales</Link></p>
      <Card className="mb-5">
        <SectionTitle>Customer</SectionTitle>
        {customer ? (
          <p className="flex flex-wrap items-center gap-3">Existing customer: <strong>{customer.displayName}</strong>{customer.kycStatus === 'VERIFIED' ? <Badge tone="success">KYC verified</Badge> : <Badge tone="warning">KYC needed</Badge>}<Button variant="plain" onClick={() => setCustomer(null)}>Change</Button></p>
        ) : (
          <>
            <p className="mb-2 text-subhead text-label2">A new customer is the default. To sell to someone already registered, find them here.</p>
            <Field label="Find an existing customer (optional)"><Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone, email…" /></Field>
            {found.length > 0 && <ul className="mt-2 divide-y divide-separator rounded-control border border-separator">{found.map((c) => <li key={c.id}><button className="flex min-h-tap w-full items-center justify-between px-3 text-left hover:bg-surface2" onClick={() => { setCustomer({ id: c.id, displayName: c.displayName, kycStatus: c.kycStatus }); setQ(''); setFound([]); }}><span>{c.displayName}</span><span className="text-footnote text-label2">{c.email ?? c.phone ?? ''}</span></button></li>)}</ul>}
          </>
        )}
      </Card>

      <SectionTitle action={<SearchField label="Search offers" placeholder="Search offers" value={offerQ} onChange={setOfferQ} className="!w-56" />}>What are they buying?</SectionTitle>
      {Object.keys(basket).length > 0 && <p className="mb-3 text-subhead text-label2">Selected: {Object.keys(basket).map((id) => names[id] ?? id).join(' + ')}</p>}
      {cat.loading && cat.items.length === 0 && <Spinner />}
      {!cat.loading && cat.items.length === 0 && !cat.error && <p className="rounded-card bg-surface px-4 py-8 text-center text-subhead text-label2 shadow-card">{offerTerm ? 'No offers match.' : 'No offers are available for this channel.'}</p>}
      {cat.error && <Alert>{cat.error}</Alert>}
      <div className="space-y-4">
        {groups.map(([g, list]) => (
          <fieldset key={g}><legend className="mb-1 text-subhead font-semibold">{g}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {list.map((o) => (
                <label key={o.id} className={`flex min-h-tap cursor-pointer items-start gap-3 rounded-control border p-3 ${basket[o.id] ? 'border-accent bg-accent/5' : 'border-separator bg-surface'}`}>
                  <input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={!!basket[o.id]} onChange={() => setBasket((b) => { const n = { ...b }; if (n[o.id]) delete n[o.id]; else n[o.id] = 1; return n; })} />
                  <span className="flex-1"><span className="block font-medium">{o.name}</span>
                    <span className="text-footnote text-label2">{o.monthlyMinor ? `${money(o.monthlyMinor)}/mo` : ''}{o.monthlyMinor && o.upfrontMinor ? ' + ' : ''}{o.upfrontMinor ? `${money(o.upfrontMinor)} upfront` : ''}{o.contractMonths ? ` · ${o.contractMonths} mo` : ''}</span>
                    {o.requiresText.length > 0 && <span className="block text-footnote text-accent">Needs {o.requiresText.join(' + ')}</span>}
                  </span>
                  <Badge>{label(o.kind)}</Badge>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      {cat.items.length > 0 && <LoadMore shown={cat.items.length} hasMore={cat.hasMore} loading={cat.loadingMore} onMore={cat.loadMore} noun="offers" />}

      {quote && (
        <Card className="mt-5">
          <p className="text-subhead">Due today <strong className="float-right tabular-nums">{money(quote.upfrontMinor)}</strong></p>
          {quote.monthlyMinor > 0 && <p className="text-footnote text-label2">then {money(quote.monthlyMinor)} per month</p>}
          {quote.violations?.map((v: string) => <p key={v} role="alert" className="mt-2 text-subhead text-danger">{v}</p>)}
        </Card>
      )}
      {act.error && <div className="mt-4"><Alert>{act.error}</Alert></div>}
      <div className="mt-5"><Button onClick={start} disabled={act.busy || !lines.length || !quote || quote.violations?.length > 0}>{act.busy ? 'Starting…' : 'Continue'}</Button></div>
    </>
  );
}
