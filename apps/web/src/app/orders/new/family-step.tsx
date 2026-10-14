'use client';
import { Alert, Button, Card, Field, Segmented, Select, Spinner } from '@meridian/ui';
import { useEffect, useState } from 'react';
import { api, useApi } from '@/lib/api';
import { money } from '@/lib/format';
import { PortInFields } from './port-in-fields';
import { CardNote, NumberChooser, release } from './sim-step';
import type { Wizard } from './steps';
import { emptyPortIn, isGroupPlan, newMember, quoteIndex, type Item, type Member } from './wizard-types';

/** The plans a member line may take: the ones the group plan names, or every active mobile plan that is not itself a group plan. */
function useMemberOffers(head: any, market: string): { offers: any[]; loading: boolean } {
  const allowed: string[] = head.group?.allowedMemberOfferIds ?? [];
  const [named, setNamed] = useState<any[] | null>(allowed.length ? null : []);
  useEffect(() => {
    if (!allowed.length) return;
    let live = true;
    void Promise.all(allowed.map((id) => api(`/catalog/${encodeURIComponent(id)}`).catch(() => null))).then((r) => { if (live) setNamed(r.filter((o) => o && o.level === 'OFFER' && o.status === 'ACTIVE')); });
    return () => { live = false; };
  }, [allowed.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const any = useApi<{ items: any[] }>(allowed.length ? null : `/catalog?limit=50&status=ACTIVE&market=${market}&kind=SIM_ONLY`);
  if (allowed.length) return { offers: named ?? [], loading: named === null };
  return { offers: (any.data?.items ?? []).filter((o) => !isGroupPlan(o)), loading: !any.data };
}

/** Step "Family members": for each group plan in the basket, the lines that share it, each with its own plan, SIM and number (new or ported in). */
export function FamilyStep({ w }: { w: Wizard }) {
  const heads = w.items.filter((i) => isGroupPlan(i.offer));
  if (!heads.length) return <Alert tone="info">Nothing in this order is a group plan.</Alert>;
  return <div className="space-y-5">{heads.map((h) => <Plan key={h.key} w={w} head={h} />)}</div>;
}

function Plan({ w, head }: { w: Wizard; head: Item }) {
  const max: number = head.offer.group.maxGroupMembers;
  const pool: number | undefined = head.offer.group.sharedPoolQuotaGb;
  const members = head.members ?? [];
  const { offers, loading } = useMemberOffers(head.offer, w.marketCode);
  const base = quoteIndex(w.items, w.items.findIndex((x) => x.key === head.key));
  const setMembers = (f: (m: Member[]) => Member[]) => w.setItems((cur) => cur.map((x) => (x.key === head.key ? { ...x, members: f(x.members ?? []) } : x)));
  const edit = (key: string, patch: Partial<Member>) => setMembers((ms) => ms.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-title3 font-semibold">{head.offer.name}</h3>
        <span className="text-subhead text-label2">{members.length} of {max} member lines{pool ? ` · ${pool} GB shared` : ''}</span>
      </div>
      <p className="mb-4 text-subhead text-label2">The buyer’s own line is the family head and manages the group. Add up to {max} more lines now, or later: the group keeps the free places open.</p>
      {loading ? <Spinner /> : offers.length === 0 ? <Alert>No plan is available for member lines.</Alert> : (
        <ul className="space-y-4">
          {members.map((m, k) => {
            const ql = w.quote?.lines?.[base + 1 + k];
            return (
              <li key={m.key} className="rounded-card border border-separator p-4">
                <div className="mb-3 flex items-start justify-between gap-2"><p className="font-semibold">Member {k + 1}</p>
                  <button type="button" aria-label={`Remove member ${k + 1}`} className="text-subhead text-accent" onClick={() => { release(m.msisdn, m.numberToken); setMembers((ms) => ms.filter((x) => x.key !== m.key)); }}>Remove</button></div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Plan"><Select value={m.offerId} onChange={(e) => edit(m.key, { offerId: e.target.value })}>{offers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
                  <Field label="SIM"><Segmented<'PHYSICAL' | 'ESIM' | ''> label={`SIM for member ${k + 1}`} value={m.simType} onChange={(v) => edit(m.key, { simType: v })} options={[{ value: 'PHYSICAL' as const, label: 'Next free card' }, { value: 'ESIM' as const, label: 'eSIM' }, { value: '' as const, label: 'Later' }]} /></Field>
                </div>
                <div className="mt-3"><MemberNumber m={m} edit={(p) => edit(m.key, p)} /></div>
                {ql && <p className="mt-3 text-footnote text-label2">{money(ql.priceMinor)} today · {money(ql.monthlyFeeMinor)} a month{ql.vip ? ` · ${ql.vip.tier.toLowerCase()} number` : ''}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-4"><Button type="button" variant="secondary" disabled={loading || members.length >= max || offers.length === 0} onClick={() => setMembers((ms) => [...ms, newMember(offers[0]!.id)])}>{members.length >= max ? 'The group is full' : 'Add a member line'}</Button></div>
      <CardNote />
    </Card>
  );
}

function MemberNumber({ m, edit }: { m: Member; edit: (p: Partial<Member>) => void }) {
  const mode: 'AUTO' | 'CHOOSE' | 'PORT' = m.portIn ? 'PORT' : m.numberToken ? 'CHOOSE' : 'AUTO';
  const [pick, setPick] = useState(mode === 'CHOOSE');
  const value = pick && mode !== 'PORT' ? 'CHOOSE' : mode;
  return (
    <>
      <p className="mb-2 text-subhead font-medium">Number</p>
      <Segmented<'AUTO' | 'CHOOSE' | 'PORT'> label="Number" value={value}
        onChange={(v) => { setPick(v === 'CHOOSE'); if (v !== 'CHOOSE') release(m.msisdn, m.numberToken); edit({ msisdn: '', numberToken: '', numberTier: '', numberFeeMinor: 0, numberExpires: '', portIn: v === 'PORT' ? (m.portIn ?? emptyPortIn()) : null }); }}
        options={[{ value: 'AUTO' as const, label: 'Assign one' }, { value: 'CHOOSE' as const, label: 'Choose a number' }, { value: 'PORT' as const, label: 'Port in their number' }]} />
      <div className="mt-3">
        {value === 'AUTO' && <p className="text-subhead text-label2">A standard number is assigned from the pool.</p>}
        {value === 'CHOOSE' && <NumberChooser item={m} set={(p) => edit(p as Partial<Member>)} />}
        {value === 'PORT' && m.portIn && <PortInFields value={m.portIn} onChange={(portIn) => edit({ portIn })} />}
      </div>
    </>
  );
}
