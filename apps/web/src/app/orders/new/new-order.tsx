'use client';
import { Alert, Badge, Button, Card, Field, Input, LargeTitle, SectionTitle, Select, Spinner } from '@meridian/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { label, money } from '@/lib/format';

const CHANNELS = ['SELF_SERVE', 'RETAIL_ASSISTED', 'QUICK_SALE', 'TELESALES', 'DEALER', 'CALL_CENTER'];
const SERVICE_KINDS = ['SIM_ONLY', 'SIM_DEVICE', 'WEARABLE'];
const TAX_BPS = 900; // preview only; the server prices the order with the market's tax rate

interface Line { offer: any; quantity: number; msisdn: string }

export function NewOrder() {
  const sp = useSearchParams();
  const router = useRouter();
  const [channel, setChannel] = useState(sp.get('channel') ?? 'RETAIL_ASSISTED');
  const [customerId, setCustomerId] = useState(sp.get('customerId') ?? '');
  const [custQ, setCustQ] = useState('');
  const [accountId, setAccountId] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [pay, setPay] = useState({ method: 'CREDIT_CARD', months: '12', reference: '' });
  const [att, setAtt] = useState({ storeId: 'STORE-SG-001', salespersonId: '', dealerId: '' });
  const [address, setAddress] = useState('');
  const [offerQ, setOfferQ] = useState('');
  const quick = channel === 'QUICK_SALE';

  const offers = useApi(`/catalog?level=OFFER&status=ACTIVE&market=SG&q=${encodeURIComponent(offerQ)}`);
  const found = useApi(!quick && custQ.length >= 2 ? `/customers?q=${encodeURIComponent(custQ)}&limit=6` : null);
  const cust = useApi(!quick && customerId ? `/customers/${customerId}` : null);
  const { run, busy, error } = useAction();

  useEffect(() => { // deep link from a recommendation
    const pre = sp.get('offerId');
    if (pre && offers.data && lines.length === 0) { const o = offers.data.items.find((x: any) => x.id === pre); if (o) setLines([{ offer: o, quantity: 1, msisdn: '' }]); }
  }, [offers.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = (offers.data?.items ?? []).filter((o: any) => !quick || o.kind === 'PHYSICAL_GOOD');
  const totals = useMemo(() => {
    let now = 0, monthly = 0;
    for (const l of lines) for (const p of l.offer.prices) {
      const gross = p.taxInclusive ? p.amount.amountMinor : Math.round(p.amount.amountMinor * (1 + TAX_BPS / 10_000));
      if (p.type === 'ONE_TIME') now += gross * l.quantity; else if (p.type === 'RECURRING') monthly += gross * l.quantity;
    }
    return { now, monthly };
  }, [lines]);
  const hasService = lines.some((l) => !['PHYSICAL_GOOD'].includes(l.offer.kind));

  const add = (o: any) => setLines((ls) => ls.find((l) => l.offer.id === o.id) ? ls.map((l) => (l.offer.id === o.id ? { ...l, quantity: l.quantity + 1 } : l)) : [...ls, { offer: o, quantity: 1, msisdn: '' }]);
  const submit = async () => {
    const body = {
      channel, customerId: quick ? undefined : customerId || undefined, accountId: accountId || undefined,
      lines: lines.map((l) => ({ offerId: l.offer.id, quantity: l.quantity, msisdn: l.msisdn || undefined })),
      payment: { method: pay.method, installmentMonths: pay.method === 'INSTALLMENT' ? Number(pay.months) : undefined, reference: pay.reference || undefined },
      attribution: { storeId: ['RETAIL_ASSISTED', 'QUICK_SALE'].includes(channel) ? att.storeId || undefined : undefined, salespersonId: att.salespersonId || undefined, dealerId: channel === 'DEALER' ? att.dealerId || undefined : undefined },
      deliveryAddress: address || undefined,
    };
    const o = await run(() => post('/orders', body));
    if (o) router.push(`/orders/${o.id}`);
  };
  const ready = lines.length > 0 && (quick || customerId) && !(channel === 'DEALER' && !att.dealerId);

  return (
    <>
      <LargeTitle subtitle={quick ? 'Walk-in outright sale: goods only, no customer record needed' : 'Capture an order for digital self-service or assisted channels'}>New order</LargeTitle>
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Channel"><Select value={channel} onChange={(e) => { setChannel(e.target.value); setLines([]); }}>{CHANNELS.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>
              {!quick && (
                <div>
                  <Field label="Customer" hint={cust.data ? undefined : 'Type 2+ characters to search'}>
                    {customerId && cust.data ? (
                      <div className="flex min-h-tap items-center justify-between rounded-control bg-surface2 px-3"><span className="font-medium">{cust.data.customer.displayName}</span><button className="text-subhead text-accent" onClick={() => { setCustomerId(''); setAccountId(''); }}>Change</button></div>
                    ) : <Input value={custQ} onChange={(e) => setCustQ(e.target.value)} placeholder="Name, phone or number" />}
                  </Field>
                  {!customerId && found.data?.items.map((c: any) => <button key={c.id} onClick={() => { setCustomerId(c.id); setCustQ(''); }} className="mt-1 block w-full rounded-control bg-surface2 px-3 py-2 text-left text-subhead">{c.displayName} <span className="text-label2">· {label(c.segment)}</span></button>)}
                </div>
              )}
              {cust.data && cust.data.accounts.length > 1 && (
                <Field label="Bill to account"><Select value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">First active account</option>{cust.data.accounts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
              )}
            </div>
          </Card>

          <div>
            <SectionTitle action={<Input type="search" aria-label="Search offers" placeholder="Search offers…" value={offerQ} onChange={(e) => setOfferQ(e.target.value)} className="!min-h-[36px] !w-44" />}>Offers</SectionTitle>
            {offers.loading && !offers.data && <Spinner />}
            <div className="grid gap-3 sm:grid-cols-2">
              {visible.map((o: any) => {
                const rec = o.prices.find((p: any) => p.type === 'RECURRING'), once = o.prices.find((p: any) => p.type === 'ONE_TIME');
                return (
                  <button key={o.id} onClick={() => add(o)} className="rounded-card bg-surface p-4 text-left shadow-card transition hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    <div className="flex items-start justify-between gap-2"><span className="font-medium">{o.name}</span><Badge>{label(o.kind)}</Badge></div>
                    <p className="mt-1 text-subhead text-label2">{[rec && `${money(rec.amount.amountMinor)}/mo`, once && (once.amount.amountMinor ? `${money(once.amount.amountMinor)} upfront` : 'no upfront')].filter(Boolean).join(' · ')}</p>
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
                      {SERVICE_KINDS.includes(l.offer.kind) && l.quantity === 1 && <Input aria-label="Port-in number" placeholder="Port-in number (optional)" value={l.msisdn} onChange={(e) => setLines(lines.map((x) => (x === l ? { ...x, msisdn: e.target.value } : x)))} />}
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
            <p className="mt-1 text-caption text-label2">Preview at {TAX_BPS / 100}% tax; the server prices the final order.</p>
          </Card>

          <Card className="space-y-3">
            <Field label="Payment"><Select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
              {['CREDIT_CARD', 'CASH', 'QR', ...(quick ? [] : ['INSTALLMENT'])].map((m) => <option key={m} value={m}>{label(m)}</option>)}</Select></Field>
            {pay.method === 'INSTALLMENT' && <Field label="Instalment months" hint={hasService ? undefined : 'Instalments need a service line'}><Select value={pay.months} onChange={(e) => setPay({ ...pay, months: e.target.value })}>{[3, 6, 12, 24, 36].map((m) => <option key={m}>{m}</option>)}</Select></Field>}
            {pay.method === 'CREDIT_CARD' && <Field label="Card reference" hint="Simulated gateway: a reference starting DECLINE is declined"><Input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>}
            {['RETAIL_ASSISTED', 'QUICK_SALE'].includes(channel) && <Field label="Store"><Select value={att.storeId} onChange={(e) => setAtt({ ...att, storeId: e.target.value })}><option>STORE-SG-001</option><option>STORE-SG-002</option></Select></Field>}
            {channel !== 'SELF_SERVE' && <Field label="Salesperson ID" hint="Drives commission"><Input value={att.salespersonId} onChange={(e) => setAtt({ ...att, salespersonId: e.target.value })} /></Field>}
            {channel === 'DEALER' && <Field label="Dealer ID"><Input required value={att.dealerId} onChange={(e) => setAtt({ ...att, dealerId: e.target.value })} /></Field>}
            {!['RETAIL_ASSISTED', 'QUICK_SALE'].includes(channel) && <Field label="Delivery / install address"><Input value={address} onChange={(e) => setAddress(e.target.value)} /></Field>}
            {error && <Alert>{error}</Alert>}
            <Button className="w-full" disabled={!ready || busy} onClick={submit}>{busy ? 'Placing order…' : 'Place order'}</Button>
          </Card>
        </aside>
      </div>
    </>
  );
}
