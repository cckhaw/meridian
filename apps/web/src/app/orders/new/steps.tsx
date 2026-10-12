'use client';
import { Alert, Badge, Button, Card, Field, Input, LoadMore, SearchField, Segmented, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi, useDebounced, usePaged } from '@/lib/api';
import { label, money, step as moneyStep } from '@/lib/format';
import { Row, Section } from './wizard-ui';
import { DEVICE_KINDS, MONTHS, PRODUCT_KINDS, SWATCH, financeable, newItem, type Cust, type Item } from './wizard-types';

/** Everything the steps share. The shell owns it so going back and forward never loses a choice. */
export interface Wizard {
  channel: string; channels: string[]; setChannel: (c: string) => void;
  store: string; setStore: (s: string) => void; storeOptions: string[]; dealer: string; setDealer: (s: string) => void;
  quick: boolean; retail: boolean; portal: boolean; cashier: boolean; manual: boolean; marketCode: string; fixedStore?: string | null; fixedDealer?: string | null;
  items: Item[]; setItems: (f: (cur: Item[]) => Item[]) => void;
  quote: any | null; quoting: boolean; quoteError: string | null;
  customer: Cust | null; setCustomer: (c: Cust | null) => void; accountId: string; setAccountId: (id: string) => void; canCreateCustomer: boolean;
  address: string; setAddress: (s: string) => void; slot: string; setSlot: (s: string) => void;
  pay: { method: string; reference: string; received: boolean }; setPay: (p: { method: string; reference: string; received: boolean }) => void;
  consent: boolean; setConsent: (b: boolean) => void;
  jumpTo: (id: string, opts?: { kind?: string }) => void; kindHint: string | null; clearKindHint: () => void;
  can: (...p: string[]) => boolean;
}

const priceLine = (o: any) => {
  const rec = o.prices?.find((p: any) => p.type === 'RECURRING'), once = o.prices?.find((p: any) => p.type === 'ONE_TIME');
  return [rec && `${money(rec.amount.amountMinor, rec.amount.currency)}/mo`, once && (once.amount.amountMinor ? `${money(once.amount.amountMinor, once.amount.currency)} upfront` : 'nothing upfront')].filter(Boolean).join(' · ') || 'Free';
};

function OfferCard({ o, chosen, onToggle, note }: { o: any; chosen: boolean; onToggle: () => void; note?: string }) {
  return (
    <button type="button" onClick={onToggle} aria-pressed={chosen}
      className={`relative rounded-card border p-4 text-left shadow-card transition active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${chosen ? 'border-accent bg-accent/5' : 'border-transparent bg-surface hover:-translate-y-0.5'}`}>
      <div className="flex items-start justify-between gap-2"><span className="font-medium">{o.name}</span><Badge>{label(o.kind)}</Badge></div>
      {o.description && <p className="mt-1 line-clamp-2 text-footnote text-label2">{o.description}</p>}
      <p className="mt-2 text-subhead font-medium">{priceLine(o)}</p>
      <p className="text-footnote text-label2">{o.contract?.termMonths > 0 ? `${o.contract.termMonths}-month contract` : o.kind === 'PHYSICAL_GOOD' ? 'Outright purchase' : 'No contract'}{o.variants?.length ? ` · ${new Set(o.variants.map((v: any) => v.colour)).size} colours` : ''}</p>
      {note && <p className="mt-1 text-footnote text-accent">{note}</p>}
      {chosen && <span aria-hidden className="absolute bottom-3 right-3 grid h-6 w-6 place-items-center rounded-full bg-accent text-caption text-accent-fg">✓</span>}
    </button>
  );
}

