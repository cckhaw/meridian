'use client';
import { Alert, Button, Card, Field, Input, Select, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { patch, post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { label, toMinor } from '@/lib/format';
import { slug, type TreeNode } from './node-modals';

const KINDS = ['SIM_ONLY', 'SIM_DEVICE', 'WEARABLE', 'FIBER', 'IOT_CONNECTIVITY', 'VAS', 'NON_TELCO_SUBSCRIPTION', 'PHYSICAL_GOOD'];
const CHANNELS = ['SELF_SERVE', 'RETAIL_ASSISTED', 'QUICK_SALE', 'TELESALES', 'DEALER', 'CALL_CENTER'];
const major = (minor?: number) => (minor === undefined ? '' : String(minor / 100));

interface FormState {
  parentId: string; id: string; name: string; kind: string; description: string; market: string; recurring: string; upfront: string; taxInclusive: boolean;
  term: string; etcMethod: string; etcPercent: string; waive: string; subsidy: string; retail: string; shipping: boolean; install: boolean; sim: boolean; skus: string; partner: string;
  requires: string[]; excludes: string[]; channels: string[]; status: string;
}

const blank = (market: string): FormState => ({
  parentId: '', id: '', name: '', kind: 'SIM_ONLY', description: '', market, recurring: '', upfront: '', taxInclusive: true,
  term: '0', etcMethod: 'SUBSIDY_AMORTISED', etcPercent: '50', waive: '1', subsidy: '', retail: '', shipping: false, install: false, sim: false, skus: '', partner: '',
  requires: [], excludes: [], channels: [], status: 'DRAFT',
});

function fromOffer(o: any, market: string): FormState {
  const rec = o.prices?.find((p: any) => p.type === 'RECURRING'), once = o.prices?.find((p: any) => p.type === 'ONE_TIME');
  return {
    ...blank(o.markets?.[0] ?? market), parentId: o.parentId ?? '', id: o.id, name: o.name, kind: o.kind, description: o.description ?? '', status: o.status,
    recurring: major(rec?.amount.amountMinor), upfront: major(once?.amount.amountMinor), taxInclusive: (rec ?? once)?.taxInclusive ?? true,
    term: String(o.contract?.termMonths ?? 0), etcMethod: o.contract?.etc?.method ?? 'SUBSIDY_AMORTISED', etcPercent: String(o.contract?.etc?.percentOfRemaining ?? 50), waive: String(o.contract?.etc?.waiveInLastMonths ?? 1),
    subsidy: major(o.contract?.subsidy?.subsidyAmount.amountMinor), retail: major(o.contract?.subsidy?.deviceRetailPrice.amountMinor),
    shipping: !!o.fulfilment?.requiresShipping, install: !!o.fulfilment?.requiresInstallation, sim: !!o.fulfilment?.requiresSimActivation, skus: (o.fulfilment?.inventorySkus ?? []).join(', '),
    partner: o.partnerCode ?? '', requires: o.requires ?? [], excludes: o.excludes ?? [], channels: o.salesChannels ?? [],
  };
}

/**
 * One form for all three jobs: create an offer (`?parent=`), edit an existing one (pencil on the panel), or
 * start a new version of a sold offer (`?from=`), which prefills from the source with a fresh id.
 */
export function OfferForm({ offerId, parentId, fromId }: { offerId?: string; parentId?: string | null; fromId?: string | null }) {
  const sourceId = offerId ?? fromId ?? null;
  const meta = useApi('/meta');
  const tree = useApi('/catalog/tree');
  const src = useApi(sourceId ? `/catalog/${sourceId}` : null);
  const usage = useApi(offerId ? `/catalog/${offerId}/usage` : null);
  if ((meta.loading && !meta.data) || (tree.loading && !tree.data) || (sourceId && src.loading && !src.data) || (offerId && usage.loading && !usage.data)) return <Spinner />;
  if (meta.error || tree.error || src.error) return <Alert>{meta.error ?? tree.error ?? src.error}</Alert>;
  return <Inner key={sourceId ?? 'new'} offerId={offerId} parentId={parentId ?? null} fromId={fromId ?? null} source={src.data} markets={meta.data?.markets ?? {}} roots={tree.data?.items ?? []} sold={(usage.data?.services ?? 0) + (usage.data?.orders ?? 0)} />;
}

const flatten = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((n) => [n, ...flatten(n.children)]);

function Inner({ offerId, parentId, fromId, source, markets, roots, sold }: { offerId?: string; parentId: string | null; fromId: string | null; source: any; markets: Record<string, any>; roots: TreeNode[]; sold: number }) {
  const { me } = useAuth();
  const router = useRouter();
  const editing = !!offerId;
  const locked = editing && sold > 0; // price, contract and kind of a sold offer are immutable: new version instead
  const defaultMarket = me?.marketCode ?? 'SG';
  const [f, setF] = useState<FormState>(() => {
    if (source) { const s = fromOffer(source, defaultMarket); return fromId ? { ...s, id: `${source.id}-v2`, status: 'DRAFT' } : s; }
    return { ...blank(defaultMarket), parentId: parentId ?? '' };
  });
  const { run, busy, error } = useAction();
  const all = useMemo(() => flatten(roots), [roots]);
  const groups = all.filter((n) => n.level === 'GROUP');
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const tick = (k: 'taxInclusive' | 'shipping' | 'install' | 'sim') => (e: { target: { checked: boolean } }) => setF({ ...f, [k]: e.target.checked });

  const market = markets[f.market];
  const currency = market?.currency ?? 'SGD';
  const money = (v: string) => ({ amountMinor: toMinor(v), currency });
  const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

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
  const fulfilment = { requiresShipping: f.shipping, requiresInstallation: f.install, requiresSimActivation: f.sim, inventorySkus: csv(f.skus) };
  const common = { name: f.name.trim(), description: f.description || undefined, fulfilment, partnerCode: f.partner || undefined, requires: f.requires, excludes: f.excludes, salesChannels: f.channels };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await run(async () => {
      if (editing) {
        await patch(`/catalog/${offerId}`, { ...common, markets: [f.market], ...(locked ? {} : { kind: f.kind, prices, contract }), ...(f.status !== source.status ? { status: f.status } : {}) });
        if (f.parentId && f.parentId !== source.parentId) await post(`/catalog/${offerId}/move`, { parentId: f.parentId });
      } else {
        const node = await post('/catalog', { level: 'OFFER', id: f.id || slug(f.name), parentId: f.parentId, markets: [f.market], kind: f.kind, prices, contract, characteristics: {}, ...common, status: 'DRAFT' });
        if (f.status === 'ACTIVE') await patch(`/catalog/${node.id}`, { status: 'ACTIVE' });
      }
      return true;
    });
    if (ok) router.push('/catalog');
  };

  const chosen = new Set([...f.requires, ...f.excludes, offerId ?? '']);
  return (
    <>
      {fromId && <div className="mb-4"><Alert tone="info">New version of <strong>{fromId}</strong>: change what you need, create it, then retire the old offer. Existing services keep the price they were sold at.</Alert></div>}
      {locked && (
        <div className="mb-4"><Alert tone="info">
          This offer has {sold} sold subscription/order line{sold === 1 ? '' : 's'}, so its price, contract and type are fixed. You can still change everything else.{' '}
          <Link href={`/catalog/manage?from=${offerId}`} className="font-medium underline">Create a new version</Link> to change pricing.
        </Alert></div>
      )}
      <Card>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <Field label="Group" hint="Where the offer sits in the hierarchy.">
            <Select required value={f.parentId} onChange={set('parentId')}>
              <option value="">Choose…</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.path.split('/').map((p) => all.find((n) => n.id === p)?.name ?? p).join(' › ')}</option>)}
            </Select>
          </Field>
          <Field label="Display name"><Input required value={f.name} onChange={set('name')} maxLength={100} /></Field>
          <Field label="ID" hint={editing ? 'Cannot be changed once created.' : 'Lowercase letters, digits and dashes. Leave blank to derive from the name.'}>
            <Input value={f.id} onChange={set('id')} disabled={editing} pattern="[a-z0-9][a-z0-9\-]*" placeholder={slug(f.name)} />
          </Field>
          <Field label="Offer type"><Select value={f.kind} onChange={set('kind')} disabled={locked}>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
          <Field label="Market" hint={`Prices are in ${currency}`}><Select value={f.market} onChange={set('market')}>{Object.values(markets).map((m: any) => <option key={m.code} value={m.code}>{m.name}</option>)}</Select></Field>
          <Field label="Status"><Select value={f.status} onChange={set('status')}><option value="DRAFT">Draft (not sellable)</option><option value="ACTIVE">Active (sellable)</option>{editing && <option value="RETIRED">Retired</option>}</Select></Field>
          <div className="sm:col-span-2"><Field label="Description" hint="Shown to customers in the store-front."><Input value={f.description} onChange={set('description')} maxLength={500} /></Field></div>

          <Field label={`Monthly fee (${currency})`}><Input type="number" min="0" step="0.01" value={f.recurring} onChange={set('recurring')} disabled={locked} /></Field>
          <Field label={`Upfront price (${currency})`} hint="Device, SIM kit or installation fee"><Input type="number" min="0" step="0.01" value={f.upfront} onChange={set('upfront')} disabled={locked} /></Field>
          <label className="flex min-h-tap items-center gap-3 text-body sm:col-span-2"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={f.taxInclusive} onChange={tick('taxInclusive')} disabled={locked} />Prices include tax{market ? ` (${market.taxName} ${market.taxBps / 100}%)` : ''}</label>

          <Field label="Contract term"><Select value={f.term} onChange={set('term')} disabled={locked}>{[0, 12, 24, 36].map((t) => <option key={t} value={t}>{t === 0 ? 'No contract' : `${t} months`}</option>)}</Select></Field>
          {f.term !== '0' && (
            <>
              <Field label="Early termination charge"><Select value={f.etcMethod} onChange={set('etcMethod')} disabled={locked}><option value="SUBSIDY_AMORTISED">Remaining device subsidy</option><option value="REMAINING_RECURRING_PERCENT">% of remaining monthly fees</option></Select></Field>
              {f.etcMethod === 'REMAINING_RECURRING_PERCENT'
                ? <Field label="% of remaining fees"><Input type="number" min="0" max="100" value={f.etcPercent} onChange={set('etcPercent')} disabled={locked} /></Field>
                : <><Field label={`Subsidy (${currency})`} hint="What you fund; recovered if the customer leaves early"><Input type="number" min="0" step="0.01" value={f.subsidy} onChange={set('subsidy')} disabled={locked} /></Field><Field label={`Device retail price (${currency})`}><Input type="number" min="0" step="0.01" value={f.retail} onChange={set('retail')} disabled={locked} /></Field></>}
              <Field label="Waive charge in last N months"><Input type="number" min="0" max="12" value={f.waive} onChange={set('waive')} disabled={locked} /></Field>
            </>
          )}

          <fieldset className="sm:col-span-2"><legend className="mb-1 text-subhead font-medium">Fulfilment</legend>
            <div className="flex flex-wrap gap-x-6">
              {([['shipping', 'Ships to the customer'], ['install', 'Needs an installation visit'], ['sim', 'Needs SIM activation']] as const).map(([k, t]) => <label key={k} className="flex min-h-tap items-center gap-2"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={f[k]} onChange={tick(k)} />{t}</label>)}
            </div>
          </fieldset>
          <Field label="Stock SKUs" hint="Comma-separated; one unit of each is reserved per item sold"><Input value={f.skus} onChange={set('skus')} /></Field>
          {f.kind === 'NON_TELCO_SUBSCRIPTION' && <Field label="Partner code" hint="e.g. netflix"><Input required value={f.partner} onChange={set('partner')} /></Field>}

          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-subhead font-medium">Sold through</legend>
            <p className="mb-1 text-footnote text-label2">Leave all unticked to sell through every channel.</p>
            <div className="flex flex-wrap gap-x-6">
              {CHANNELS.map((c) => (
                <label key={c} className="flex min-h-tap items-center gap-2">
                  <input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={f.channels.includes(c)} onChange={(e) => setF({ ...f, channels: e.target.checked ? [...f.channels, c] : f.channels.filter((x) => x !== c) })} />{label(c)}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="sm:col-span-2 grid gap-4 sm:grid-cols-2">
            <DependencyPicker title="Customer must first have" help="The customer needs one of these in the same order, or already own it. Pick a whole category or group to mean “any offer beneath it”." value={f.requires} nodes={all} taken={chosen} allowGroups onChange={(requires) => setF({ ...f, requires })} />
            <DependencyPicker title="Cannot be bought together with" help="Offers that cannot be in the same order as this one." value={f.excludes} nodes={all} taken={chosen} onChange={(excludes) => setF({ ...f, excludes })} />
          </div>

          {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy || !f.parentId || !f.name.trim()}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create offer'}</Button>
            <Link href="/catalog" className="inline-flex min-h-tap items-center rounded-control px-5 text-body font-medium text-accent hover:bg-surface2">Cancel</Link>
          </div>
        </form>
      </Card>
    </>
  );
}

/** Chips for what is selected, plus a dropdown to add: offers, or (when allowed) a whole group/category/network type. */
function DependencyPicker({ title, help, value, nodes, taken, allowGroups, onChange }: { title: string; help: string; value: string[]; nodes: TreeNode[]; taken: Set<string>; allowGroups?: boolean; onChange: (v: string[]) => void }) {
  const name = (id: string) => { const n = nodes.find((x) => x.id === id); return n ? (n.level === 'OFFER' ? n.name : `Any ${n.name}`) : `${id} (missing)`; };
  const options = nodes.filter((n) => !taken.has(n.id) && (allowGroups ? true : n.level === 'OFFER'));
  const note = `${title} — selected`;
  return (
    <div>
      <Field label={title} hint={help}>
        <Select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
          <option value="">Add…</option>
          {options.map((n) => <option key={n.id} value={n.id}>{'— '.repeat(Math.max(0, n.path.split('/').length - 1))}{n.level === 'OFFER' ? n.name : `Any ${n.name} (${label(n.level)})`}</option>)}
        </Select>
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
