'use client';
import { Alert, Badge, Button, Card, SearchField, Segmented, Spinner } from '@meridian/ui';
import { useEffect, useState } from 'react';
import { post, useApi, useDebounced } from '@/lib/api';
import { money } from '@/lib/format';
import type { Wizard } from './steps';
import { PortInFields } from './port-in-fields';
import { digits, emptyPortIn, isGroupPlan, quoteIndex, takenElsewhere, type Item, type Member, type NumberHolder, type Slot } from './wizard-types';

const TIER_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = { STANDARD: 'neutral', SILVER: 'neutral', GOLD: 'warning', DIAMOND: 'success', AUCTION: 'danger' };
const fmtNumber = (m: string) => m.replace(/^(\+\d{2})(\d{2})(\d+)$/, '$1 $2 $3');

/**
 * Step "SIM and number": every line that gets a service has its own SIM and number: the plan's line, and each member line of a family plan (as many as were
 * added in the step before). A card or number chosen for one line is not offered to, or accepted for, another line of the order.
 */
export function SimStep({ w, requireSim }: { w: Wizard; requireSim: boolean }) {
  const lines: any[] = w.quote?.lines ?? [];
  const setItem = (key: string, patch: Partial<Item>) => w.setItems((cur) => cur.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const setMember = (key: string, mkey: string, patch: Partial<Member>) => w.setItems((cur) => cur.map((x) => (x.key === key ? { ...x, members: (x.members ?? []).map((m) => (m.key === mkey ? { ...m, ...patch } : m)) } : x)));
  const cards: Array<{ id: string; title: string; subtitle?: string; badge?: string; slot: Slot; line: any; set: (p: Partial<Slot>) => void }> = [];
  w.items.forEach((it, k) => {
    const qi = quoteIndex(w.items, k);
    const group = isGroupPlan(it.offer);
    cards.push({ id: it.key, title: it.offer.name, badge: group ? 'Family head' : undefined, slot: it as Slot, line: lines[qi], set: (p) => setItem(it.key, p as Partial<Item>) });
    if (group) (it.members ?? []).filter((m) => m.offerId).forEach((m, n) => cards.push({ id: m.key, title: `${it.offer.name}: member ${n + 1}`, subtitle: lines[qi + 1 + n]?.name, slot: m as Slot, line: lines[qi + 1 + n], set: (p) => setMember(it.key, m.key, p as Partial<Member>) }));
  });
  const needing = cards.filter((c) => c.line?.needsSim);
  if (!needing.length) return <Alert tone="info">Nothing in this order needs a SIM.</Alert>;
  return (
    <div className="space-y-5">
      {needing.map((c) => <LineSim key={c.id} w={w} {...c} requireSim={requireSim} />)}
      <p className="text-footnote text-label2">Each line has its own SIM card and its own number: one chosen for a line is not offered to the others.{requireSim ? ' Your company requires a SIM on every plan. The SIM is held for this order and activated with the service.' : ''}</p>
    </div>
  );
}

function LineSim({ w, title, subtitle, badge, slot, set, line, requireSim }: { w: Wizard; title: string; subtitle?: string; badge?: string; slot: Slot; set: (p: Partial<Slot>) => void; line: any; requireSim: boolean }) {
  const taken = takenElsewhere(w.items, slot);
  const place = w.fixedStore ?? (w.retail ? w.store : '');   // where the sale is made
  const [simMode, setSimMode] = useState<'NEXT' | 'CARD' | 'ESIM' | 'NONE'>(slot.iccid ? 'CARD' : slot.simType === 'ESIM' ? 'ESIM' : slot.simType === 'PHYSICAL' ? 'NEXT' : requireSim ? 'NEXT' : 'NONE');
  useEffect(() => { if (requireSim && simMode === 'NEXT' && !slot.iccid && !slot.simType) set({ simType: 'PHYSICAL' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const numMode: 'AUTO' | 'CHOOSE' | 'OWN' = slot.numberToken ? 'CHOOSE' : slot.portIn ? 'OWN' : 'AUTO';
  const [pickNumber, setPickNumber] = useState(!!slot.numberToken);
  const donor = slot.portIn?.donorMsisdn ? digits(slot.portIn.donorMsisdn) : '';
  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div><h3 className="text-title3 font-semibold">{title}</h3>{subtitle && <p className="text-subhead text-label2">{subtitle}</p>}</div>
        <span className="flex flex-wrap justify-end gap-1">{badge && <Badge>{badge}</Badge>}{line?.vip && <Badge tone={TIER_TONE[line.vip.tier] ?? 'neutral'}>{line.vip.tier.toLowerCase()} number</Badge>}</span>
      </div>

      <h4 className="mb-2 text-subhead font-semibold">SIM</h4>
      <Segmented<'NEXT' | 'CARD' | 'ESIM' | 'NONE'> label={`SIM for ${title}`} value={simMode} onChange={(v) => { setSimMode(v); set(v === 'CARD' ? { iccid: '', simType: '' } : v === 'NEXT' ? { iccid: '', simType: 'PHYSICAL' } : v === 'ESIM' ? { iccid: '', simType: 'ESIM' } : { iccid: '', simType: '' }); }}
        options={[{ value: 'NEXT' as const, label: 'Next free card' }, { value: 'CARD' as const, label: 'A specific card' }, { value: 'ESIM' as const, label: 'eSIM' }, ...(requireSim ? [] : [{ value: 'NONE' as const, label: 'Later' }])]} />
      <div className="mt-3">
        {simMode === 'NEXT' && <p className="text-subhead text-label2">The next free SIM card {place ? `at ${w.fixedStore ? 'your store' : 'the selling store'} (${place})` : w.retail ? 'at the store (choose the store first)' : 'in the warehouse'} is taken when the order is placed.</p>}
        {simMode === 'ESIM' && <p className="text-subhead text-label2">A new eSIM profile is issued; the customer scans its activation code on the device.</p>}
        {simMode === 'NONE' && <p className="text-subhead text-label2">No SIM now. It can be added when the service is set up.</p>}
        {simMode === 'CARD' && <CardPicker place={place} retail={w.retail} value={slot.iccid ?? ''} taken={taken.iccids} onPick={(iccid) => set({ iccid, simType: iccid ? 'PHYSICAL' : '' })} />}
      </div>

      <h4 className="mb-2 mt-5 text-subhead font-semibold">Number</h4>
      <Segmented label={`Number for ${title}`} value={pickNumber ? 'CHOOSE' : numMode === 'OWN' ? 'OWN' : 'AUTO'} onChange={(v) => { setPickNumber(v === 'CHOOSE'); if (v !== 'CHOOSE') release(slot.msisdn, slot.numberToken); set({ msisdn: '', numberToken: '', numberTier: '', numberFeeMinor: 0, numberExpires: '', portIn: v === 'OWN' ? (slot.portIn ?? emptyPortIn()) : null }); }}
        options={[{ value: 'AUTO', label: 'Assign one' }, { value: 'CHOOSE', label: 'Choose a number' }, { value: 'OWN', label: 'Port in their number' }]} />
      <div className="mt-3">
        {!pickNumber && numMode !== 'OWN' && <p className="text-subhead text-label2">A standard number is assigned from the pool.</p>}
        {numMode === 'OWN' && !pickNumber && slot.portIn && <PortInFields value={slot.portIn} onChange={(portIn) => set({ portIn })} />}
        {numMode === 'OWN' && donor && taken.msisdns.has(donor) && <div className="mt-2"><Alert>That number is already used on another line of this order.</Alert></div>}
        {pickNumber && <NumberChooser item={slot} set={set} taken={taken.msisdns} />}
      </div>
      {line?.vip && <p className="mt-3 text-footnote text-label2">A {line.vip.tier.toLowerCase()} number adds a connection fee of {money(line.vip.feeMinor, w.quote.currency)} to what is paid now{line.vip.etcMultiplierBps > 10000 ? `, and the early-termination charge is ${(line.vip.etcMultiplierBps / 10000).toFixed(2).replace(/\.?0+$/, '')}× if the contract ends early` : ''}.</p>}
    </Card>
  );
}

export const release = (msisdn?: string, token?: string) => { if (msisdn && token) void post('/numbers/release', { msisdn }).catch(() => {}); };

/** Reminder shown under SIM pickers: physical cards are taken from the seller's own stock. */
export function CardNote() { return <p className="mt-4 text-footnote text-label2">A physical card is taken from the selling store’s stock (or the warehouse for a remote sale) when the order is placed; an eSIM profile is issued new.</p>; }

function CardPicker({ place, retail, value, onPick, taken }: { place: string; retail: boolean; value: string; onPick: (iccid: string) => void; taken: Set<string> }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  // cards come from where the sale is made: the selling store's shelf, or the warehouses for a remote sale
  const list = useApi<{ items: any[] }>(retail && !place ? null : `/sims/available?kind=PHYSICAL&limit=${8 + taken.size}&q=${encodeURIComponent(term)}&${retail ? `locationId=${encodeURIComponent(place)}` : 'warehouse=1'}`);
  if (retail && !place) return <Alert tone="info">Choose the selling store first; SIM cards are taken from its stock.</Alert>;
  const free = (list.data?.items ?? []).filter((s) => !taken.has(s.iccid)).slice(0, 8);
  return (
    <div>
      {value && <p className="mb-2 rounded-control bg-surface2 p-3 font-mono text-subhead">{value} <button type="button" className="ml-2 text-accent" onClick={() => onPick('')}>Change</button></p>}
      {!value && (
        <>
          <SearchField label="Scan or type the card number" placeholder="Scan or type the ICCID (the long number on the card)" value={q} onChange={setQ} />
          {!list.data ? <Spinner /> : free.length === 0 ? <p className="mt-2 text-footnote text-label2">{term ? 'No free card starts with that.' : 'There are no more free SIM cards here for this order.'}</p> : (
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {free.map((s) => <li key={s.iccid}><button type="button" onClick={() => onPick(s.iccid)} className="min-h-tap w-full rounded-control bg-surface2 px-3 text-left font-mono text-subhead hover:bg-accent/10">{s.iccid}</button></li>)}
            </ul>
          )}
          {/^89\d{17,18}$/.test(term) && !free.some((s) => s.iccid === term) && (taken.has(term) ? <p className="mt-2 text-footnote text-danger">That card is already chosen for another line of this order.</p> : <Button type="button" variant="secondary" className="mt-2" onClick={() => onPick(term)}>Use {term}</Button>)}
        </>
      )}
    </div>
  );
}

export function NumberChooser({ item, set, taken }: { item: NumberHolder; set: (p: Partial<NumberHolder>) => void; taken?: Set<string> }) {
  const [tier, setTier] = useState('');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const list = useApi<{ items: any[] }>(`/numbers/search?limit=${12 + (taken?.size ?? 0)}&tier=${tier}&contains=${encodeURIComponent(term)}`);
  const offered = (list.data?.items ?? []).filter((n) => !taken?.has(digits(n.msisdn))).slice(0, 12);
  const tiers = useApi<{ tiers: any[] }>('/numbering/tiers');
  const left = useCountdown(item.numberExpires);
  const choose = async (n: any) => {
    setBusy(n.msisdn); setErr(null);
    try {
      if (item.msisdn && item.numberToken) await post('/numbers/release', { msisdn: item.msisdn }).catch(() => {});
      const r = await post<any>('/numbers/reserve', { msisdn: n.msisdn });
      set({ msisdn: r.msisdn, numberToken: r.token, numberTier: r.tier, numberFeeMinor: r.oneTimeFeeMinor, numberExpires: r.expiresAt });
    } catch (e) { setErr((e as Error).message); void list.reload(); } finally { setBusy(null); }
  };
  return (
    <div>
      {item.numberToken ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-control bg-accent/10 p-3">
          <span className="font-mono text-title3">{fmtNumber(item.msisdn)}</span><Badge tone={TIER_TONE[item.numberTier ?? 'STANDARD'] ?? 'neutral'}>{(item.numberTier ?? 'STANDARD').toLowerCase()}</Badge>
          <span className="text-footnote text-label2">{left ? `held for you for ${left}` : 'the hold has run out: choose it again'}</span>
          <button type="button" className="ml-auto text-accent" onClick={async () => { await post('/numbers/release', { msisdn: item.msisdn }).catch(() => {}); set({ msisdn: '', numberToken: '', numberTier: '', numberFeeMinor: 0, numberExpires: '' }); void list.reload(); }}>Choose another</button>
        </div>
      ) : null}
      <div className="mb-2 flex flex-wrap gap-1">
        {[['', 'All'], ...(tiers.data?.tiers ?? []).filter((t) => t.tier !== 'AUCTION' && t.enabled).sort((a, b) => b.sortOrder - a.sortOrder).map((t) => [t.tier, t.label])].map(([v, label]) => (
          <button key={v} type="button" onClick={() => setTier(v as string)} aria-pressed={tier === v} className={`min-h-[36px] rounded-full px-3 text-subhead ${tier === v ? 'bg-accent text-accent-fg' : 'bg-surface2'}`}>{label}</button>
        ))}
      </div>
      <SearchField label="Digits the number should contain" placeholder="Digits it should contain, for example 8888" value={q} onChange={setQ} />
      {err && <div className="mt-2"><Alert>{err}</Alert></div>}
      {!list.data ? <Spinner /> : offered.length === 0 ? <p className="mt-2 text-footnote text-label2">No available number matches.</p> : (
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {offered.map((n) => (
            <li key={n.msisdn}>
              <button type="button" disabled={busy !== null} onClick={() => choose(n)} className={`flex min-h-tap w-full items-center justify-between gap-2 rounded-control border px-3 py-2 text-left ${item.msisdn === n.msisdn ? 'border-accent bg-accent/5' : 'border-separator bg-surface hover:bg-surface2'}`}>
                <span><span className="font-mono text-subhead">{fmtNumber(n.msisdn)}</span><span className="block text-caption text-label2">{n.tierLabel}{n.oneTimeFeeMinor ? ` · ${money(n.oneTimeFeeMinor)} fee` : ''}{n.minMonthlyPlanMinor ? ` · plan ${money(n.minMonthlyPlanMinor)}+/mo` : ''}{n.minContractMonths ? ` · ${n.minContractMonths}-mo contract` : ''}</span></span>
                {busy === n.msisdn ? <Spinner /> : <Badge tone={TIER_TONE[n.tier] ?? 'neutral'}>{n.tier.toLowerCase()}</Badge>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function useCountdown(iso?: string): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!iso) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [iso]);
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return null;
  return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
}
