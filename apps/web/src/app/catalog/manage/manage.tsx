'use client';
import { Alert, Button, Card, Field, Input, LargeTitle, Select, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { patch, post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { label, toMinor } from '@/lib/format';

const LEVELS = [
  { value: 'NETWORK_TYPE', label: 'Network type (top level)' }, { value: 'CATEGORY', label: 'Category' }, { value: 'GROUP', label: 'Group' }, { value: 'OFFER', label: 'Offer (what customers buy)' },
];
const PARENT_LEVEL: Record<string, string | null> = { NETWORK_TYPE: null, CATEGORY: 'NETWORK_TYPE', GROUP: 'CATEGORY', OFFER: 'GROUP' };
const KINDS = ['SIM_ONLY', 'SIM_DEVICE', 'WEARABLE', 'FIBER', 'IOT_CONNECTIVITY', 'VAS', 'NON_TELCO_SUBSCRIPTION', 'PHYSICAL_GOOD'];

const blank = {
  level: 'OFFER', parentId: '', id: '', name: '', networkType: 'mobile', kind: 'SIM_ONLY', description: '', market: '', recurring: '', upfront: '', taxInclusive: true,
  term: '0', etcMethod: 'SUBSIDY_AMORTISED', etcPercent: '50', waive: '1', subsidy: '', retail: '', shipping: false, install: false, sim: false, skus: '', partner: '', requires: '', excludes: '', activate: false,
};

export function ManageCatalog() {
  const { me } = useAuth();
  const router = useRouter();
  const from = useSearchParams().get('from');
  const meta = useApi('/meta');
  const [f, setF] = useState({ ...blank, market: me?.marketCode ?? 'SG' });
  const parentLevel = PARENT_LEVEL[f.level];
  const parents = useApi(parentLevel ? `/catalog?level=${parentLevel}` : null);
  const src = useApi(from ? `/catalog/${from}` : null);
  const { run, busy, error } = useAction();
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const tick = (k: keyof typeof blank) => (e: { target: { checked: boolean } }) => setF({ ...f, [k]: e.target.checked });

  useEffect(() => { // "new version of an existing offer": prefill from it
    const o = src.data; if (!o || o.level !== 'OFFER') return;
    const rec = o.prices.find((p: any) => p.type === 'RECURRING'), once = o.prices.find((p: any) => p.type === 'ONE_TIME');
    setF({
      ...blank, level: 'OFFER', parentId: o.parentId, id: `${o.id}-v2`, name: o.name, kind: o.kind, description: o.description ?? '', market: o.markets[0] ?? me?.marketCode ?? 'SG',
      recurring: rec ? String(rec.amount.amountMinor / 100) : '', upfront: once ? String(once.amount.amountMinor / 100) : '', taxInclusive: (rec ?? once)?.taxInclusive ?? true,
      term: String(o.contract?.termMonths ?? 0), etcMethod: o.contract?.etc?.method ?? 'SUBSIDY_AMORTISED', etcPercent: String(o.contract?.etc?.percentOfRemaining ?? 50), waive: String(o.contract?.etc?.waiveInLastMonths ?? 1),
      subsidy: o.contract?.subsidy ? String(o.contract.subsidy.subsidyAmount.amountMinor / 100) : '', retail: o.contract?.subsidy ? String(o.contract.subsidy.deviceRetailPrice.amountMinor / 100) : '',
      shipping: !!o.fulfilment?.requiresShipping, install: !!o.fulfilment?.requiresInstallation, sim: !!o.fulfilment?.requiresSimActivation, skus: (o.fulfilment?.inventorySkus ?? []).join(', '),
      partner: o.partnerCode ?? '', requires: (o.requires ?? []).join(', '), excludes: (o.excludes ?? []).join(', '),
    });
  }, [src.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (meta.loading && !meta.data) return <Spinner />;
  const market = meta.data?.markets?.[f.market];
  const currency = market?.currency ?? 'SGD';
  const parent = (parents.data?.items ?? []).find((p: any) => p.id === f.parentId);
  const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const money = (v: string) => ({ amountMinor: toMinor(v), currency });

  const build = () => {
    const base = { id: f.id, level: f.level, code: f.id, name: f.name, path: parent ? `${parent.path}/${f.id}` : f.id, parentId: parent?.id ?? null, status: 'DRAFT', markets: f.level === 'OFFER' ? [f.market] : [] };
    if (f.level === 'NETWORK_TYPE') return { ...base, networkType: f.networkType };
    if (f.level !== 'OFFER') return base;
    const prices = [
      ...(f.recurring ? [{ type: 'RECURRING', amount: money(f.recurring), periodMonths: 1, taxInclusive: f.taxInclusive }] : []),
      ...(f.upfront ? [{ type: 'ONE_TIME', amount: money(f.upfront), taxInclusive: f.taxInclusive }] : []),
    ];
    const term = Number(f.term);
    const contract = term === 0 ? { termMonths: 0 } : {
      termMonths: term,
      etc: { method: f.etcMethod, ...(f.etcMethod === 'REMAINING_RECURRING_PERCENT' ? { percentOfRemaining: Number(f.etcPercent) } : {}), waiveInLastMonths: Number(f.waive) },
      ...(f.etcMethod === 'SUBSIDY_AMORTISED' ? { subsidy: { subsidyAmount: money(f.subsidy || '0'), deviceRetailPrice: money(f.retail || '0') } } : {}),
    };
    return { ...base, kind: f.kind, description: f.description || undefined, prices, contract, fulfilment: { requiresShipping: f.shipping, requiresInstallation: f.install, requiresSimActivation: f.sim, inventorySkus: csv(f.skus) },
      partnerCode: f.partner || undefined, characteristics: {}, requires: csv(f.requires), excludes: csv(f.excludes) };
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const node = await run(() => post('/catalog', build()));
    if (node && f.activate) await run(() => patch(`/catalog/${node.id}`, { status: 'ACTIVE' }));
    if (node) router.push('/catalog');
  };
  const isOffer = f.level === 'OFFER';

  return (
    <>
      <LargeTitle subtitle="Build the hierarchy, then define what customers can buy. New items start as drafts.">Manage catalog</LargeTitle>
      <p className="mb-4"><Link href="/catalog" className="text-subhead text-accent">← Back to catalog</Link></p>
      {from && <div className="mb-4"><Alert tone="info">New version of <strong>{from}</strong>: change what you need, create it, then retire the old offer. Existing services keep the price they were sold at.</Alert></div>}
      <Card>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <Field label="What are you creating?"><Select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value, parentId: '' })}>{LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</Select></Field>
          {parentLevel && <Field label={`Under which ${label(parentLevel).toLowerCase()}`} hint={parents.data?.items.length === 0 ? `Create a ${label(parentLevel).toLowerCase()} first.` : undefined}>
            <Select required value={f.parentId} onChange={set('parentId')}><option value="">Choose…</option>{(parents.data?.items ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.path}</option>)}</Select></Field>}
          <Field label="ID" hint="Lowercase letters, digits and dashes. Used in the path and cannot change."><Input required pattern="[a-z0-9][a-z0-9\-]*" value={f.id} onChange={set('id')} /></Field>
          <Field label="Display name"><Input required value={f.name} onChange={set('name')} /></Field>
          {f.level === 'NETWORK_TYPE' && <Field label="Network"><Select value={f.networkType} onChange={set('networkType')}>{['mobile', 'fiber', 'iot', 'none'].map((n) => <option key={n} value={n}>{label(n)}</option>)}</Select></Field>}

          {isOffer && (
            <>
              <Field label="Offer type"><Select value={f.kind} onChange={set('kind')}>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
              <Field label="Market" hint={`Prices are in ${currency}`}><Select value={f.market} onChange={set('market')}>{Object.values(meta.data?.markets ?? {}).map((m: any) => <option key={m.code} value={m.code}>{m.name}</option>)}</Select></Field>
              <div className="sm:col-span-2"><Field label="Description"><Input value={f.description} onChange={set('description')} /></Field></div>
              <Field label={`Monthly fee (${currency})`}><Input type="number" min="0" step="0.01" value={f.recurring} onChange={set('recurring')} /></Field>
              <Field label={`Upfront price (${currency})`} hint="Device, SIM kit or installation fee"><Input type="number" min="0" step="0.01" value={f.upfront} onChange={set('upfront')} /></Field>
              <label className="flex min-h-tap items-center gap-3 text-body sm:col-span-2"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={f.taxInclusive} onChange={tick('taxInclusive')} />Prices include tax{market ? ` (${market.taxName} ${market.taxBps / 100}%)` : ''}</label>

              <Field label="Contract term"><Select value={f.term} onChange={set('term')}>{[0, 12, 24, 36].map((t) => <option key={t} value={t}>{t === 0 ? 'No contract' : `${t} months`}</option>)}</Select></Field>
              {f.term !== '0' && (
                <>
                  <Field label="Early termination charge"><Select value={f.etcMethod} onChange={set('etcMethod')}><option value="SUBSIDY_AMORTISED">Remaining device subsidy</option><option value="REMAINING_RECURRING_PERCENT">% of remaining monthly fees</option></Select></Field>
                  {f.etcMethod === 'REMAINING_RECURRING_PERCENT'
                    ? <Field label="% of remaining fees"><Input type="number" min="0" max="100" value={f.etcPercent} onChange={set('etcPercent')} /></Field>
                    : <><Field label={`Subsidy (${currency})`} hint="What you fund; recovered if the customer leaves early"><Input type="number" min="0" step="0.01" value={f.subsidy} onChange={set('subsidy')} /></Field><Field label={`Device retail price (${currency})`}><Input type="number" min="0" step="0.01" value={f.retail} onChange={set('retail')} /></Field></>}
                  <Field label="Waive charge in last N months"><Input type="number" min="0" max="12" value={f.waive} onChange={set('waive')} /></Field>
                </>
              )}
              <fieldset className="sm:col-span-2"><legend className="mb-1 text-subhead font-medium">Fulfilment</legend>
                <div className="flex flex-wrap gap-x-6">
                  {([['shipping', 'Ships to the customer'], ['install', 'Needs an installation visit'], ['sim', 'Needs SIM activation']] as const).map(([k, t]) => <label key={k} className="flex min-h-tap items-center gap-2"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={f[k]} onChange={tick(k)} />{t}</label>)}
                </div>
              </fieldset>
              <Field label="Stock SKUs" hint="Comma-separated; one unit of each is reserved per item sold"><Input value={f.skus} onChange={set('skus')} /></Field>
              {f.kind === 'NON_TELCO_SUBSCRIPTION' && <Field label="Partner code" hint="e.g. netflix"><Input required value={f.partner} onChange={set('partner')} /></Field>}
              <Field label="Requires (offer ids)"><Input value={f.requires} onChange={set('requires')} /></Field>
              <Field label="Cannot be combined with (offer ids)"><Input value={f.excludes} onChange={set('excludes')} /></Field>
              <label className="flex min-h-tap items-center gap-3 text-body sm:col-span-2"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={f.activate} onChange={tick('activate')} />Make it sellable immediately</label>
            </>
          )}
          {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
          <div className="sm:col-span-2"><Button type="submit" disabled={busy || (!!parentLevel && !f.parentId)}>{busy ? 'Saving…' : `Create ${label(f.level).toLowerCase()}`}</Button></div>
        </form>
      </Card>
    </>
  );
}