function OfferPicker({ w, kind, placeholder, noteFor }: { w: Wizard; kind: string; placeholder: string; noteFor?: (o: any) => string | undefined }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const list = usePaged<any>(`/catalog?limit=24&status=ACTIVE&market=${w.marketCode}&kind=${kind}&q=${encodeURIComponent(term)}`);
  const toggle = (o: any) => w.setItems((cur) => (cur.some((i) => i.offer.id === o.id) ? cur.filter((i) => i.offer.id !== o.id) : [...cur, newItem(o)]));
  return (
    <>
      <SearchField label={placeholder} placeholder={placeholder} value={q} onChange={setQ} className="mb-3 sm:max-w-md" />
      {list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && <Alert tone="info">{term ? 'Nothing matches.' : 'No sellable offers here yet.'}{w.can('catalog:write') ? ' Create and activate offers in the catalog.' : ''}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        {list.items.map((o) => <OfferCard key={o.id} o={o} chosen={w.items.some((i) => i.offer.id === o.id)} onToggle={() => toggle(o)} note={noteFor?.(o)} />)}
      </div>
      {list.items.length > 0 && <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="offers" />}
    </>
  );
}

// ───────────────────────── 1. product ─────────────────────────
export function ProductStep({ w }: { w: Wizard }) {
  return (
    <>
      {(w.channels.length > 1 || w.retail || w.channel === 'DEALER') && (
        <Card className="mb-5"><div className="grid gap-4 sm:grid-cols-2">
          {w.channels.length > 1 && <Field label="Selling through"><Select value={w.channel} onChange={(e) => w.setChannel(e.target.value)}>{w.channels.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>}
          {w.retail && (w.fixedStore ? <Field label="Store"><Input readOnly value={w.fixedStore} /></Field> : <Field label="Store"><Select value={w.store} onChange={(e) => w.setStore(e.target.value)}><option value="">Choose a store…</option>{w.storeOptions.map((s) => <option key={s}>{s}</option>)}</Select></Field>)}
          {w.channel === 'DEALER' && (w.fixedDealer ? <Field label="Dealer"><Input readOnly value={w.fixedDealer} /></Field> : <Field label="Dealer ID"><Input value={w.dealer} onChange={(e) => w.setDealer(e.target.value)} /></Field>)}
        </div></Card>
      )}
      {w.kindHint && <p className="mb-3 text-subhead text-label2">Showing {label(w.kindHint.split(',')[0]!).toLowerCase()} only · <button className="text-accent" onClick={w.clearKindHint}>Show everything</button></p>}
      <OfferPicker w={w} kind={w.quick ? 'PHYSICAL_GOOD' : w.kindHint ?? PRODUCT_KINDS} placeholder={w.quick ? 'Search goods' : 'Search plans and products'} noteFor={(o) => (o.fulfilment?.requiresInstallation ? 'Needs an installation visit' : undefined)} />
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
                  <span className="block text-footnote text-label2">{!v ? `Not offered in ${cur.colour}` : `${v.priceDeltaMinor ? `+${money(v.priceDeltaMinor)}` : 'Included'}${s === 0 ? ' · out of stock' : s !== undefined && s <= 5 ? ` · only ${s} left` : ''}`}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}
    </Card>
  );
}

export function DeviceStep({ w }: { w: Wizard }) {
  const withVariants = w.items.filter((i) => i.offer.variants?.length);
  return (
    <>
      {withVariants.map((i) => <VariantPicker key={i.key} w={w} item={i} />)}
      {withVariants.length === 0 && <p className="mb-4 rounded-card bg-surface px-4 py-5 text-subhead text-label2 shadow-card">The plans you chose do not come with a device. You can add one below, or continue.</p>}
      <Section title="Add a device or accessory"><OfferPicker w={w} kind={DEVICE_KINDS} placeholder="Search devices" /></Section>
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
          {missing[0].startsWith('kind:') && <Button variant="secondary" className="shrink-0 !min-h-[36px] !px-3 !text-subhead" onClick={() => w.jumpTo('product', { kind: missing[0].slice(5) })}>Choose</Button>}
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
          const l = lines[idx];
          const can = financeable(it.offer);
          const term = it.offer.contract?.termMonths || 36;
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
                      <Field label="Spread over" hint={it.offer.contract?.termMonths ? `No longer than the ${it.offer.contract.termMonths}-month contract.` : undefined}>
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
const SEGMENTS = [['CONSUMER', 'Consumer'], ['FAMILY', 'Family'], ['ENTERPRISE', 'Enterprise'], ['IOT_ENTERPRISE', 'IoT enterprise']];

export function CustomerStep({ w }: { w: Wizard }) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const list = usePaged<any>(term.length >= 3 ? `/customers?limit=6&q=${encodeURIComponent(term)}` : null);
  const full = useApi<any>(w.customer ? `/customers/${w.customer.id}` : null);
  const [f, setF] = useState({ segment: 'CONSUMER', displayName: '', idDocument: '', email: '', phone: '' });
  const { run, busy, error } = useAction();
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => post('/customers', { ...f, email: f.email || undefined, phone: f.phone || undefined, account: { billCycleDay: 1 } }));
    if (r) w.setCustomer({ id: r.customer.id, displayName: r.customer.displayName, segment: r.customer.segment, kycStatus: r.customer.kycStatus });
  };

  if (w.customer) {
    const accts: any[] = full.data?.accounts ?? [];
    return (
      <>
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div><p className="text-title3 font-semibold">{w.customer.displayName}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-subhead text-label2"><Badge>{label(w.customer.segment ?? '')}</Badge>
                <Badge tone={(full.data?.customer.kycStatus ?? w.customer.kycStatus) === 'VERIFIED' ? 'success' : 'warning'}>{(full.data?.customer.kycStatus ?? w.customer.kycStatus) === 'VERIFIED' ? 'KYC verified' : 'KYC not verified'}</Badge>
                {full.data && <span>{full.data.serviceSummary.reduce((n: number, s: any) => n + (s.status !== 'TERMINATED' ? s.n : 0), 0)} services · {full.data.accountCount} accounts</span>}</p></div>
            <button className="text-subhead text-accent" onClick={() => { w.setCustomer(null); w.setAccountId(''); }}>Change</button>
          </div>
          {accts.length > 1 && <div className="mt-4"><Field label="Bill to account"><Select value={w.accountId} onChange={(e) => w.setAccountId(e.target.value)}><option value="">First active account</option>{accts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field></div>}
        </Card>
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
              {w.canCreateCustomer && <Button className="mt-3" variant="secondary" onClick={() => { setMode('new'); setF({ ...f, idDocument: /\d/.test(term) && !term.includes('@') ? term : '', displayName: /^[^\d@]+$/.test(term) ? term : '' }); }}>Create a new customer</Button>}</div>
          )}
          <ul className="mt-3 divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {list.items.map((c: any) => (
              <li key={c.id}><button type="button" onClick={() => w.setCustomer({ id: c.id, displayName: c.displayName, segment: c.segment, kycStatus: c.kycStatus })} className="flex min-h-[60px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface2 focus-visible:bg-surface2 focus-visible:outline-none">
                <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent/12 font-semibold text-accent">{c.displayName.trim()[0]?.toUpperCase()}</span>
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{c.displayName}</span><span className="block truncate text-footnote text-label2">{label(c.segment)} · ID {c.idDocumentRef}{c.phone ? ` · ${c.phone}` : ''}</span></span>
                <Badge tone={c.kycStatus === 'VERIFIED' ? 'success' : 'warning'}>{c.kycStatus === 'VERIFIED' ? 'KYC ✓' : 'KYC pending'}</Badge>
              </button></li>
            ))}
          </ul>
        </>
      ) : (
        <Card>
          <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
            <Field label="Segment"><Select value={f.segment} onChange={set('segment')}>{SEGMENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
            <Field label="Full name / company"><Input required value={f.displayName} onChange={set('displayName')} /></Field>
            <Field label="ID document number" hint="NRIC, passport or UEN. Stored masked; used to spot duplicates."><Input required minLength={3} value={f.idDocument} onChange={set('idDocument')} /></Field>
            <Field label="Mobile number"><Input type="tel" value={f.phone} onChange={set('phone')} /></Field>
            <Field label="E-mail"><Input type="email" value={f.email} onChange={set('email')} /></Field>
            {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
            <div className="sm:col-span-2"><Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create and continue'}</Button></div>
          </form>
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
        <Card><Field label="Delivery address" hint="Where the device and any accessories are sent."><Input value={w.address} onChange={(e) => w.setAddress(e.target.value)} autoComplete="street-address" /></Field></Card>
      )}
      {needs.installation && (
        <Card>
          <Field label="Preferred installation visit" hint={`Optional now: if left blank the installation is scheduled after the order.${w.quote.installationSlaDays ? ` Installations not completed within ${w.quote.installationSlaDays} days are cancelled and refunded.` : ''}`}>
            <Input type="datetime-local" min={min} value={w.slot} onChange={(e) => w.setSlot(e.target.value)} />
          </Field>
          {!needs.delivery && <div className="mt-3"><Field label="Installation address"><Input value={w.address} onChange={(e) => w.setAddress(e.target.value)} /></Field></div>}
        </Card>
      )}
      <div className="rounded-card bg-surface p-4 shadow-card">
        <p className="mb-2 text-subhead font-semibold">When you can still cancel</p>
        <ul className="space-y-2 text-subhead text-label2">{(w.quote?.groups ?? []).map((g: any) => <li key={g.group}><strong className="text-label">{g.title}.</strong> {g.text}</li>)}</ul>
      </div>
    </div>
  );
}

