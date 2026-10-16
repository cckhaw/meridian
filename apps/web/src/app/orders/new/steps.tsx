'use client';
import { useMultiMarket } from '@/lib/markets';
import { Alert, Badge, Button, Card, Field, Input, LoadMore, SearchField, Segmented, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { api, post, useAction, useApi, useDebounced, usePaged } from '@/lib/api';
import { label, money, step as moneyStep } from '@/lib/format';
import { useSegments } from '@/lib/segments';
import { Row, Section } from './wizard-ui';
import { StorePicker } from '@/app/stores/store-picker';
import { CustomerForm } from '@/app/customers/customer-form';
import { KycCard } from '@/components/kyc-card';
import { SellingPanel } from './selling-panel';
import { FinancingPanel } from './financing-panel';
import { AgreementSigner, FiberCoverageCheck, type AgreementView, type FiberApi, type SignedPayload } from '@meridian/ui';
import { MONTHS, SWATCH, clashesWith, financeable, flatLines, isExclusive, isPlan, newItem, quoteIndex, type Cust, type Item } from './wizard-types';
import { useOfferTypes } from '@/lib/offer-types';

export interface Party { id: string; name: string }

/** Everything the steps share. The shell owns it so going back and forward never loses a choice. */
export interface Wizard {
  channel: string; channels: string[]; setChannel: (c: string) => void;
  store: string; setStore: (s: string) => void;
  dealer: Party | null; setDealer: (d: Party | null) => void; agent: Party | null; setAgent: (a: Party | null) => void; soldBy: { name: string; username: string };
  quick: boolean; retail: boolean; portal: boolean; cashier: boolean; manual: boolean; marketCode: string; fixedStore?: string | null; fixedDealer?: string | null;
  items: Item[]; setItems: (f: (cur: Item[]) => Item[]) => void;
  quote: any | null; quoting: boolean; quoteError: string | null;
  customer: Cust | null; setCustomer: (c: Cust | null) => void; accountId: string; setAccountId: (id: string) => void; canCreateCustomer: boolean;
  address: string; setAddress: (s: string) => void;
  /** Pairs of offer types that cannot be in the same order. */
  conflicts: Array<[string, string]>;
  /** The agreements this order needs and the customer's signature on them. */
  agreements: { data: { required: boolean; agreements: AgreementView[] } | null; signed: SignedPayload | null; setSigned: (s: SignedPayload | null) => void };
  /** Live installation times from the field-service system (when Settings allows): offered, the one chosen, and whether the agent chose to book later. */
  booking: { enabled: boolean; slot: { id: string; start: string; end: string } | null; setSlot: (s: { id: string; start: string; end: string } | null) => void; later: boolean; setLater: (b: boolean) => void };
  /** How the goods reach the customer (what every goods offer allows), the one chosen, and the store for collection. */
  deliveryMethods: Array<'SHIP' | 'COLLECT'>; method: 'SHIP' | 'COLLECT' | null; setMethod: (m: 'SHIP' | 'COLLECT') => void; pickupStore: string; setPickupStore: (s: string) => void;
  slot: string; setSlot: (s: string) => void;
  pay: { method: string; reference: string; received: boolean }; setPay: (p: { method: string; reference: string; received: boolean }) => void;
  consent: boolean; setConsent: (b: boolean) => void;
  jumpTo: (id: string, opts?: { kind?: string }) => void; kindHint: string | null; clearKindHint: () => void;
  can: (...p: string[]) => boolean;
  /** Fibre coverage module: on or off, the port held at checkout, and the speed of the fibre plan chosen. */
  fiber: { enabled: boolean; lock: string | null; setLock: (id: string | null) => void; speedMbps?: number };
  /** Device financing: pay a device on a contract in full, and the credit check that sets the upfront share. */
  financing: { payInFull: boolean; setPayInFull: (b: boolean) => void; check: { id: string; score: number | null; band: string | null; fallback: boolean } | null; setCheck: (c: { id: string; score: number | null; band: string | null; fallback: boolean } | null) => void };
}

/** The coverage service, asked through the CRM's own API (the browser never calls it directly). */
const fiberApi: FiberApi = { qualify: (p) => post('/fiber/qualify', p), reserve: (p) => post('/fiber/reserve', p), release: (id) => post(`/fiber/reservations/${id}/release`), waitlist: (p) => post('/fiber/waitlist', p) };

const priceLine = (o: any) => {
  const rec = o.prices?.find((p: any) => p.type === 'RECURRING'), once = o.prices?.find((p: any) => p.type === 'ONE_TIME');
  return [rec && `${money(rec.amount.amountMinor, rec.amount.currency)}/mo`, once && (once.amount.amountMinor ? `${money(once.amount.amountMinor, once.amount.currency)} upfront` : 'nothing upfront')].filter(Boolean).join(' · ') || 'Free';
};

function OfferCard({ o, chosen, onToggle, note, disabled }: { o: any; chosen: boolean; onToggle: () => void; note?: string; disabled?: boolean }) {
  const types = useOfferTypes();
  return (
    <button type="button" onClick={onToggle} aria-pressed={chosen} disabled={disabled}
      className={`relative rounded-card border p-4 text-left shadow-card transition disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${chosen ? 'border-accent bg-accent/5' : 'border-transparent bg-surface hover:-translate-y-0.5'}`}>
      <div className="flex items-start justify-between gap-2"><span className="font-medium">{o.name}</span><Badge>{types.name(o.kind)}</Badge></div>
      {o.description && <p className="mt-1 line-clamp-2 text-footnote text-label2">{o.description}</p>}
      <p className="mt-2 text-subhead font-medium">{priceLine(o)}</p>
      <p className="text-footnote text-label2">{o.contract?.termMonths > 0 ? `${o.contract.termMonths}-month contract` : o.kind === 'PHYSICAL_GOOD' ? 'Outright purchase' : 'No contract'}{o.variants?.length ? ` · ${new Set(o.variants.map((v: any) => v.colour)).size} colours` : ''}</p>
      {note && <p className="mt-1 text-footnote text-accent">{note}</p>}
      {chosen && <span aria-hidden className="absolute bottom-3 right-3 grid h-6 w-6 place-items-center rounded-full bg-accent text-caption text-accent-fg">✓</span>}
    </button>
  );
}

function OfferPicker({ w, kind, step, outright, placeholder, noteFor }: { w: Wizard; kind?: string; step?: 'PLAN' | 'DEVICE'; outright?: boolean; placeholder: string; noteFor?: (o: any) => string | undefined }) {
  const multi = useMultiMarket();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const scope = `&forSale=1${kind ? `&kind=${kind}` : ''}${step ? `&step=${step}` : ''}${outright ? '&outright=1' : ''}`;
  const list = usePaged<any>(`/catalog?limit=24&status=ACTIVE&market=${w.marketCode}${scope}&q=${encodeURIComponent(term)}`);
  // An order carries one mobile plan (a family plan brings its other lines as members), so once a plan is chosen the other plans wait until it is removed.
  const planChosen = w.items.find((i) => isExclusive(i.offer));
  const waits = (o: any) => (isExclusive(o) && !!planChosen && planChosen.offer.id !== o.id) || !!clashesWith(o, w.items, w.conflicts);
  const toggle = (o: any) => { if (!waits(o)) w.setItems((cur) => (cur.some((i) => i.offer.id === o.id) ? cur.filter((i) => i.offer.id !== o.id) : [...cur, newItem(o)])); };
  // When nothing is listed, find out whether offers exist in some other market, so the message can say why instead of pretending there are none.
  const elsewhere = useApi<{ items: any[] }>(!list.loading && list.items.length === 0 && !term && multi ? `/catalog?limit=1&status=ACTIVE${scope}` : null);
  return (
    <>
      <SearchField label={placeholder} placeholder={placeholder} value={q} onChange={setQ} className="mb-3 sm:max-w-md" />
      {list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && (
        <Alert tone="info">
          {term ? 'Nothing matches.' : elsewhere.data && elsewhere.data.items.length > 0
            ? <>There are live offers, but none is sold in <strong>{w.marketCode}</strong>, the market of this login. {w.can('user:manage') ? 'Change this user’s market under Users & roles, or sell the offers in that market (offer → Availability).' : 'Ask an administrator to set your market, or to sell the offers in it.'}</>
            : <>No sellable offers here yet.{w.can('catalog:write') ? ' Create and activate offers in the catalog.' : ''}</>}
        </Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {list.items.map((o) => <OfferCard key={o.id} o={o} chosen={w.items.some((i) => i.offer.id === o.id)} onToggle={() => toggle(o)} disabled={waits(o)} note={waits(o) ? (clashesWith(o, w.items, w.conflicts) ? `Not available with ${clashesWith(o, w.items, w.conflicts)!.offer.name}: remove it to choose this one` : `One plan per order: remove ${planChosen!.offer.name} to choose this one`) : noteFor?.(o)} />)}
      </div>
      {list.items.length > 0 && <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="offers" />}
    </>
  );
}

// ───────────────────────── 1. product ─────────────────────────
export function ProductStep({ w }: { w: Wizard }) {
  return (
    <>
      {!w.portal && <SellingPanel w={w} />}
      {w.kindHint && <p className="mb-3 text-subhead text-label2">Showing {label(w.kindHint.split(',')[0]!).toLowerCase()} only · <button className="text-accent" onClick={w.clearKindHint}>Show everything</button></p>}
      <OfferPicker w={w} outright={w.quick} kind={w.quick ? undefined : w.kindHint ?? undefined} step={w.quick || w.kindHint ? undefined : 'PLAN'} placeholder={w.quick ? 'Search goods' : 'Search plans and products'} noteFor={(o) => (o.fulfilment?.requiresInstallation ? 'Needs an installation visit' : undefined)} />
    </>
  );
}

// ───────────────────────── 2. device ─────────────────────────
function VariantPicker({ w, item }: { w: Wizard; item: Item }) {
  const vs: any[] = item.offer.variants ?? [];
  const loc = w.fixedStore ?? (w.retail ? w.store : '');
  const avail = useApi<{ items: Array<{ variantId: string; available: number }> }>(`/catalog/${item.offer.id}/availability${loc ? `?location=${encodeURIComponent(loc)}` : ''}`);
  const stock = (id: string) => avail.data?.items.find((x) => x.variantId === id)?.available;
  const colours = [...new Set(vs.map((v) => v.colour))];
  const cur = vs.find((v) => v.id === item.variantId) ?? vs[0];
  const storages = [...new Set(vs.map((v) => v.storage).filter(Boolean))] as string[];
  const base = (item.offer.prices ?? []).filter((p: any) => p.type === 'ONE_TIME').reduce((t: number, p: any) => t + p.amount.amountMinor, 0);   // storage options show the full price, not the step from the base model
  const set = (variantId: string) => w.setItems((c) => c.map((i) => (i.key === item.key ? { ...i, variantId } : i)));
  const pickColour = (colour: string) => { const same = vs.filter((v) => v.colour === colour); set((same.find((v) => v.storage === cur.storage) ?? same[0]).id); };
  const colourOut = (c: string) => vs.filter((v) => v.colour === c).every((v) => stock(v.id) === 0);
  return (
    <Card className="mb-4">
      <p className="text-footnote font-semibold uppercase tracking-wide text-label2">{item.offer.name}</p>
      <p className="mb-3 text-title3 font-semibold">{cur.colour}{cur.storage ? ` · ${cur.storage}` : ''}</p>
      <fieldset className="mb-4"><legend className="mb-2 text-subhead font-medium">Colour</legend>
        <div className="flex flex-wrap gap-3">
          {colours.map((c) => {
            const on = c === cur.colour, out = colourOut(c);
            return (
              <button key={c} type="button" onClick={() => pickColour(c)} disabled={out} aria-pressed={on} aria-label={`${c}${out ? ' (out of stock)' : ''}`}
                className={`flex min-h-[44px] items-center gap-2 rounded-full border py-1 pl-1.5 pr-4 text-subhead transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 ${on ? 'border-accent bg-accent/8 font-medium' : 'border-separator'}`}>
                <span aria-hidden className="h-8 w-8 rounded-full border border-black/10 shadow-inner" style={{ background: SWATCH[c.toLowerCase()] ?? '#c7c7cc' }} />{c}
              </button>
            );
          })}
        </div>
      </fieldset>
      {storages.length > 0 && (
        <fieldset><legend className="mb-2 text-subhead font-medium">Storage</legend>
          <div className="flex flex-wrap gap-3">
            {storages.map((st) => {
              const v = vs.find((x) => x.colour === cur.colour && x.storage === st);
              const on = v?.id === cur.id, s = v ? stock(v.id) : undefined;
              return (
                <button key={st} type="button" onClick={() => v && set(v.id)} disabled={!v || s === 0} aria-pressed={on}
                  className={`min-h-[52px] rounded-control border px-5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 ${on ? 'border-accent bg-accent/8' : 'border-separator'}`}>
                  <span className="block font-medium">{st}</span>
                  <span className="block text-footnote text-label2">{!v ? `Not offered in ${cur.colour}` : `${money(base + (v.priceDeltaMinor ?? 0))}${s === 0 ? ' · out of stock' : s !== undefined && s <= 5 ? ` · only ${s} left` : ''}`}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}
    </Card>
  );
}

/** How a device is bought: outright, or on a contract with one of the plans in the basket. */
function ContractChoice({ w, item }: { w: Wizard; item: Item }) {
  const deals: any[] = item.offer.deals ?? [];
  const taken = new Set(w.items.filter((x) => x.key !== item.key && x.deal).map((x) => x.deal!.planKey));
  const plans = w.items.filter((x) => isPlan(x.offer) && x.quantity === 1 && !taken.has(x.key));
  const set = (deal: Item['deal']) => w.setItems((c) => c.map((x) => (x.key === item.key ? { ...x, deal, payMode: 'UPFRONT' } : x)));
  const l = w.quote?.lines?.[quoteIndex(w.items, w.items.findIndex((x) => x.key === item.key))];
  return (
    <Card className="mb-4 space-y-3">
      <div><p className="font-semibold">{item.offer.name}</p><p className="text-footnote text-label2">Buy it outright, or on a contract with a plan and pay less today.</p></div>
      <Segmented label={`How ${item.offer.name} is bought`} value={item.deal ? 'CONTRACT' : 'OUTRIGHT'} options={[{ value: 'OUTRIGHT', label: 'Outright' }, { value: 'CONTRACT', label: 'On a contract' }]}
        onChange={(v) => (v === 'OUTRIGHT' ? set(undefined) : plans[0] && set({ planKey: plans[0].key, term: deals[0].termMonths }))} />
      {!item.deal && plans.length === 0 && <p className="text-footnote text-label2">Add a plan (a SIM-only plan, for example) to buy this device on a contract.</p>}
      {item.deal && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="With plan"><Select value={item.deal.planKey} onChange={(e) => set({ ...item.deal!, planKey: e.target.value })}>
            {w.items.filter((x) => x.key === item.deal!.planKey || plans.some((p) => p.key === x.key)).map((x) => <option key={x.key} value={x.key}>{x.offer.name}</option>)}</Select></Field>
          <Field label="Contract"><Select value={item.deal.term} onChange={(e) => set({ ...item.deal!, term: Number(e.target.value) })}>
            {deals.map((d) => <option key={d.termMonths} value={d.termMonths}>{d.termMonths} months · {money(d.subsidyMinor)} off</option>)}</Select></Field>
          {l?.deal && <p className="text-footnote text-label2 sm:col-span-2">Price on this contract: <strong>{money(l.priceMinor)}</strong> (retail {money(l.deal.retailMinor)}). Leaving early repays the subsidy that is left.</p>}
        </div>
      )}
    </Card>
  );
}

export function DeviceStep({ w }: { w: Wizard }) {
  const withVariants = w.items.filter((i) => i.offer.variants?.length);
  const contractable = w.items.filter((i) => i.offer.deals?.length);
  return (
    <>
      {contractable.map((i) => <ContractChoice key={i.key} w={w} item={i} />)}
      {withVariants.map((i) => <VariantPicker key={i.key} w={w} item={i} />)}
      {withVariants.length === 0 && <p className="mb-4 rounded-card bg-surface px-4 py-5 text-subhead text-label2 shadow-card">The plans you chose do not come with a device. You can add one below, or continue.</p>}
      <Section title="Add a device or accessory"><OfferPicker w={w} step="DEVICE" placeholder="Search devices" /></Section>
    </>
  );
}

// ───────────────────────── 3. add-ons and bundles ─────────────────────────
export function AddonsStep({ w }: { w: Wizard }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const offers = w.items.map((i) => i.offer.id).join(',');
  const list = usePaged<any>(`/orders/addons?channel=${w.channel}&offers=${encodeURIComponent(offers)}${w.customer ? `&customerId=${w.customer.id}` : ''}&limit=12&q=${encodeURIComponent(term)}`);
  const rules = useApi<{ items: any[] }>('/bundle-rules');
  const kinds = new Set(w.items.map((i) => i.offer.kind)), ids = new Set(w.items.map((i) => i.offer.id));
  const has = (t: string) => (t.startsWith('kind:') ? kinds.has(t.slice(5)) : ids.has(t.slice(6)));
  // A bundle that is one item short is worth mentioning: "add fibre and the phone is 10% cheaper".
  const hints = (rules.data?.items ?? []).filter((r) => r.status === 'ACTIVE').map((r) => ({ r, missing: r.when.filter((t: string) => !has(t)) })).filter((h) => h.missing.length === 1 && h.r.when.some(has));
  const toggle = (o: any) => w.setItems((cur) => (cur.some((i) => i.offer.id === o.id) ? cur.filter((i) => i.offer.id !== o.id) : [...cur, newItem(o)]));
  return (
    <>
      {(w.quote?.bundles?.length ?? 0) > 0 && (
        <div className="mb-5 rounded-card bg-success/10 p-4 text-subhead" role="status">
          <p className="font-semibold text-success">Bundle savings</p>
          <ul className="mt-1 space-y-0.5">{w.quote.bundles.map((b: any, i: number) => <li key={i}>{b.name}: <strong>{money(b.discountMinor)}</strong> off {b.lineOffer}</li>)}</ul>
        </div>
      )}
      {hints.map(({ r, missing }) => (
        <div key={r.id} className="mb-3 flex items-center justify-between gap-3 rounded-card bg-accent/8 p-4 text-subhead">
          <span>{r.name}. Add <strong>{label(missing[0].split(':')[1]).toLowerCase()}</strong> to get it.</span>
          {missing[0].startsWith('kind:') && <Button variant="secondary" className="shrink-0 !min-h-[36px] max-lg:!min-h-tap !px-3 !text-subhead" onClick={() => w.jumpTo('product', { kind: missing[0].slice(5) })}>Choose</Button>}
        </div>
      ))}
      <SearchField label="Search add-ons" placeholder="Search add-ons" value={q} onChange={setQ} className="mb-3 sm:max-w-md" />
      {!w.customer && !w.portal && !w.quick && <p className="mb-3 text-footnote text-label2">Add-ons that need something the customer already owns are shown once you have chosen the customer.</p>}
      {list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && <p className="rounded-card bg-surface px-4 py-6 text-center text-subhead text-label2 shadow-card">{term ? 'No add-ons match.' : 'No add-ons are available for this basket.'}</p>}
      <div className="grid gap-3 sm:grid-cols-2">{list.items.map(({ offer }) => <OfferCard key={offer.id} o={offer} chosen={ids.has(offer.id)} onToggle={() => toggle(offer)} />)}</div>
      {list.items.length > 0 && <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="add-ons" />}
    </>
  );
}

// ───────────────────────── 4. how to pay ─────────────────────────
export function PaymentStep({ w }: { w: Wizard }) {
  const lines: any[] = w.quote?.lines ?? [];
  const byKey = (i: number) => w.items[i];
  const update = (key: string, patch: Partial<Item>) => w.setItems((c) => c.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  return (
    <>
      {w.quoteError && <div className="mb-4"><Alert>{w.quoteError}</Alert></div>}
      <div className="space-y-4">
        {w.items.map((it, idx) => {
          const l = lines[quoteIndex(w.items, idx)];
          const can = financeable(it.offer) || !!it.deal;
          const term = it.deal?.term ?? (it.offer.contract?.termMonths || 36);
          const months = MONTHS.filter((m) => m <= term);
          return (
            <Card key={it.key}>
              <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{it.offer.name}</p>
                {l?.variant && <p className="text-footnote text-label2">{l.variant.colour}{l.variant.storage ? ` · ${l.variant.storage}` : ''}</p>}</div>
                {l && <p className="text-right text-subhead tabular-nums"><span className="block font-medium">{money(l.priceMinor)}</span>{l.discountMinor > 0 && <span className="block text-footnote text-success">saves {money(l.discountMinor)}</span>}</p>}
              </div>
              {!can ? (
                <p className="mt-3 text-subhead text-label2">{l && l.priceMinor > 0 ? `Paid today: ${money(l.priceMinor)}.` : 'Nothing to pay upfront.'}{it.offer.kind === 'PHYSICAL_GOOD' ? ' Outright purchases are paid in full.' : ''}</p>
              ) : (
                <div className="mt-3 space-y-3">
                  <Segmented label={`Payment for ${it.offer.name}`} value={it.payMode} options={[{ value: 'UPFRONT', label: 'Pay in full today' }, { value: 'INSTALLMENT', label: 'Instalments' }]} onChange={(v) => update(it.key, { payMode: v })} />
                  {it.payMode === 'INSTALLMENT' && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Spread over" hint={term < 36 ? `No longer than the ${term}-month contract.` : undefined}>
                        <Select value={it.months} onChange={(e) => update(it.key, { months: Number(e.target.value) })}>{months.map((m) => <option key={m} value={m}>{m} months</option>)}</Select>
                      </Field>
                      <Field label="Down payment today" hint="Optional. Taken now; the rest is on the monthly bill."><Input type="number" inputMode="decimal" min="0" step={moneyStep()} value={it.down} onChange={(e) => update(it.key, { down: e.target.value })} /></Field>
                    </div>
                  )}
                  {l && (
                    <dl className="rounded-control bg-surface2 px-4 py-2">
                      <Row k="Paid today" v={money(l.paidNowMinor)} strong />
                      {l.payMode === 'INSTALLMENT' && <Row k={`Then ${l.months} × `} v={`${money(l.instalmentMinor)} / month`} />}
                      {l.contractMonths > 0 && <Row k="Contract" v={`${l.contractMonths} months`} />}
                    </dl>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
      {w.quote && (
        <dl className="mt-5 rounded-card bg-surface px-5 py-3 shadow-card">
          <Row k="Due today" v={money(w.quote.dueNowMinor)} strong />
          <Row k="Plan fees each month" v={money(w.quote.monthlyPlanMinor)} />
          {w.quote.monthlyInstalmentMinor > 0 && <Row k="Device instalments each month" v={money(w.quote.monthlyInstalmentMinor)} />}
          <Row k="Each month in total" v={money(w.quote.monthlyTotalMinor)} strong />
        </dl>
      )}
      {byKey(0) === undefined && <p className="mt-4 text-subhead text-label2">Choose something first.</p>}
    </>
  );
}

// ───────────────────────── 5. customer ─────────────────────────
export function CustomerStep({ w }: { w: Wizard }) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const list = usePaged<any>(term.length >= 3 ? `/customers?limit=6&q=${encodeURIComponent(term)}` : null);
  const full = useApi<any>(w.customer ? `/customers/${w.customer.id}` : null);
  const segs = useSegments();
  const [prefill, setPrefill] = useState<{ idDocument?: string; displayName?: string }>({});
  const { run, busy, error } = useAction();
  const create = async (body: Record<string, unknown>) => {
    const r = await run(() => post('/customers', { ...body, context: 'order' }));
    if (r) w.setCustomer({ id: r.customer.id, displayName: r.customer.displayName, segment: r.customer.segment, kycStatus: r.customer.kycStatus });
  };

  // A new customer who proved identity with MyDigital ID was created when it was confirmed; carry on with them.
  const confirmed = async (id: string) => {
    const c = await api<any>(`/customers/${id}`);
    w.setCustomer({ id, displayName: c.customer.displayName, segment: c.customer.segment, kycStatus: c.customer.kycStatus });
  };

  if (w.customer) {
    const accts: any[] = full.data?.accounts ?? [];
    return (
      <>
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div><p className="text-title3 font-semibold">{w.customer.displayName}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-subhead text-label2"><Badge>{segs.name(w.customer.segment ?? '')}</Badge>
                <Badge tone={(full.data?.customer.kycStatus ?? w.customer.kycStatus) === 'VERIFIED' ? 'success' : 'warning'}>{({ VERIFIED: 'KYC verified', PENDING_REVIEW: 'KYC in review', REJECTED: 'KYC not approved' } as Record<string, string>)[full.data?.customer.kycStatus ?? w.customer.kycStatus ?? ''] ?? 'KYC not verified'}</Badge>
                {full.data && <span>{full.data.serviceSummary.reduce((n: number, s: any) => n + (s.status !== 'TERMINATED' ? s.n : 0), 0)} services · {full.data.accountCount} accounts</span>}</p></div>
            <button className="text-subhead text-accent" onClick={() => { w.setCustomer(null); w.setAccountId(''); }}>Change</button>
          </div>
          {accts.length > 1 && <div className="mt-4"><Field label="Bill to account"><Select value={w.accountId} onChange={(e) => w.setAccountId(e.target.value)}><option value="">First active account</option>{accts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field></div>}
        </Card>
        <div className="mt-4"><KycCard embedded customerId={w.customer.id} context="order" onStatus={(st) => { if (st !== w.customer!.kycStatus) w.setCustomer({ ...w.customer!, kycStatus: st }); }} /></div>
        {w.quote?.problems?.length > 0 && <div className="mt-4 space-y-2">{w.quote.problems.map((p: string) => <Alert key={p}>{p}</Alert>)}</div>}
      </>
    );
  }
  return (
    <>
      {w.canCreateCustomer && <div className="mb-4"><Segmented label="Customer" value={mode} options={[{ value: 'existing', label: 'Existing customer' }, { value: 'new', label: 'New customer' }]} onChange={setMode} /></div>}
      {mode === 'existing' ? (
        <>
          <SearchField label="Find a customer" placeholder="ID number (NRIC, passport, UEN), mobile number, e-mail or name" value={q} onChange={setQ} />
          <p className="mt-2 text-footnote text-label2">An ID number finds exactly one person. Names and numbers search as you type.</p>
          {term.length >= 3 && list.loading && list.items.length === 0 && <div className="mt-4"><Spinner /></div>}
          {term.length >= 3 && !list.loading && list.items.length === 0 && (
            <div className="mt-4 rounded-card bg-surface px-4 py-6 text-center shadow-card"><p className="text-subhead text-label2">No customer matches “{term}”.</p>
              {w.canCreateCustomer && <Button className="mt-3" variant="secondary" onClick={() => { setMode('new'); setPrefill({ idDocument: /\d/.test(term) && !term.includes('@') ? term : '', displayName: /^[^\d@]+$/.test(term) ? term : '' }); }}>Create a new customer</Button>}</div>
          )}
          <ul className="mt-3 divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {list.items.map((c: any) => (
              <li key={c.id}><button type="button" onClick={() => w.setCustomer({ id: c.id, displayName: c.displayName, segment: c.segment, kycStatus: c.kycStatus })} className="flex min-h-[60px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface2 focus-visible:bg-surface2 focus-visible:outline-none">
                <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent/12 font-semibold text-accent">{c.displayName.trim()[0]?.toUpperCase()}</span>
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{c.displayName}</span><span className="block truncate text-footnote text-label2">{segs.name(c.segment)} · ID {c.idDocumentRef}{c.phone ? ` · ${c.phone}` : ''}</span></span>
                <Badge tone={c.kycStatus === 'VERIFIED' ? 'success' : c.kycStatus === 'REJECTED' ? 'danger' : 'warning'}>{c.kycStatus === 'VERIFIED' ? 'KYC ✓' : c.kycStatus === 'PENDING_REVIEW' ? 'KYC in review' : c.kycStatus === 'REJECTED' ? 'KYC rejected' : 'Not verified'}</Badge>
              </button></li>
            ))}
          </ul>
        </>
      ) : (
        <Card>
          <CustomerForm key={JSON.stringify(prefill)} initial={prefill} context="order" submitLabel="Create and continue" busy={busy} error={error} onSubmit={(b) => void create(b)} onConfirmed={(id) => void confirmed(id)} />
        </Card>
      )}
    </>
  );
}

// ───────────────────────── 6. delivery and installation ─────────────────────────
export function DeliveryStep({ w }: { w: Wizard }) {
  const needs = w.quote?.needs ?? {};
  const min = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
  return (
    <div className="space-y-5">
      {needs.delivery && (
        <Card className="space-y-4">
          {w.deliveryMethods.length > 1 && (
            <Field label="How will the customer get it?">
              <Segmented label="Delivery method" value={w.method ?? 'SHIP'} options={[{ value: 'SHIP', label: 'Deliver to an address' }, { value: 'COLLECT', label: 'Collect in store' }]} onChange={(m) => w.setMethod(m as 'SHIP' | 'COLLECT')} />
            </Field>
          )}
          {w.method === 'COLLECT'
            ? <Field label="Collection store" hint="The customer picks it up here. The stock is held at this store, and the order can be cancelled until it is collected."><StorePicker value={w.pickupStore} onChange={w.setPickupStore} /></Field>
            : <Field label="Delivery address" hint="Where the device and any accessories are sent."><Input value={w.address} onChange={(e) => w.setAddress(e.target.value)} autoComplete="street-address" /></Field>}
        </Card>
      )}
      {needs.installation && (
        <Card>
          {!w.booking.enabled && <Field label="Preferred installation visit" hint={`Optional now: if left blank the installation is scheduled after the order.${w.quote.installationSlaDays ? ` Installations not completed within ${w.quote.installationSlaDays} days are cancelled and refunded.` : ''}`}>
            <Input type="datetime-local" min={min} value={w.slot} onChange={(e) => w.setSlot(e.target.value)} />
          </Field>}
          {(!needs.delivery || w.method === 'COLLECT') && <div className="mt-3"><Field label="Installation address"><Input value={w.address} onChange={(e) => w.setAddress(e.target.value)} /></Field></div>}
          {w.booking.enabled && <div className="mt-4"><InstallTimes w={w} /></div>}
          {w.fiber.enabled && <div className="mt-3"><FiberCoverageCheck address={w.address} speedMbps={w.fiber.speedMbps} lock={w.fiber.lock} onLock={w.fiber.setLock} api={fiberApi} /></div>}
        </Card>
      )}
      <div className="rounded-card bg-surface p-4 shadow-card">
        <p className="mb-2 text-subhead font-semibold">When you can still cancel</p>
        <Terms groups={w.quote?.groups ?? []} />
      </div>
    </div>
  );
}

const slotText = (s: { start: string; end: string }) => `${new Date(s.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}, ${s.start.slice(11, 16)}–${s.end.slice(11, 16)} UTC`;

/** Real installation windows for the address, from the field-service system: the customer picks one now and it is held while the order is taken. */
function InstallTimes({ w }: { w: Wizard }) {
  const addr = useDebounced(w.address.trim(), 600);
  const ready = addr.length >= 5 && !w.booking.later;
  const slots = useApi<{ slots: Array<{ id: string; start: string; end: string; capacityLeft: number | null }> }>(ready ? `/orders/installation-slots?address=${encodeURIComponent(addr)}` : null);
  const days = new Map<string, Array<{ id: string; start: string; end: string; capacityLeft: number | null }>>();
  for (const s of slots.data?.slots ?? []) days.set(s.start.slice(0, 10), [...(days.get(s.start.slice(0, 10)) ?? []), s]);
  return (
    <div className="space-y-3">
      <p className="text-subhead font-semibold">Installation time</p>
      {w.booking.later
        ? <p className="text-subhead text-label2">The time will be arranged after the order. <button type="button" className="text-accent" onClick={() => w.booking.setLater(false)}>Choose a time now</button></p>
        : <>
          {addr.length < 5 && <p className="text-subhead text-label2">Enter the installation address to see the times a technician can come.</p>}
          {ready && !slots.data && !slots.error && <Spinner />}
          {slots.error && <Alert>{slots.error}</Alert>}
          {slots.data && days.size === 0 && <p className="text-subhead text-label2">No technician is free in the next two weeks at this address.</p>}
          {[...days.entries()].slice(0, 10).map(([d, list]) => (
            <div key={d}>
              <p className="mb-1 text-footnote font-medium text-label2">{new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}</p>
              <div className="flex flex-wrap gap-2">{list.map((s) => {
                const on = w.booking.slot?.id === s.id;
                return <button key={s.id} type="button" aria-pressed={on} onClick={() => w.booking.setSlot(on ? null : { id: s.id, start: s.start, end: s.end })} className={`rounded-control border px-3 py-2 text-footnote ${on ? 'border-accent bg-accent/10 font-semibold' : 'border-separator bg-surface hover:border-accent'}`}>{s.start.slice(11, 16)}–{s.end.slice(11, 16)} UTC</button>;
              })}</div>
            </div>))}
          {w.booking.slot && <p className="text-footnote text-label2">Held for {slotText(w.booking.slot)}. It is booked once the order is paid, and can be moved later from the installation case.</p>}
          <button type="button" className="text-footnote text-accent" onClick={() => { w.booking.setSlot(null); w.booking.setLater(true); }}>Arrange the time after the order instead</button>
        </>}
    </div>
  );
}

/** Changing their mind: one block per part of the order, with a short point for each moment (before, during, after), in the order they happen. */
function Terms({ groups }: { groups: Array<{ group: string; title: string; points: Array<{ when: string; what: string }> }> }) {
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g.group} aria-label={g.title}>
          <h4 className="text-subhead font-semibold">{g.title}</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-subhead text-label2 marker:text-label3">
            {g.points.map((p, i) => <li key={i}><span className="text-label">{p.when}:</span> {p.what}.</li>)}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ───────────────────────── 7. review ─────────────────────────
export function ReviewStep({ w }: { w: Wizard }) {
  const segs = useSegments();
  const q = w.quote;
  const flat = flatLines(w.items);
  if (!q) return <Spinner />;
  return (
    <div className="space-y-5">
      {w.quoteError && <Alert>{w.quoteError}</Alert>}
      {q.problems.map((p: string) => <Alert key={p}>{p}</Alert>)}
      <FinancingPanel w={w} />
      <Card>
        <p className="text-footnote font-semibold uppercase tracking-wide text-label2">Customer</p>
        <p className="text-title3 font-semibold">{w.quick ? 'Walk-in sale' : w.customer?.displayName}</p>
        {!w.quick && w.customer && <p className="text-subhead text-label2">{segs.name(w.customer.segment ?? '')}{w.customer.kycStatus === 'VERIFIED' ? ' · KYC verified' : ''}</p>}
      </Card>
      {q.lines.map((l: any, i: number) => (
        <Card key={i}>
          <div className="flex items-start justify-between gap-3"><div><p className="text-title3 font-semibold">{l.name}{l.quantity > 1 ? ` × ${l.quantity}` : ''}</p><p className="text-subhead text-label2">{label(l.kind)}{l.variant ? ` · ${l.variant.colour}${l.variant.storage ? `, ${l.variant.storage}` : ''}` : ''}</p></div>
            <p className="text-right tabular-nums"><span className="block font-semibold">{money(l.priceMinor)}</span>{l.discountMinor > 0 && <span className="block text-footnote text-label2 line-through">{money(l.listMinor)}</span>}</p></div>
          {l.entitlements.length > 0 && (
            <div className="mt-3"><p className="mb-1 text-footnote font-semibold uppercase tracking-wide text-label2">Includes</p>
              <ul className="grid gap-1 text-subhead sm:grid-cols-2">{l.entitlements.map((e: any, k: number) => <li key={k} className="flex gap-2"><span aria-hidden className="text-success">✓</span><span>{e.unlimited ? 'Unlimited' : e.quantity && !['unit', 'SIM'].includes(e.unit ?? '') ? `${e.quantity.toLocaleString()} ${e.unit ?? ''}`.trim() : ''} {e.name}</span></li>)}</ul></div>
          )}
          <dl className="mt-3 border-t border-separator pt-2">
            {l.groupPlan && <Row k="Group plan" v={`You are the family head · up to ${l.groupPlan.maxMembers} member lines${l.groupPlan.sharedPoolQuotaGb ? ` · ${l.groupPlan.sharedPoolQuotaGb} GB shared` : ''}`} />}
            {l.memberOf !== undefined && <Row k="Member of" v={q.lines[l.memberOf]?.name ?? 'the group plan'} />}
            {l.needsSim && <Row k="SIM" v={flat[i]?.iccid ? flat[i]!.iccid! : flat[i]?.simType === 'ESIM' ? 'New eSIM' : flat[i]?.simType === 'PHYSICAL' ? 'Next free card' : 'Not chosen'} />}
            {l.portIn ? <Row k="Number" v={`${l.portIn.donorMsisdn} ported in from ${l.portIn.donorOperator} (operator ID ${l.portIn.mnpOperatorId})${l.portIn.temporaryNumber ? ', with a temporary number until the port is approved' : ': the line starts when the number arrives'}`} /> : l.needsSim && <Row k="Number" v={flat[i]?.msisdn ? flat[i]!.msisdn! : 'Assigned from the pool'} />}
            {l.vip && <Row k={`${label(l.vip.tier)} number fee`} v={`${money(l.vip.feeMinor)} (included above)`} />}
            {l.monthlyFeeMinor > 0 && <Row k="Plan fee" v={`${money(l.monthlyFeeMinor)} / month`} />}
            <Row k="Contract" v={l.contractMonths ? `${l.contractMonths} months` : (q.lines.find((x: any) => x.deal?.attachTo === i) ? `${q.lines.find((x: any) => x.deal?.attachTo === i).deal.termMonths} months (with ${q.lines.find((x: any) => x.deal?.attachTo === i).name})` : 'No contract')} />
            {l.deal && <Row k="Contract price" v={`${money(l.deal.retailMinor)} retail − ${money(l.deal.subsidyMinor)} subsidy, with ${l.deal.planName}`} />}
            {l.discountMinor > 0 && <Row k="Bundle discount" v={`− ${money(l.discountMinor)}`} />}
            {l.payMode === 'INSTALLMENT' ? (<>
              <Row k="Device price" v={money(l.priceMinor)} />
              <Row k="Down payment today" v={money(l.downMinor)} />
              <Row k="Instalments" v={`${l.months} × ${money(l.instalmentMinor)} / month`} />
            </>) : <Row k="Upfront" v={money(l.paidNowMinor)} />}
            {l.contractMonths > 0 && (l.deal || l.etc) && <Row k="If cancelled early" v={l.deal || l.etc.method === 'SUBSIDY_AMORTISED' ? 'Early-termination charge for the unrecovered device subsidy' : `Early-termination charge of ${l.etc.percentOfRemaining ?? 0}% of the remaining fees`} />}
          </dl>
        </Card>
      ))}
      {q.bundles.length > 0 && <div className="rounded-card bg-success/10 p-4 text-subhead"><p className="font-semibold text-success">Bundle savings</p>{q.bundles.map((b: any, i: number) => <p key={i}>{b.name}: {money(b.discountMinor)} off {b.lineOffer}</p>)}</div>}
      {(w.address || w.slot || w.booking.slot || w.method === 'COLLECT') && (
        <Card><p className="text-footnote font-semibold uppercase tracking-wide text-label2">Delivery and installation</p>
          {w.method === 'COLLECT' && <p className="text-subhead">Collect in store: <span className="font-mono">{w.pickupStore}</span></p>}
          {w.method !== 'COLLECT' && w.address && <p className="text-subhead">{w.address}</p>}{w.booking.slot && <p className="text-subhead text-label2">Installation visit held for {slotText(w.booking.slot)}</p>}{w.booking.enabled && !w.booking.slot && <p className="text-subhead text-label2">Installation time to be arranged after the order</p>}{!w.booking.enabled && w.slot && <p className="text-subhead text-label2">Installation visit requested for {new Date(w.slot).toLocaleString()}</p>}</Card>
      )}
      <Card>
        <dl>
          <Row k="Due today" v={money(q.dueNowMinor)} strong />
          <Row k="Plan fees each month" v={money(q.monthlyPlanMinor)} />
          {q.monthlyInstalmentMinor > 0 && <Row k="Instalments each month" v={money(q.monthlyInstalmentMinor)} />}
          <Row k="Each month in total" v={money(q.monthlyTotalMinor)} strong />
          <Row k="Prices include" v={`${q.taxName} at ${q.taxBps / 100}%`} />
        </dl>
      </Card>
      {w.agreements.data && w.agreements.data.agreements.length > 0 && (
        <Card><AgreementSigner agreements={w.agreements.data.agreements} required={w.agreements.data.required} onChange={w.agreements.setSigned} who={w.portal ? 'you' : w.customer?.displayName ?? 'the customer'} /></Card>
      )}
      <Card>
        <p className="mb-2 text-subhead font-semibold">Changing their mind</p>
        <Terms groups={q.groups} />
        <label className="mt-4 flex min-h-tap items-start gap-3 text-body"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={w.consent} onChange={(e) => w.setConsent(e.target.checked)} />The customer has been told what they pay today and each month, the contract, and when the order can be cancelled.</label>
      </Card>
    </div>
  );
}

// ───────────────────────── 8. pay and submit ─────────────────────────
export function PayStep({ w }: { w: Wizard }) {
  const due = w.quote?.dueNowMinor ?? 0;
  const refLabel = w.pay.method === 'CASH' ? 'Receipt number' : w.pay.method === 'QR' ? 'QR transaction reference' : 'Card terminal approval code';
  return (
    <div className="space-y-5">
      <Card><p className="text-footnote text-label2">Due today</p><p className="text-large-title font-bold tabular-nums">{money(due)}</p>
        {w.quote?.monthlyTotalMinor > 0 && <p className="text-subhead text-label2">then {money(w.quote.monthlyTotalMinor)} each month</p>}</Card>
      {due === 0 ? <Alert tone="info">Nothing is due today, so there is no payment to take. Submit the order to place it.</Alert> : (
        <Card className="space-y-4">
          <Field label="Payment method"><Segmented label="Payment method" value={w.pay.method} options={['CASH', 'CREDIT_CARD', 'QR'].map((m) => ({ value: m, label: label(m) }))} onChange={(m) => w.setPay({ ...w.pay, method: m })} /></Field>
          {w.cashier && (<>
            <label className="flex min-h-tap items-center gap-3 text-body"><input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={w.pay.received} onChange={(e) => w.setPay({ ...w.pay, received: e.target.checked })} />Payment received now</label>
            {w.pay.received && <Field label={refLabel} hint={w.manual ? 'Required: this is the audit evidence for the payment.' : undefined}><Input value={w.pay.reference} onChange={(e) => w.setPay({ ...w.pay, reference: e.target.value })} /></Field>}
            {!w.pay.received && <p className="text-footnote text-label2">The order will wait for payment confirmation.</p>}
          </>)}
          {w.portal && <p className="text-footnote text-label2">After you place the order you will be sent to pay. It is released as soon as your payment is confirmed.</p>}
        </Card>
      )}
    </div>
  );
}
