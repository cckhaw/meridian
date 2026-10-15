'use client';
import { Alert, Button, Card, Spinner } from '@meridian/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, post, useAction, useApi, useDebounced } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money } from '@/lib/format';
import type { Party } from './steps';
import { AddonsStep, CustomerStep, DeliveryStep, DeviceStep, PayStep, PaymentStep, ProductStep, ReviewStep, type Wizard } from './steps';
import { FamilyStep } from './family-step';
import { SimStep } from './sim-step';
import { duplicateProblem, financeable, isGroupPlan, isExclusive, lineBody, newItem, portInReady, quoteIndex, type Cust, type Item, type StepId } from './wizard-types';
import { Row, StepFrame, Stepper } from './wizard-ui';

// Every CRM order is staff-assisted. Self-serve orders come from the store-front, so that channel is not offered here.
const ALL_CHANNELS = ['RETAIL_ASSISTED', 'QUICK_SALE', 'CALL_CENTER', 'TELESALES', 'DEALER'];

/**
 * A guided order: plan, device, add-ons, how to pay, customer, delivery, review, payment. One decision per screen, with the running total always in view.
 * Prices, bundle discounts and eligibility all come from the server's quote, so what is shown is exactly what will be charged.
 */
export function NewOrder() {
  const { me, can } = useAuth();
  const sp = useSearchParams();
  const router = useRouter();
  // A quick sale is rung up at the signed-in user's own store, so only store users are offered it.
  const channels = ALL_CHANNELS.filter((c) => can(`order:create:${c}`) && (c !== 'QUICK_SALE' || !!me?.storeId));
  const wanted = sp.get('channel');
  const [channel, setChannelRaw] = useState(wanted && channels.includes(wanted) ? wanted : channels[0] ?? '');
  const portal = !!me?.customerId && !can('customer:search');
  const quick = channel === 'QUICK_SALE';
  const retail = channel === 'RETAIL_ASSISTED' || quick;
  const [items, setItemsRaw] = useState<Item[]>([]);
  const [customer, setCustomer] = useState<Cust | null>(null);
  const [accountId, setAccountId] = useState('');
  const [store, setStore] = useState(me?.storeId ?? '');
  const [dealer, setDealer] = useState<Party | null>(null);
  const [agent, setAgent] = useState<Party | null>(null);
  const [address, setAddress] = useState('');
  const [method, setMethod] = useState<'SHIP' | 'COLLECT' | ''>('');
  const [pickupStore, setPickupStore] = useState('');
  const [slot, setSlot] = useState('');
  const [pay, setPay] = useState({ method: 'CASH', reference: '', received: true });
  const [consent, setConsent] = useState(false);
  const [kindHint, setKindHint] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const dir = useRef<'fwd' | 'back'>('fwd');
  const idemKey = useRef(crypto.randomUUID()); // one key per form: a double-click or retry cannot create a second order
  const meta = useApi('/meta');
  const numbering = useApi<any>(can('numbering:select') ? '/numbering/tiers' : null);
  const { run, busy, error } = useAction();
  const marketCode = me?.marketCode ?? 'SG';
  const cashier = can('order:payment') && !portal;

  // The customer the order is for: given in the address (from their 360), or the portal user themself.
  const presetCustomer = portal ? me?.customerId ?? null : sp.get('customerId');
  const preset = useApi<any>(presetCustomer && !customer ? `/customers/${presetCustomer}` : null);
  useEffect(() => { if (preset.data && !customer) setCustomer({ id: preset.data.customer.id, displayName: preset.data.customer.displayName, segment: preset.data.customer.segment, kycStatus: preset.data.customer.kycStatus }); }, [preset.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // deep link from a recommendation
    const pre = sp.get('offerId');
    if (pre) void api(`/catalog/${encodeURIComponent(pre)}`).then((o) => { if (o.level === 'OFFER' && o.status === 'ACTIVE') setItemsRaw((cur) => (cur.length ? cur : [newItem(o)])); }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setItems = useCallback((f: (c: Item[]) => Item[]) => { setItemsRaw(f); setConsent(false); }, []);
  const setChannel = (c: string) => { setChannelRaw(c); setItemsRaw([]); setIndex(0); idemKey.current = crypto.randomUUID(); };

  // ── the server's quote, refreshed as the basket changes ──
  const body = useMemo(() => ({ channel, customerId: quick || portal ? undefined : customer?.id, accountId: accountId || undefined, lines: items.map((i) => lineBody(i, items)) }), [channel, quick, portal, customer?.id, accountId, items]);
  const key = useDebounced(JSON.stringify(body), 250);
  const [quote, setQuote] = useState<any>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const b = JSON.parse(key);
    if (!b.lines?.length) { setQuote(null); setQuoteError(null); return; }
    const n = ++seq.current;
    setQuoting(true);
    api('/orders/quote', { method: 'POST', json: b }).then((q) => { if (n === seq.current) { setQuote(q); setQuoteError(null); } })
      .catch((e) => { if (n === seq.current) setQuoteError((e as Error).message); })
      .finally(() => { if (n === seq.current) setQuoting(false); });
  }, [key]);

  // ── which steps this order needs ──
  const needs = quote?.needs ?? { delivery: false, installation: false, sim: false };
  const methods: Array<'SHIP' | 'COLLECT'> = quote?.deliveryMethods ?? [];
  const how: 'SHIP' | 'COLLECT' | null = !needs.delivery || methods.length === 0 ? null : method && methods.includes(method) ? method : methods.includes('SHIP') ? 'SHIP' : 'COLLECT';
  const shipTo = how === 'SHIP' || (needs.delivery && how === null);
  const steps = useMemo<StepId[]>(() => {
    const s: StepId[] = ['product'];
    if (!quick) s.push('device', 'addons');
    if (!quick && !portal && items.some((i) => isGroupPlan(i.offer))) s.push('family');
    if (!quick && !portal && needs.sim && can('numbering:select')) s.push('sim');
    if (items.some((i) => financeable(i.offer))) s.push('payment');
    if (!quick && !portal) s.push('customer');
    if (needs.delivery || needs.installation) s.push('delivery');
    s.push('review', 'pay');
    return s;
  }, [quick, portal, items, needs.delivery, needs.installation, needs.sim, can]);
  const at = Math.min(index, steps.length - 1);
  const stepId = steps[at]!;

  const problems: string[] = quote?.problems ?? [];
  const needsRef = !!(meta.data?.paymentMode === 'manual' && cashier && pay.received && (quote?.dueNowMinor ?? 0) > 0);
  const blocked: string | null = (() => {
    if (quoteError && stepId !== 'product') return quoteError;
    switch (stepId) {
      case 'product': return items.length === 0 ? 'Choose at least one item to continue.' : items.filter((i) => isExclusive(i.offer)).length > 1 ? 'An order can have one plan. Remove the others, or add them as member lines of a family plan.' : retail && !(me?.storeId || store) ? 'Choose the store first.' : channel === 'DEALER' && !dealer ? 'Choose the dealer first.' : channel === 'DEALER' && !agent ? 'Choose the dealer’s agent who made the sale.' : null;
      case 'device': return items.some((i) => i.offer.variants?.length && !i.variantId) ? 'Choose a colour and storage.' : null;
      case 'family': return items.flatMap((i) => (i.members ?? []).map((m, k) => (!m.offerId ? `Choose the plan for member ${k + 1}.` : null))).find(Boolean) ?? quoteError ?? null;
      case 'sim': return !portInReady(items.flatMap((i) => [i.portIn, ...(i.members ?? []).map((m) => m.portIn)]).find((p) => !portInReady(p))) ? 'Complete the port-in details.' : duplicateProblem(items) ?? quoteError ?? problems[0] ?? (numbering.data?.settings?.requireSim ? items.flatMap((i, k) => { const qi = quoteIndex(items, k); return [{ x: i as { iccid?: string; simType?: string }, l: quote?.lines?.[qi], name: i.offer.name }, ...(i.members ?? []).filter((m) => m.offerId).map((m, n) => ({ x: m as { iccid?: string; simType?: string }, l: quote?.lines?.[qi + 1 + n], name: `${i.offer.name}, member ${n + 1}` }))]; }).map(({ x, l, name }) => (l?.needsSim && !x.iccid && !x.simType ? `Choose the SIM for ${name}.` : null)).find(Boolean) ?? null : null);
      case 'payment': return quoteError;
      case 'customer': return !customer ? 'Choose or create the customer to continue.' : problems[0] ?? null;
      case 'delivery': return how === 'COLLECT' && !pickupStore ? 'Choose the store where the customer will collect.' : shipTo && !address.trim() ? 'Enter the delivery address.' : needs.installation && !shipTo && !address.trim() ? 'Enter the installation address.' : null;
      case 'review': return duplicateProblem(items) ?? problems[0] ?? (!consent ? 'Confirm the customer has been told the terms.' : null);
      case 'pay': return needsRef && !pay.reference.trim() ? 'Enter the receipt or approval number.' : problems[0] ?? null;
      default: return null;
    }
  })();

  const go = (i: number) => { dir.current = i >= at ? 'fwd' : 'back'; setIndex(Math.max(0, Math.min(i, steps.length - 1))); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const jumpTo = (id: string, opts?: { kind?: string }) => { const i = steps.indexOf(id as StepId); if (i >= 0) { if (opts?.kind) setKindHint(opts.kind); go(i); } };

  const submit = async () => {
    const o = await run(() => post('/orders', {
      ...body, installationSlot: slot ? new Date(slot).toISOString() : undefined, deliveryAddress: (shipTo || needs.installation) && address ? address : undefined,
      delivery: how ? { method: how, pickupStoreId: how === 'COLLECT' ? pickupStore : undefined } : undefined,
      payment: { method: (quote?.dueNowMinor ?? 0) > 0 ? pay.method : 'CASH', reference: pay.reference || undefined, confirmed: cashier && pay.received && (quote?.dueNowMinor ?? 0) > 0 ? true : undefined },
      storeId: retail ? me?.storeId || store || undefined : undefined, dealerId: channel === 'DEALER' ? dealer?.id : undefined, dealerAgentId: channel === 'DEALER' ? agent?.id : undefined,
    }, { 'idempotency-key': idemKey.current }));
    if (o) router.push(`/orders/${o.id}`);
  };

  if (channels.length === 0) return <Alert tone="info">Your role cannot create orders.</Alert>;
  const w: Wizard = {
    channel, channels, setChannel, store, setStore, dealer, setDealer, agent, setAgent, soldBy: { name: me?.displayName ?? '', username: me?.username ?? '' }, quick, retail, portal, cashier, manual: meta.data?.paymentMode === 'manual',
    marketCode, fixedStore: me?.storeId, fixedDealer: me?.dealerId, items, setItems, quote, quoting, quoteError, customer, setCustomer, accountId, setAccountId, canCreateCustomer: can('customer:create'),
    address, setAddress, deliveryMethods: methods, method: how, setMethod, pickupStore, setPickupStore, slot, setSlot, pay, setPay, consent, setConsent, jumpTo, kindHint, clearKindHint: () => setKindHint(null), can,
  };
  const last = stepId === 'pay';

  return (
    <>
      <Stepper steps={steps} index={at} onGo={go} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 pb-48 md:pb-28 lg:pb-0">
          <StepFrame id={stepId} direction={dir.current}>
            {preset.loading && !customer && presetCustomer ? <Spinner /> : (
              <>
                {stepId === 'product' && <ProductStep w={w} />}
                {stepId === 'device' && <DeviceStep w={w} />}
                {stepId === 'addons' && <AddonsStep w={w} />}
                {stepId === 'family' && <FamilyStep w={w} />}
                {stepId === 'sim' && <SimStep w={w} requireSim={!!numbering.data?.settings?.requireSim} />}
                {stepId === 'payment' && <PaymentStep w={w} />}
                {stepId === 'customer' && <CustomerStep w={w} />}
                {stepId === 'delivery' && <DeliveryStep w={w} />}
                {stepId === 'review' && <ReviewStep w={w} />}
                {stepId === 'pay' && <PayStep w={w} />}
              </>
            )}
          </StepFrame>
          {error && <div className="mt-4"><Alert>{error}</Alert></div>}
          <div className="material fixed inset-x-0 bottom-[calc(56px+var(--sab,0px))] z-20 border-t border-separator px-4 pb-3 pt-3 md:bottom-0 md:pb-[calc(12px+var(--sab,0px))] lg:static lg:mt-8 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
            <div className="mx-auto flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-center lg:mx-0 lg:max-w-none">
              {blocked && <p role="status" className="flex-1 text-footnote text-label2 lg:order-2 lg:text-right">{blocked}</p>}
              {!blocked && <span className="flex-1" />}
              <div className="flex gap-2 lg:order-1">
                {at > 0 && <Button variant="secondary" onClick={() => go(at - 1)} disabled={busy}>Back</Button>}
                {last
                  ? <Button className="flex-1 sm:flex-none" onClick={submit} disabled={!!blocked || busy}>{busy ? 'Placing order…' : (quote?.dueNowMinor ?? 0) > 0 && (!cashier || !pay.received) ? 'Place order and pay' : 'Place order'}</Button>
                  : <Button className="flex-1 sm:flex-none" onClick={() => go(at + 1)} disabled={!!blocked}>Continue</Button>}
              </div>
            </div>
          </div>
        </div>

        <aside className="hidden lg:block"><div className="sticky top-6"><Summary w={w} onJump={jumpTo} /></div></aside>
      </div>
      <MobileSummary w={w} />
    </>
  );
}

function Summary({ w, onJump }: { w: Wizard; onJump: (id: string) => void }) {
  const q = w.quote;
  return (
    <Card>
      <h2 className="mb-3 text-title3 font-semibold">Order</h2>
      {w.items.length === 0 ? <p className="text-subhead text-label2">Nothing yet. Choose a plan or product to start.</p> : (
        <ul className="space-y-3">
          {w.items.map((it, i) => {
            const qi = quoteIndex(w.items, i);
            const l = q?.lines?.[qi];
            return (
              <li key={it.key} className="rounded-control bg-surface2 p-3">
                <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate font-medium">{it.offer.name}</p>
                  {l?.variant && <p className="text-footnote text-label2">{l.variant.colour}{l.variant.storage ? ` · ${l.variant.storage}` : ''}</p>}
                  {l?.payMode === 'INSTALLMENT' && <p className="text-footnote text-label2">{l.months} × {money(l.instalmentMinor)}/mo</p>}</div>
                  <button aria-label={`Remove ${it.offer.name}`} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-label2 hover:bg-separator" onClick={() => w.setItems((c) => c.filter((x) => x.key !== it.key))}>×</button></div>
                <div className="mt-2 flex items-center justify-between text-subhead">
                  {isGroupPlan(it.offer) ? <span className="text-footnote text-label2">{(it.members ?? []).length} member line{(it.members ?? []).length === 1 ? '' : 's'}</span> : isExclusive(it.offer) ? <span className="text-footnote text-label2">One plan</span> : <span className="flex items-center gap-1"><button aria-label="Fewer" className="grid h-7 w-7 place-items-center rounded-full bg-surface" onClick={() => w.setItems((c) => c.map((x) => (x.key === it.key ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x)))}>−</button><span className="w-6 text-center tabular-nums">{it.quantity}</span><button aria-label="More" className="grid h-7 w-7 place-items-center rounded-full bg-surface" onClick={() => w.setItems((c) => c.map((x) => (x.key === it.key ? { ...x, quantity: Math.min(1000, x.quantity + 1) } : x)))}>+</button></span>}
                  {l && <span className="tabular-nums">{money(l.priceMinor)}</span>}
                </div>
                {isGroupPlan(it.offer) && (it.members ?? []).map((m, k) => { const ml = q?.lines?.[qi + 1 + k]; return ml ? <p key={m.key} className="mt-1 flex justify-between gap-2 text-footnote text-label2"><span className="truncate">+ {ml.name}{ml.portIn ? ' (port-in)' : ''}</span><span className="tabular-nums">{money(ml.priceMinor)}</span></p> : null; })}
              </li>
            );
          })}
        </ul>
      )}
      {q && (
        <dl className="mt-4 border-t border-separator pt-2">
          {q.discountMinor > 0 && <Row k="Bundle savings" v={<span className="text-success">− {money(q.discountMinor)}</span>} />}
          <Row k="Due today" v={money(q.dueNowMinor)} strong />
          <Row k="Each month" v={money(q.monthlyTotalMinor)} />
        </dl>
      )}
      {w.quoting && <p className="mt-1 text-caption text-label2" aria-live="polite">Updating…</p>}
      {w.quoteError && <p className="mt-2 text-footnote text-danger">{w.quoteError}</p>}
      {q && <p className="mt-2 text-caption text-label2">Prices include {q.taxName}.</p>}
      {w.customer && <button className="mt-3 text-footnote text-accent" onClick={() => onJump('customer')}>For {w.customer.displayName}</button>}
    </Card>
  );
}

function MobileSummary({ w }: { w: Wizard }) {
  const [open, setOpen] = useState(false);
  if (!w.items.length) return null;
  return (
    <div className="lg:hidden">
      <button type="button" onClick={() => setOpen(true)} className="fixed bottom-[calc(56px+var(--sab,0px)+84px)] right-4 z-20 rounded-full md:bottom-[88px] bg-label px-4 py-2 text-subhead font-medium text-bg shadow-card active:scale-95">
        {w.items.length} item{w.items.length === 1 ? '' : 's'}{w.quote ? ` · ${money(w.quote.dueNowMinor)} today` : ''}
      </button>
      {open && (
        <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Order summary">
          <button aria-label="Close summary" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="sheet-in material-thick absolute inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-t-[20px] p-4 pb-8">
            <div className="mb-2 flex justify-between"><span className="text-title3 font-semibold">Your order</span><button className="text-accent" onClick={() => setOpen(false)}>Done</button></div>
            <Summary w={w} onJump={() => setOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
