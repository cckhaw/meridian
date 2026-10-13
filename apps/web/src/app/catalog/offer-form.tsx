'use client';
import { behaviourOf, TEMPLATES, type OfferTemplate } from '@meridian/types';
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRegional } from '@/components/settings-provider';
import { patch, post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { label, step as moneyStep, toInput, toMinor } from '@/lib/format';
import { NodePicker, type Picked } from './node-picker';
import { slug } from './node-modals';

const CHANNELS = ['SELF_SERVE', 'RETAIL_ASSISTED', 'QUICK_SALE', 'TELESALES', 'DEALER', 'CALL_CENTER'];
const major = toInput;

interface FormState {
  parentId: string; id: string; name: string; kind: string; description: string; market: string; recurring: string; upfront: string; taxInclusive: boolean;
  term: string; etcMethod: string; etcPercent: string; waive: string; subsidy: string; retail: string; options: string[]; skus: string; trackSim: boolean; partner: string;
  requires: string[]; excludes: string[]; channels: string[]; status: string; activeFrom: string;
  variants: Array<{ colour: string; storage: string; sku: string; delta: string }>;
}

const blank = (market: string): FormState => ({
  parentId: '', id: '', name: '', kind: '', description: '', market, recurring: '', upfront: '', taxInclusive: true,
  term: '0', etcMethod: 'SUBSIDY_AMORTISED', etcPercent: '50', waive: '1', subsidy: '', retail: '', options: [], skus: '', trackSim: false, partner: '',
  requires: [], excludes: [], channels: [], status: 'DRAFT', activeFrom: '', variants: [],
});

/** Offers saved before fulfilment options existed carry only the flags; show them as the built-in options they correspond to. */
const optionsOf = (f: any): string[] => f?.options ?? [f?.requiresShipping && 'SHIP', f?.requiresCollection && 'COLLECT', f?.requiresInstallation && 'INSTALL', f?.requiresSimActivation && 'SIM'].filter(Boolean) as string[];

function fromOffer(o: any, market: string): FormState {
  const rec = o.prices?.find((p: any) => p.type === 'RECURRING'), once = o.prices?.find((p: any) => p.type === 'ONE_TIME');
  return {
    ...blank(o.markets?.[0] ?? market), parentId: o.parentId ?? '', id: o.id, name: o.name, kind: o.kind, description: o.description ?? '', status: o.status, activeFrom: o.activeFrom ? localDate(new Date(o.activeFrom)) : '',
    recurring: major(rec?.amount.amountMinor), upfront: major(once?.amount.amountMinor), taxInclusive: (rec ?? once)?.taxInclusive ?? true,
    term: String(o.contract?.termMonths ?? 0), etcMethod: o.contract?.etc?.method ?? 'SUBSIDY_AMORTISED', etcPercent: String(o.contract?.etc?.percentOfRemaining ?? 50), waive: String(o.contract?.etc?.waiveInLastMonths ?? 1),
    subsidy: major(o.contract?.subsidy?.subsidyAmount.amountMinor), retail: major(o.contract?.subsidy?.deviceRetailPrice.amountMinor),
    options: optionsOf(o.fulfilment), skus: (o.fulfilment?.inventorySkus ?? []).join(', '), trackSim: (o.fulfilment?.inventorySkus ?? []).length > 0,
    partner: o.partnerCode ?? '', requires: o.requires ?? [], excludes: o.excludes ?? [], channels: o.salesChannels ?? [],
    variants: (o.variants ?? []).map((v: any) => ({ colour: v.colour, storage: v.storage ?? '', sku: v.sku, delta: v.priceDeltaMinor ? major(v.priceDeltaMinor) : '' })),
  };
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return localDate(d); };
/** Goes live at the start of the chosen day, in the browser's time zone. */
const goLive = (day: string) => new Date(`${day}T00:00:00`).toISOString();

type StepId = 'basics' | 'pricing' | 'fulfilment' | 'stock' | 'availability' | 'rules' | 'review';
const TITLE: Record<StepId, string> = { basics: 'What is it?', pricing: 'Pricing', fulfilment: 'Fulfilment', stock: 'Stock', availability: 'Availability', rules: 'Rules', review: 'Review' };
const HINT: Record<StepId, string> = {
  basics: 'Where it sits in the catalog, what type of offer it is, and what customers will see it called.',
  pricing: 'What it costs and, if it is sold on contract, the terms.',
  fulfilment: 'How the customer gets it. This also decides when an order can still be cancelled.',
  stock: 'The stock that is reserved when it is sold, and the colours and storage a customer can choose.',
  availability: 'Which channels sell it and in which market.',
  rules: 'Optional: what the customer must already have, and what it cannot be bought with.',
  review: 'Check everything, choose whether it is sellable now, and save.',
};

/**
 * One guided flow for all three jobs: create an offer (`?parent=`), edit an existing one (pencil on the panel), or start a new version of a
 * sold offer (`?from=`), which prefills from the source with a fresh id. The steps adapt: what you choose decides what the next screens ask.
 */
export function OfferForm({ offerId, parentId, fromId }: { offerId?: string; parentId?: string | null; fromId?: string | null }) {
  const sourceId = offerId ?? fromId ?? null;
  const meta = useApi('/meta');
  const config = useApi<any>('/catalog-config');
  const src = useApi(sourceId ? `/catalog/${sourceId}/detail` : null);
  const parent = useApi(!sourceId && parentId ? `/catalog/${parentId}/detail` : null);
  if ((meta.loading && !meta.data) || (config.loading && !config.data) || (sourceId && src.loading && !src.data) || (parent.loading && !parent.data)) return <Spinner />;
  if (meta.error || config.error || src.error || parent.error) return <Alert>{meta.error ?? config.error ?? src.error ?? parent.error}</Alert>;
  const d = src.data;
  // Names for what the form refers to by id (the group it sits in, the offers it depends on), so nothing has to be looked up from a full tree.
  const names: Record<string, string> = {};
  for (const t of [...(d?.trail ?? []), ...(parent.data?.trail ?? [])]) names[t.id] = t.name;
  if (parent.data) names[parent.data.node.id] = parent.data.node.name;
  for (const r of [...(d?.requires ?? []), ...(d?.excludes ?? [])]) names[r.id] = 'name' in r ? (r.level === 'OFFER' ? r.name : `Any ${r.name}`) : `${r.id} (missing)`;
  const where = (d?.trail ?? parent.data?.trail ?? []).concat(parent.data ? [parent.data.node] : []).map((t: any) => t.name).join(' › ');
  return <Inner key={sourceId ?? 'new'} offerId={offerId} parentId={parentId ?? null} fromId={fromId ?? null} source={d?.node} names={names} where={where} markets={meta.data?.markets ?? {}} config={config.data} sold={(d?.usage?.services ?? 0) + (d?.usage?.orders ?? 0)} />;
}

function Inner({ offerId, parentId, fromId, source, names: initialNames, where: initialWhere, markets, config, sold }: { offerId?: string; parentId: string | null; fromId: string | null; source: any; names: Record<string, string>; where: string; markets: Record<string, any>; config: { types: any[]; options: any[] }; sold: number }) {
  const { me } = useAuth();
  const router = useRouter();
  const regional = useRegional();
  const editing = !!offerId;
  const locked = editing && sold > 0; // price, contract and type of a sold offer are immutable: new version instead
  const defaultMarket = markets[regional.country] ? regional.country : me?.marketCode ?? 'SG';
  const [f, setF] = useState<FormState>(() => {
    if (source) { const s = fromOffer(source, defaultMarket); return fromId ? { ...s, id: `${source.id}-v2`, status: 'DRAFT' } : s; }
    return { ...blank(defaultMarket), parentId: parentId ?? '' };
  });
  const { run, busy, error } = useAction();
  const createdId = useRef('');
  const touchedOptions = useRef(editing || !!fromId);
  const [names, setNames] = useState(initialNames);
  const [where, setWhere] = useState(initialWhere);
  const [choosing, setChoosing] = useState(!f.parentId);
  const [index, setIndex] = useState(0);
  const dir = useRef<'fwd' | 'back'>('fwd');
  const remember = (n: Picked) => setNames((m) => ({ ...m, [n.id]: n.level === 'OFFER' ? n.name : `Any ${n.name}` }));
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  // ── what the chosen type and options mean ──
  const types: any[] = config.types.some((t) => t.id === f.kind) || !f.kind ? config.types : [...config.types, { id: f.kind, name: label(f.kind), description: null, template: source?.template ?? f.kind }];
  const type = types.find((t) => t.id === f.kind);
  const b = type ? TEMPLATES[type.template as OfferTemplate] ?? behaviourOf({ kind: f.kind }) : null;
  const options: any[] = config.options;
  const option = (id: string) => options.find((o) => o.id === id);
  const chosenOptions = f.options.map(option).filter(Boolean);
  const has = (m: string) => chosenOptions.some((o: any) => o.mechanic === m);
  // Goods always reserve stock; for a plan the operator chooses whether the SIM card it ships is counted.
  const canTrack = chosenOptions.some((o: any) => o.tracksStock);
  const tracksStock = canTrack && (!!b?.goods || f.trackSim);
  const hasDevice = !!b?.goods && (has('SHIP') || has('COLLECT'));

  const currency = regional.currency;
  const taxLabel = `${regional.taxName} (${regional.taxBps / 100}%)`;
  const money = (v: string) => ({ amountMinor: toMinor(v), currency });
  const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

  // Choosing a type suggests the usual fulfilment for it, until the person changes the options themselves.
  const pickType = (t: any) => {
    const tpl = TEMPLATES[t.template as OfferTemplate];
    const suggested = touchedOptions.current ? f.options : tpl.defaults.map((m) => options.find((o) => o.mechanic === m && o.status === 'ACTIVE')?.id).filter(Boolean) as string[];
    setF({ ...f, kind: t.id, options: suggested, term: tpl.contract === 'none' ? '0' : f.term, partner: tpl.needsPartner ? f.partner : '' });
  };

  const steps = useMemo<StepId[]>(() => {
    const s: StepId[] = ['basics', 'pricing'];
    if (b && b.role !== 'ADDON') s.push('fulfilment');
    if (b && b.role !== 'ADDON' && tracksStock) s.push('stock');
    s.push('availability', 'rules', 'review');
    return s;
  }, [b, tracksStock]);
  const at = Math.min(index, steps.length - 1);
  const stepId = steps[at]!;

  const prices = [
    ...(f.recurring && b?.role !== 'GOODS' ? [{ type: 'RECURRING', amount: money(f.recurring), periodMonths: 1, taxInclusive: f.taxInclusive }] : []),
    ...(f.upfront ? [{ type: 'ONE_TIME', amount: money(f.upfront), taxInclusive: f.taxInclusive }] : []),
  ];
  const term = Number(f.term);
  const etcMethod = b?.goods ? f.etcMethod : 'REMAINING_RECURRING_PERCENT'; // a subsidy only exists where there is a device
  const contract = term === 0 || b?.contract === 'none' ? { termMonths: 0 } : {
    termMonths: term,
    etc: { method: etcMethod, ...(etcMethod === 'REMAINING_RECURRING_PERCENT' ? { percentOfRemaining: Number(f.etcPercent) } : {}), waiveInLastMonths: Number(f.waive) },
    ...(etcMethod === 'SUBSIDY_AMORTISED' ? { subsidy: { subsidyAmount: money(f.subsidy || '0'), deviceRetailPrice: money(f.retail || '0') } } : {}),
  };
  const fulfilment = { options: f.options, inventorySkus: tracksStock ? csv(f.skus) : [] };
  const common = { name: f.name.trim(), description: f.description || undefined, fulfilment, partnerCode: b?.needsPartner ? f.partner || undefined : undefined, requires: f.requires, excludes: f.excludes, salesChannels: f.channels,
    variants: hasDevice && tracksStock ? f.variants.filter((v) => v.colour.trim() && v.sku.trim()).map((v) => ({ id: slug(`${v.colour}-${v.storage}`) || slug(v.sku), colour: v.colour.trim(), storage: v.storage.trim() || undefined, sku: v.sku.trim(), priceDeltaMinor: v.delta ? toMinor(v.delta) : undefined })) : [] };

  // What stops the person moving on from this step, in words.
  const blocked: string | null = (() => {
    switch (stepId) {
      case 'basics': return !f.parentId ? 'Choose the group it belongs to.' : !f.kind ? 'Choose the type of offer.' : !f.name.trim() ? 'Give it a display name.' : null;
      case 'pricing': return prices.length === 0 ? (b?.role === 'GOODS' ? 'Enter the price.' : 'Enter a monthly fee or an upfront price.') : null;
      case 'fulfilment': return b?.goods && !has('SHIP') && !has('COLLECT') ? 'Choose how the customer gets the goods: delivery or collect in store.' : b?.needsInstallation && !has('INSTALL') ? 'Fibre needs an installation option.' : null;
      case 'review': return f.status === 'SCHEDULED' && (!f.activeFrom || f.activeFrom < tomorrow()) ? 'Choose a go-live date after today.' : null;
      case 'availability': return b?.needsPartner && !f.partner.trim() ? 'Enter the partner code.' : null;
      default: return null;
    }
  })();

  const go = (i: number) => { dir.current = i >= at ? 'fwd' : 'back'; setIndex(Math.max(0, Math.min(i, steps.length - 1))); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  useEffect(() => { if (index > steps.length - 1) setIndex(steps.length - 1); }, [steps.length, index]);

  const submit = async () => {
    const ok = await run(async () => {
      if (editing) {
        await patch(`/catalog/${offerId}`, { ...common, markets: [f.market], ...(locked ? {} : { kind: f.kind, prices, contract }), ...(f.status !== source.status || (f.status === 'SCHEDULED' && f.activeFrom !== (source.activeFrom ? localDate(new Date(source.activeFrom)) : '')) ? { status: f.status, ...(f.status === 'SCHEDULED' ? { activeFrom: goLive(f.activeFrom) } : {}) } : {}) });
        if (f.parentId && f.parentId !== source.parentId) await post(`/catalog/${offerId}/move`, { parentId: f.parentId });
      } else {
        const node = await post('/catalog', { level: 'OFFER', id: f.id || slug(f.name), parentId: f.parentId, markets: [f.market], kind: f.kind, prices, contract, characteristics: {}, ...common, status: 'DRAFT' });
        createdId.current = node.id;
        if (fromId) await post(`/catalog/${node.id}/line-items/copy-from`, { fromId }); // a new version keeps what the old one included
        if (f.status === 'ACTIVE') await patch(`/catalog/${node.id}`, { status: 'ACTIVE' });
        if (f.status === 'SCHEDULED') await patch(`/catalog/${node.id}`, { status: 'SCHEDULED', activeFrom: goLive(f.activeFrom) });
      }
      return true;
    });
    if (ok) router.push(`/catalog?node=${encodeURIComponent(editing ? offerId! : createdId.current || f.parentId)}`);
  };

  const chosen = new Set([...f.requires, ...f.excludes, offerId ?? '']);
  const upfrontLabel = b?.role === 'GOODS' ? 'Price' : b?.goods ? 'Device price today' : b?.needsInstallation ? 'Installation fee' : b?.role === 'ADDON' ? 'Activation fee' : 'Upfront price';
  const L = locked;

  return (
    <>
      {fromId && <div className="mb-4"><Alert tone="info">New version of <strong>{fromId}</strong>: change what you need, create it, then retire the old offer. Existing services keep the price they were sold at.</Alert></div>}
      {locked && (
        <div className="mb-4"><Alert tone="info">
          This offer has {sold} sold subscription/order line{sold === 1 ? '' : 's'}, so its price, contract and type are fixed. You can still change everything else.{' '}
          <Link href={`/catalog/manage?from=${offerId}`} className="font-medium underline">Create a new version</Link> to change pricing.
        </Alert></div>
      )}

      <Steps steps={steps} index={at} onGo={go} canJump={editing} />
      <section key={stepId} aria-labelledby="offer-step-title" className={dir.current === 'fwd' ? 'push-fwd' : 'push-back'}>
        <h2 id="offer-step-title" tabIndex={-1} className="text-title1 font-bold tracking-tight outline-none">{TITLE[stepId]}</h2>
        <p className="mb-5 mt-1 text-body text-label2">{HINT[stepId]}</p>

        {stepId === 'basics' && (
          <div className="space-y-5">
            <Card>
              <Field label="Group" hint="Where the offer sits in the hierarchy.">
                {f.parentId && !choosing
                  ? <div className="flex min-h-tap items-center justify-between gap-3 rounded-control bg-surface2 px-3"><span className="truncate">{where || names[f.parentId] || f.parentId}</span><button type="button" className="shrink-0 text-subhead text-accent" onClick={() => setChoosing(true)}>Change</button></div>
                  : <NodePicker levels={['GROUP']} placeholder="Search groups…" onPick={(n) => { setF({ ...f, parentId: n.id }); setWhere([...(n.trail ?? []).map((t) => t.name), n.name].join(' › ')); setChoosing(false); }} />}
              </Field>
            </Card>
            <fieldset>
              <legend className="mb-2 px-1 text-subhead font-medium">Type of offer</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {types.map((t) => {
                  const on = f.kind === t.id;
                  return (
                    <label key={t.id} className={`relative flex cursor-pointer flex-col gap-1 rounded-card border p-4 focus-within:ring-2 focus-within:ring-accent ${on ? 'border-accent bg-accent/8 ring-2 ring-accent' : 'border-separator bg-surface'} ${L ? 'cursor-not-allowed opacity-60' : ''}`}>
                      <input type="radio" name="kind" value={t.id} checked={on} disabled={L} onChange={() => pickType(t)} className="sr-only" />
                      <span className="font-semibold">{t.name}</span>
                      <span className="text-footnote text-label2">{t.description || TEMPLATES[t.template as OfferTemplate]?.summary}</span>
                    </label>
                  );
                })}
              </div>
              {b && <p className="mt-2 px-1 text-footnote text-label2">{b.summary}</p>}
            </fieldset>
            <Card className="grid gap-4 sm:grid-cols-2">
              <Field label="Display name"><Input required value={f.name} onChange={set('name')} maxLength={100} /></Field>
              <Field label="ID" hint={editing ? 'Cannot be changed once created.' : 'Lowercase letters, digits and dashes. Leave blank to derive from the name.'}>
                <Input value={f.id} onChange={set('id')} disabled={editing} pattern="[a-z0-9][a-z0-9\-]*" placeholder={slug(f.name)} />
              </Field>
              <div className="sm:col-span-2"><Field label="Description" hint="Shown to customers in the store-front."><Input value={f.description} onChange={set('description')} maxLength={500} /></Field></div>
            </Card>
          </div>
        )}

        {stepId === 'pricing' && b && (
          <div className="space-y-5">
            <Card className="grid gap-4 sm:grid-cols-2">
              {b.role !== 'GOODS' && <Field label={`Monthly fee (${currency})`} hint="Leave empty if there is no monthly charge."><Input type="number" min="0" step={moneyStep()} value={f.recurring} onChange={set('recurring')} disabled={L} /></Field>}
              <Field label={`${upfrontLabel} (${currency})`} hint={b.goods && b.role !== 'GOODS' ? 'Paid at the start, in full or by instalments' : undefined}><Input type="number" min="0" step={moneyStep()} value={f.upfront} onChange={set('upfront')} disabled={L} /></Field>
              <label className="flex min-h-tap items-center gap-3 text-body sm:col-span-2"><input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={f.taxInclusive} onChange={(e) => setF({ ...f, taxInclusive: e.target.checked })} disabled={L} />Prices include {taxLabel}</label>
              <p className="text-footnote text-label2 sm:col-span-2">Currency and tax come from Settings → Regional ({currency}, {regional.taxName} {regional.taxBps / 100}%).</p>
            </Card>
            {b.contract !== 'none' && (
              <Card className="grid gap-4 sm:grid-cols-2">
                <Field label="Contract term"><Select value={f.term} onChange={set('term')} disabled={L}>{[0, 12, 24, 36].map((t) => <option key={t} value={t}>{t === 0 ? 'No contract' : `${t} months`}</option>)}</Select></Field>
                {term > 0 && (
                  <>
                    <Field label="Early termination charge"><Select value={etcMethod} onChange={set('etcMethod')} disabled={L}><option value="SUBSIDY_AMORTISED" disabled={!b.goods}>Remaining device subsidy</option><option value="REMAINING_RECURRING_PERCENT">% of remaining monthly fees</option></Select></Field>
                    {etcMethod === 'REMAINING_RECURRING_PERCENT'
                      ? <Field label="% of remaining fees"><Input type="number" min="0" max="100" value={f.etcPercent} onChange={set('etcPercent')} disabled={L} /></Field>
                      : <><Field label={`Subsidy (${currency})`} hint="What you fund; recovered if the customer leaves early"><Input type="number" min="0" step={moneyStep()} value={f.subsidy} onChange={set('subsidy')} disabled={L} /></Field><Field label={`Device retail price (${currency})`}><Input type="number" min="0" step={moneyStep()} value={f.retail} onChange={set('retail')} disabled={L} /></Field></>}
                    <Field label="Waive charge in last N months"><Input type="number" min="0" max="12" value={f.waive} onChange={set('waive')} disabled={L} /></Field>
                  </>
                )}
              </Card>
            )}
          </div>
        )}

        {stepId === 'fulfilment' && b && (
          <div className="space-y-4">
            <ul className="space-y-2">
              {options.map((o) => {
                const on = f.options.includes(o.id);
                const must = !!b.needsInstallation && o.mechanic === 'INSTALL';
                return (
                  <li key={o.id}>
                    <label className={`flex min-h-tap cursor-pointer items-start gap-3 rounded-card border p-4 ${on ? 'border-accent bg-accent/8' : 'border-separator bg-surface'}`}>
                      <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={on} disabled={must}
                        onChange={(e) => { touchedOptions.current = true; setF({ ...f, options: e.target.checked ? [...f.options, o.id] : f.options.filter((x) => x !== o.id) }); }} />
                      <span><span className="font-medium">{o.name}</span>{must && <Badge>Required</Badge>}<span className="block text-footnote text-label2">{o.description}</span>
                        <span className="block text-footnote text-label2">{o.tracksStock ? 'Stock is reserved when it is sold.' : 'No stock to reserve.'}</span></span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {canTrack && !b.goods && (
              <label className="flex min-h-tap cursor-pointer items-start gap-3 rounded-card border border-separator bg-surface p-4">
                <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={f.trackSim} onChange={(e) => setF({ ...f, trackSim: e.target.checked })} />
                <span><span className="font-medium">Count SIM cards in stock</span><span className="block text-footnote text-label2">Leave off if you do not track SIM card inventory; no stock is reserved and no SKU is asked for.</span></span>
              </label>
            )}
            {has('SHIP') && has('COLLECT') && <Alert tone="info">Both are chosen, so the customer picks delivery or collection when they order.</Alert>}
            {has('COLLECT') && !has('SHIP') && <Alert tone="info">Collect-only: customers choose a store to collect from. It is sold in store and through staff channels, not in the online shop.</Alert>}
            {options.length > 0 && <p className="px-1 text-footnote text-label2">Manage this list in Settings → Catalog → Fulfilment options.</p>}
          </div>
        )}

        {stepId === 'stock' && (
          <div className="space-y-5">
            <Card>
              <Field label="Stock SKUs" hint="Comma-separated; one unit of each is reserved per item sold. A SKU that is also a colour or storage option below is replaced by the one chosen."><Input value={f.skus} onChange={set('skus')} /></Field>
            </Card>
            {hasDevice && (
              <fieldset>
                <legend className="mb-1 px-1 text-subhead font-medium">Colours and storage</legend>
                <p className="mb-2 px-1 text-footnote text-label2">What the customer picks when buying the device. Each option has its own stock SKU and may cost more or less than the base price.</p>
                <div className="space-y-2">
                  {f.variants.map((v, i) => {
                    const upd = (p: Partial<FormState['variants'][number]>) => setF({ ...f, variants: f.variants.map((x, k) => (k === i ? { ...x, ...p } : x)) });
                    return (
                      <div key={i} className="grid grid-cols-2 gap-2 rounded-control bg-surface2 p-2 sm:grid-cols-[1fr_110px_1fr_110px_auto] sm:items-center">
                        <Input aria-label="Colour" placeholder="Colour" value={v.colour} onChange={(e) => upd({ colour: e.target.value })} />
                        <Input aria-label="Storage" placeholder="Storage" value={v.storage} onChange={(e) => upd({ storage: e.target.value })} />
                        <Input aria-label="Stock SKU" placeholder="Stock SKU" value={v.sku} onChange={(e) => upd({ sku: e.target.value })} />
                        <Input aria-label="Price difference" type="number" step={moneyStep()} placeholder="± price" value={v.delta} onChange={(e) => upd({ delta: e.target.value })} />
                        <button type="button" aria-label="Remove option" className="min-h-[36px] text-danger" onClick={() => setF({ ...f, variants: f.variants.filter((_, k) => k !== i) })}>Remove</button>
                      </div>
                    );
                  })}
                </div>
                <Button type="button" variant="secondary" className="mt-2 !min-h-[36px] !px-3 !text-subhead" onClick={() => setF({ ...f, variants: [...f.variants, { colour: '', storage: '', sku: '', delta: '' }] })}>＋ Add colour or storage option</Button>
              </fieldset>
            )}
          </div>
        )}

        {stepId === 'availability' && b && (
          <div className="space-y-5">
            <Card className="grid gap-4 sm:grid-cols-2">
              <Field label="Market" hint={`Prices are in ${currency}`}><Select value={f.market} onChange={set('market')}>{Object.values(markets).map((m: any) => <option key={m.code} value={m.code}>{m.name}</option>)}</Select></Field>
              {b.needsPartner && <Field label="Partner code" hint="e.g. netflix"><Input required value={f.partner} onChange={set('partner')} /></Field>}
            </Card>
            <Card>
              <fieldset>
                <legend className="mb-1 text-subhead font-medium">Sold through</legend>
                <p className="mb-1 text-footnote text-label2">Leave all unticked to sell through every channel.</p>
                <div className="flex flex-wrap gap-x-6">
                  {CHANNELS.map((c) => (
                    <label key={c} className="flex min-h-tap items-center gap-2">
                      <input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={f.channels.includes(c)} onChange={(e) => setF({ ...f, channels: e.target.checked ? [...f.channels, c] : f.channels.filter((x) => x !== c) })} />{label(c)}
                    </label>
                  ))}
                </div>
              </fieldset>
            </Card>
          </div>
        )}

        {stepId === 'rules' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <DependencyPicker title="Customer must first have" help="The customer needs one of these in the same order, or already own it. Pick a whole category or group to mean “any offer beneath it”." value={f.requires} names={names} remember={remember} levels={['OFFER', 'GROUP', 'CATEGORY', 'NETWORK_TYPE']} taken={chosen} onChange={(requires) => setF({ ...f, requires })} />
            <DependencyPicker title="Cannot be bought together with" help="Offers that cannot be in the same order as this one." value={f.excludes} names={names} remember={remember} levels={['OFFER']} taken={chosen} onChange={(excludes) => setF({ ...f, excludes })} />
          </div>
        )}

        {stepId === 'review' && b && (
          <div className="space-y-5">
            <Card>
              <dl className="divide-y divide-separator text-subhead">
                <Line k="Name" v={`${f.name || '—'}${f.id || f.name ? ` · ${f.id || slug(f.name)}` : ''}`} onEdit={() => go(steps.indexOf('basics'))} />
                <Line k="Type" v={`${type?.name ?? '—'}`} onEdit={() => go(steps.indexOf('basics'))} />
                <Line k="Group" v={where || names[f.parentId] || '—'} onEdit={() => go(steps.indexOf('basics'))} />
                <Line k="Price" v={[f.recurring && b.role !== 'GOODS' ? `${f.recurring} ${currency}/month` : '', f.upfront ? `${f.upfront} ${currency} ${upfrontLabel.toLowerCase()}` : ''].filter(Boolean).join(' · ') || '—'} onEdit={() => go(steps.indexOf('pricing'))} />
                {b.contract !== 'none' && <Line k="Contract" v={term ? `${term} months` : 'None'} onEdit={() => go(steps.indexOf('pricing'))} />}
                {steps.includes('fulfilment') && <Line k="Fulfilment" v={chosenOptions.map((o: any) => o.name).join(', ') || '—'} onEdit={() => go(steps.indexOf('fulfilment'))} />}
                {steps.includes('stock') && <Line k="Stock" v={[csv(f.skus).join(', '), f.variants.filter((v) => v.colour.trim()).length ? `${f.variants.filter((v) => v.colour.trim()).length} colour/storage options` : ''].filter(Boolean).join(' · ') || 'No SKUs'} onEdit={() => go(steps.indexOf('stock'))} />}
                <Line k="Sold through" v={f.channels.length ? f.channels.map(label).join(', ') : 'Every channel'} onEdit={() => go(steps.indexOf('availability'))} />
                <Line k="Rules" v={`${f.requires.length} required · ${f.excludes.length} excluded`} onEdit={() => go(steps.indexOf('rules'))} />
              </dl>
            </Card>
            <Card>
              <Field label="Status"><Select value={f.status} onChange={set('status')}><option value="DRAFT">Draft (not sellable)</option><option value="SCHEDULED">Scheduled (goes live on a date)</option><option value="ACTIVE">Active (sellable now)</option>{editing && <option value="RETIRED">Retired</option>}</Select></Field>
              {f.status === 'SCHEDULED' && (
                <Field label="Goes live on" hint="It becomes sellable at the start of this day. Until then it is hidden from every sales channel."><Input type="date" min={tomorrow()} value={f.activeFrom} onChange={set('activeFrom')} /></Field>
              )}
            </Card>
            {error && <Alert>{error}</Alert>}
          </div>
        )}
      </section>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {at > 0 && <Button type="button" variant="secondary" onClick={() => go(at - 1)}>Back</Button>}
        {stepId !== 'review'
          ? <Button type="button" disabled={!!blocked} onClick={() => go(at + 1)}>Continue</Button>
          : <Button type="button" disabled={busy || !!blocked || !f.parentId || !f.name.trim() || !f.kind} onClick={() => void submit()}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create offer'}</Button>}
        {editing && stepId !== 'review' && <Button type="button" variant="plain" disabled={busy || !!blocked} onClick={() => void submit()}>Save now</Button>}
        <Link href={offerId ? `/catalog?node=${offerId}` : f.parentId ? `/catalog?node=${f.parentId}` : '/catalog'} className="inline-flex min-h-tap items-center rounded-control px-4 text-body font-medium text-accent hover:bg-surface2">Cancel</Link>
        {blocked && <p role="status" className="basis-full text-footnote text-label2">{blocked}</p>}
      </div>
    </>
  );
}

const Line = ({ k, v, onEdit }: { k: string; v: string; onEdit: () => void }) => (
  <div className="flex items-start justify-between gap-4 py-2"><dt className="shrink-0 text-label2">{k}</dt><dd className="min-w-0 flex-1 text-right">{v}</dd><button type="button" className="shrink-0 text-accent" onClick={onEdit}>Edit</button></div>
);

/** Where you are: on a wide screen every step is named; on a phone it is "Step 2 of 6" with a bar. A new offer goes forward; an existing one can jump to any step. */
function Steps({ steps, index, onGo, canJump }: { steps: StepId[]; index: number; onGo: (i: number) => void; canJump: boolean }) {
  return (
    <nav aria-label="Offer steps" className="mb-6">
      <p className="text-footnote font-medium text-label2 sm:hidden">Step {index + 1} of {steps.length} · <span className="text-label">{TITLE[steps[index]!]}</span></p>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-separator sm:hidden" aria-hidden><div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${((index + 1) / steps.length) * 100}%` }} /></div>
      <ol className="hidden items-center gap-1 sm:flex">
        {steps.map((s, i) => {
          const done = i < index, here = i === index;
          const can = canJump || done;
          return (
            <li key={s} className="flex min-w-0 items-center gap-1">
              {i > 0 && <span aria-hidden className={`h-px w-4 lg:w-8 ${done || here ? 'bg-accent' : 'bg-separator'}`} />}
              <button type="button" onClick={() => can && onGo(i)} disabled={!can} aria-current={here ? 'step' : undefined}
                className={`flex min-h-[36px] items-center gap-2 rounded-full pl-1 pr-3 text-subhead transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${here ? 'bg-accent/12 font-semibold text-accent' : can ? 'text-label hover:bg-surface2' : 'text-label2'}`}>
                <span aria-hidden className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-caption font-semibold ${here ? 'bg-accent text-accent-fg' : done ? 'bg-accent/15 text-accent' : 'bg-surface2 text-label2'}`}>{done ? '✓' : i + 1}</span>
                <span className="truncate">{TITLE[s]}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Chips for what is selected, plus a search to add: offers, or (when allowed) a whole group/category/network type. */
function DependencyPicker({ title, help, value, names, remember, levels, taken, onChange }: { title: string; help: string; value: string[]; names: Record<string, string>; remember: (n: Picked) => void; levels: string[]; taken: Set<string>; onChange: (v: string[]) => void }) {
  const name = (id: string) => names[id] ?? id;
  const note = `${title} — selected`;
  return (
    <div>
      <Field label={title} hint={help}>
        <NodePicker levels={levels} exclude={taken} placeholder="Search to add…" onPick={(n) => { remember(n); onChange([...value, n.id]); }} />
      </Field>
      <ul aria-label={note} className="mt-2 flex flex-wrap gap-2">
        {value.map((id) => (
          <li key={id} className="flex items-center gap-1 rounded-full bg-surface2 py-1 pl-3 pr-1 text-subhead">
            {name(id)}
            <button type="button" aria-label={`Remove ${name(id)}`} onClick={() => onChange(value.filter((x) => x !== id))} className="grid h-7 w-7 place-items-center rounded-full text-label2 hover:bg-separator focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">×</button>
          </li>
        ))}
        {value.length === 0 && <li className="text-footnote text-label2">None</li>}
      </ul>
    </div>
  );
}