// ───────────────────────── 7. review ─────────────────────────
export function ReviewStep({ w }: { w: Wizard }) {
  const q = w.quote;
  if (!q) return <Spinner />;
  return (
    <div className="space-y-5">
      {w.quoteError && <Alert>{w.quoteError}</Alert>}
      {q.problems.map((p: string) => <Alert key={p}>{p}</Alert>)}
      <Card>
        <p className="text-footnote font-semibold uppercase tracking-wide text-label2">Customer</p>
        <p className="text-title3 font-semibold">{w.quick ? 'Walk-in sale' : w.customer?.displayName}</p>
        {!w.quick && w.customer && <p className="text-subhead text-label2">{label(w.customer.segment ?? '')}{w.customer.kycStatus === 'VERIFIED' ? ' · KYC verified' : ''}</p>}
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
            {l.monthlyFeeMinor > 0 && <Row k="Plan fee" v={`${money(l.monthlyFeeMinor)} / month`} />}
            <Row k="Contract" v={l.contractMonths ? `${l.contractMonths} months` : 'No contract'} />
            {l.discountMinor > 0 && <Row k="Bundle discount" v={`− ${money(l.discountMinor)}`} />}
            {l.payMode === 'INSTALLMENT' ? (<>
              <Row k="Device price" v={money(l.priceMinor)} />
              <Row k="Down payment today" v={money(l.downMinor)} />
              <Row k="Instalments" v={`${l.months} × ${money(l.instalmentMinor)} / month`} />
            </>) : <Row k="Upfront" v={money(l.paidNowMinor)} />}
            {l.etc && l.contractMonths > 0 && <Row k="If cancelled early" v={l.etc.method === 'SUBSIDY_AMORTISED' ? 'Early-termination charge for the unrecovered device subsidy' : `Early-termination charge of ${l.etc.percentOfRemaining ?? 0}% of the remaining fees`} />}
          </dl>
        </Card>
      ))}
      {q.bundles.length > 0 && <div className="rounded-card bg-success/10 p-4 text-subhead"><p className="font-semibold text-success">Bundle savings</p>{q.bundles.map((b: any, i: number) => <p key={i}>{b.name}: {money(b.discountMinor)} off {b.lineOffer}</p>)}</div>}
      {(w.address || w.slot) && (
        <Card><p className="text-footnote font-semibold uppercase tracking-wide text-label2">Delivery and installation</p>
          {w.address && <p className="text-subhead">{w.address}</p>}{w.slot && <p className="text-subhead text-label2">Installation visit requested for {new Date(w.slot).toLocaleString()}</p>}</Card>
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
      <Card>
        <p className="mb-2 text-subhead font-semibold">Changing their mind</p>
        <ul className="space-y-2 text-subhead text-label2">{q.groups.map((g: any) => <li key={g.group}><strong className="text-label">{g.title}.</strong> {g.text}</li>)}</ul>
        <label className="mt-4 flex min-h-tap items-start gap-3 text-body"><input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={w.consent} onChange={(e) => w.setConsent(e.target.checked)} />The customer has been told what they pay today and each month, the contract, and when the order can be cancelled.</label>
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
            <label className="flex min-h-tap items-center gap-3 text-body"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={w.pay.received} onChange={(e) => w.setPay({ ...w.pay, received: e.target.checked })} />Payment received now</label>
            {w.pay.received && <Field label={refLabel} hint={w.manual ? 'Required: this is the audit evidence for the payment.' : undefined}><Input value={w.pay.reference} onChange={(e) => w.setPay({ ...w.pay, reference: e.target.value })} /></Field>}
            {!w.pay.received && <p className="text-footnote text-label2">The order will wait for payment confirmation.</p>}
          </>)}
          {w.portal && <p className="text-footnote text-label2">After you place the order you will be sent to pay. It is released as soon as your payment is confirmed.</p>}
        </Card>
      )}
    </div>
  );
}
