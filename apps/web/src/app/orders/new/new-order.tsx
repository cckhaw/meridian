'use client';
import { Alert, Badge, Button, Card, Field, Input, LargeTitle, SectionTitle, Select, Spinner } from '@meridian/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { label, money } from '@/lib/format';

const ALL_CHANNELS = ['SELF_SERVE', 'RETAIL_ASSISTED', 'QUICK_SALE', 'TELESALES', 'DEALER', 'CALL_CENTER'];
const SERVICE_KINDS = ['SIM_ONLY', 'SIM_DEVICE', 'WEARABLE'];

interface Line { offer: any; quantity: number; msisdn: string }

export function NewOrder() {
  const { me, can } = useAuth();
  const sp = useSearchParams();
  const router = useRouter();
  const channels = ALL_CHANNELS.filter((c) => can(`order:create:${c}`));
  const wanted = sp.get('channel');
  const [channel, setChannel] = useState(wanted && channels.includes(wanted) ? wanted : channels[0] ?? '');
  const portal = !!me?.customerId && !can('customer:search');
  const [customerId, setCustomerId] = useState(portal ? me!.customerId! : sp.get('customerId') ?? '');
  const [custQ, setCustQ] = useState('');
  const [accountId, setAccountId] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [pay, setPay] = useState({ method: 'CASH', months: '12', reference: '', received: true });
  const [store, setStore] = useState(me?.storeId ?? '');
  const [dealer, setDealer] = useState(me?.dealerId ?? '');
  const [address, setAddress] = useState('');
  const [offerQ, setOfferQ] = useState('');
  const idemKey = useRef(crypto.randomUUID()); // one key per form: a double-click or retry cannot create a second order
  const quick = channel === 'QUICK_SALE';
  const retail = channel === 'RETAIL_ASSISTED' || quick;

  const meta = useApi('/meta');
  const manual = meta.data?.paymentMode === 'manual';
  const cashier = can('order:payment') && !portal;
  const offers = useApi(`/catalog?level=OFFER&status=ACTIVE&market=${me?.marketCode ?? 'SG'}&q=${encodeURIComponent(offerQ)}`);
  const found = useApi(!quick && !portal && custQ.length >= 2 ? `/customers?q=${encodeURIComponent(custQ)}&limit=6` : null);
  const cust = useApi(!quick && customerId ? `/customers/${customerId}` : null);
  const stores = useApi(retail && !me?.storeId && can('inventory:read') ? '/inventory' : null);
  const { run, busy, error } = useAction();

  useEffect(() => { // deep link from a recommendation
    const pre = sp.get('offerId');
    if (pre && offers.data && lines.length === 0) { const o = offers.data.items.find((x: any) => x.id === pre); if (o) setLines([{ offer: o, quantity: 1, msisdn: '' }]); }
  }, [offers.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = (offers.data?.items ?? []).filter((o: any) => !quick || o.kind === 'PHYSICAL_GOOD');
  const taxBps = meta.data?.markets?.[cust.data?.customer.marketCode ?? me?.marketCode ?? 'SG']?.taxBps ?? 0;
  const totals = useMemo(() => {
    let now = 0, monthly = 0;
    for (const l of lines) for (const p of l.offer.prices) {
      const gross = p.taxInclusive ? p.amount.amountMinor : Math.round(p.amount.amountMinor * (1 + taxBps / 10_000));
      if (p.type === 'ONE_TIME') now += gross * l.quantity; else if (p.type === 'RECURRING') monthly += gross * l.quantity;
    }
    return { now, monthly };
  }, [lines, taxBps]);
  const hasService = lines.some((l) => l.offer.kind !== 'PHYSICAL_GOOD');
  if (channels.length === 0) return <Alert tone="info">Your role cannot create orders.</Alert>;
  const storeOptions = [...new Set<string>((stores.data?.items ?? []).map((s: any) => s.locationId).filter((l: string) => l.startsWith('STORE-')))];

  const add = (o: any) => setLines((ls) => ls.find((l) => l.offer.id === o.id) ? ls.map((l) => (l.offer.id === o.id ? { ...l, quantity: l.quantity + 1 } : l)) : [...ls, { offer: o, quantity: 1, msisdn: '' }]);
  const needsRef = manual && cashier && pay.received && pay.method !== 'INSTALLMENT' && totals.now > 0;
  const refLabel = pay.method === 'CASH' ? 'Receipt number' : pay.method === 'QR' ? 'QR transaction reference' : 'Card terminal approval code';

  const submit = async () => {
    const body = {
      channel, customerId: quick || portal ? undefined : customerId || undefined, accountId: accountId || undefined,
      lines: lines.map((l) => ({ offerId: l.offer.id, quantity: l.quantity, msisdn: l.msisdn || undefined })),
      payment: { method: pay.method, installmentMonths: pay.method === 'INSTALLMENT' ? Number(pay.months) : undefined, reference: pay.reference || undefined, confirmed: cashier && pay.received && pay.method !== 'INSTALLMENT' ? true : undefined },
      storeId: retail ? store || undefined : undefined, dealerId: channel === 'DEALER' ? dealer || undefined : undefined, deliveryAddress: address || undefined,
    };
    const o = await run(() => post('/orders', body, { 'idempotency-key': idemKey.current }));
    if (o) router.push(`/orders/${o.id}`);
  };
  const ready = lines.length > 0 && (quick || customerId) && !(retail && !store) && !(channel === 'DEALER' && !dealer) && !(needsRef && !pay.reference.trim());

  return (
    <>
      <LargeTitle subtitle={quick ? 'Walk-in outright sale: goods only, no customer record needed' : portal ? 'Choose what you would like to buy' : 'Capture an order'}>{portal ? 'Shop' : 'New order'}</LargeTitle>
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card>
            <div className="grid gap-4 sm:grid-cols-2">
              {channels.length > 1 && <Field label="Channel"><Select value={channel} onChange={(e) => { setChannel(e.target.value); setLines([]); idemKey.current = crypto.randomUUID(); }}>{channels.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>}
              {!quick && !portal && (
                <div>
                  <Field label="Customer" hint={cust.data ? undefined : 'Type 2+ characters to search'}>
                    {customerId && cust.data ? (
                      <div className="flex min-h-tap items-center justify-between rounded-control bg-surface2 px-3"><span className="font-medium">{cust.data.customer.displayName}</span><button className="text-subhead text-accent" onClick={() => { setCustomerId(''); setAccountId(''); }}>Change</button></div>
                    ) : <Input value={custQ} onChange={(e) => setCustQ(e.target.value)} placeholder="Name, phone or number" />}
                  </Field>
                  {!customerId && found.data?.items.map((c: any) => <button key={c.id} onClick={() => { setCustomerId(c.id); setCustQ(''); }} className="mt-1 block w-full rounded-control bg-surface2 px-3 py-2 text-left text-subhead">{c.displayName} <span className="text-label2">· {label(c.segment)}</span></button>)}
                </div>
              )}
              {cust.data && !portal && cust.data.accounts.length > 1 && (
                <Field label="Bill to account"><Select value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">First active account</option>{cust.data.accounts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
              )}
              {retail && (me?.storeId ? <Field label="Store"><Input readOnly value={me.storeId} /></Field> : <Field label="Store"><Select value={store} onChange={(e) => setStore(e.target.value)}><option value="">Choose a store…</option>{storeOptions.map((s) => <option key={s}>{s}</option>)}</Select></Field>)}
              {channel === 'DEALER' && (me?.dealerId ? <Field label="Dealer"><Input readOnly value={me.dealerId} /></Field> : <Field label="Dealer ID"><Input value={dealer} onChange={(e) => setDealer(e.target.value)} /></Field>)}
            </div>
          </Card>

          <div>
            <SectionTitle action={<Input type="search" aria-label="Search offers" placeholder="Search offers…" value={offerQ} onChange={(e) => setOfferQ(e.target.value)} className="!min-h-[36px] !w-44" />}>Offers</SectionTitle>
            {offers.loading && !offers.data && <Spinner />}
            {offers.data && visible.length === 0 && <Alert tone="info">No sellable offers{quick ? ' for quick sale' : ''}. {can('catalog:write') ? 'Create and activate offers in the catalog.' : 'Ask a product configurator to activate offers.'}</Alert>}
            <div className="grid gap-3 sm:grid-cols-2">
              {visible.map((o: any) => {
                const rec = o.prices.find((p: any) => p.type === 'RECURRING'), once = o.prices.find((p: any) => p.type === 'ONE_TIME');
                return (
                  <button key={o.id} onClick={() => add(o)} className="rounded-card bg-surface p-4 text-left shadow-card transition hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    <div className="flex items-start justify-between gap-2"><span className="font-medium">{o.name}</span><Badge>{label(o.kind)}</Badge></div>
                    <p className="mt-1 text-subhead text-label2">{[rec && `${money(rec.amount.amountMinor, rec.amount.currency)}/mo`, once && (once.amount.amountMinor ? `${money(once.amount.amountMinor, once.amount.currency)} upfront` : 'no upfront')].filter(Boolean).join(' · ')}</p>
                    {o.contract?.termMonths > 0 && <p className="text-footnote text-label2">{o.contract.termMonths}-month contract</p>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <Card>
            <h2 className="mb-3 text-title3 font-semibold">Order</h2>
            {lines.length === 0 ? <p className="text-subhead text-label2">Add offers from the list.</p> : (
              <ul className="space-y-3">
                {lines.map((l) => (
                  <li key={l.offer.id} className="rounded-control bg-surface2 p-3">
                    <div className="flex items-start justify-between gap-2"><span className="font-medium">{l.offer.name}</span><button aria-label={`Remove ${l.offer.name}`} className="min-h-[28px] min-w-[28px] text-danger" onClick={() => setLines(lines.filter((x) => x !== l))}>×</button></div>
                    <div className="mt-2 flex items-center gap-2">
                      <Input type="number" min={1} max={1000000} aria-label="Quantity" value={l.quantity} onChange={(e) => setLines(lines.map((x) => (x === l ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))} className="!w-24" />
                      {SERVICE_KINDS.includes(l.offer.kind) && l.quantity === 1 && !portal && <Input aria-label="Port-in number" placeholder="Port-in number (optional)" value={l.msisdn} onChange={(e) => setLines(lines.map((x) => (x === l ? { ...x, msisdn: e.target.value } : x)))} />}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <dl className="mt-4 space-y-1 border-t border-separator pt-3 text-subhead">
              <div className="flex justify-between"><dt className="text-label2">Due now</dt><dd className="font-semibold tabular-nums">{money(pay.method === 'INSTALLMENT' ? 0 : totals.now)}</dd></div>
              {pay.method === 'INSTALLMENT' && totals.now > 0 && <div className="flex justify-between"><dt className="text-label2">Instalments</dt><dd className="tabular-nums">{pay.months} × ≈{money(Math.round(totals.now / Number(pay.months)))}</dd></div>}
              <div className="flex justify-between"><dt className="text-label2">Monthly</dt><dd className="tabular-nums">{money(totals.monthly)}</dd></div>
            </dl>
            <p className="mt-1 text-caption text-label2">Estimate{taxBps ? ` at ${taxBps / 100}% tax` : ''}; the server prices the final order.</p>
          </Card>

          <Card className="space-y-3">
            <Field label="Payment method"><Select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
              {['CASH', 'CREDIT_CARD', 'QR', ...(quick || portal ? [] : ['INSTALLMENT'])].map((m) => <option key={m} value={m}>{label(m)}</option>)}</Select></Field>
            {pay.method === 'INSTALLMENT' && <Field label="Instalment months" hint={hasService ? undefined : 'Instalments need a service line'}><Select value={pay.months} onChange={(e) => setPay({ ...pay, months: e.target.value })}>{[3, 6, 12, 24, 36].map((m) => <option key={m}>{m}</option>)}</Select></Field>}
            {cashier && pay.method !== 'INSTALLMENT' && totals.now > 0 && (
              <>
                <label className="flex min-h-tap items-center gap-3 text-body"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={pay.received} onChange={(e) => setPay({ ...pay, received: e.target.checked })} />Payment received now</label>
                {pay.received && <Field label={refLabel} hint={manual ? 'Required: this is the audit evidence for the payment.' : undefined}><Input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>}
                {!pay.received && <p className="text-footnote text-label2">The order will wait for payment confirmation.</p>}
              </>
            )}
            {portal && totals.now > 0 && <p className="text-footnote text-label2">After you place the order, you will be sent to pay. It is released as soon as your payment is confirmed.</p>}
            {!retail && <Field label="Delivery / installation address"><Input value={address} onChange={(e) => setAddress(e.target.value)} /></Field>}
            {error && <Alert>{error}</Alert>}
            <Button className="w-full" disabled={!ready || busy} onClick={submit}>{busy ? 'Placing order…' : 'Place order'}</Button>
          </Card>
        </aside>
      </div>
    </>
  );
}
