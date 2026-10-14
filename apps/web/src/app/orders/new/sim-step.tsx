'use client';
import { Alert, Badge, Button, Card, Field, Input, SearchField, Segmented, Spinner } from '@meridian/ui';
import { useEffect, useState } from 'react';
import { post, useApi, useDebounced } from '@/lib/api';
import { money } from '@/lib/format';
import type { Wizard } from './steps';
import type { Item } from './wizard-types';

const TIER_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = { STANDARD: 'neutral', SILVER: 'neutral', GOLD: 'warning', DIAMOND: 'success', AUCTION: 'danger' };
const fmtNumber = (m: string) => m.replace(/^(\+\d{2})(\d{2})(\d+)$/, '$1 $2 $3');

/** Step "SIM and number": for every plan in the basket that needs a SIM, hand over a card (or issue an eSIM) and choose the number. */
export function SimStep({ w, requireSim }: { w: Wizard; requireSim: boolean }) {
  const lines: any[] = w.quote?.lines ?? [];
  const needing = w.items.map((it, k) => ({ it, k })).filter(({ k }) => lines[k]?.needsSim);
  if (!needing.length) return <Alert tone="info">Nothing in this order needs a SIM.</Alert>;
  return (
    <div className="space-y-5">
      {needing.map(({ it, k }) => <PlanSim key={it.key} w={w} item={it} line={lines[k]} requireSim={requireSim} />)}
      {requireSim && <p className="text-footnote text-label2">Your company requires a SIM on every plan. The SIM is held for this order and activated with the service.</p>}
    </div>
  );
}

function PlanSim({ w, item, line, requireSim }: { w: Wizard; item: Item; line: any; requireSim: boolean }) {
  const set = (patch: Partial<Item>) => w.setItems((cur) => cur.map((x) => (x.key === item.key ? { ...x, ...patch } : x)));
  const [simMode, setSimMode] = useState<'NEXT' | 'CARD' | 'ESIM' | 'NONE'>(item.iccid ? 'CARD' : item.simType === 'ESIM' ? 'ESIM' : item.simType === 'PHYSICAL' ? 'NEXT' : requireSim ? 'NEXT' : 'NONE');
  useEffect(() => { if (requireSim && simMode === 'NEXT' && !item.iccid && !item.simType) set({ simType: 'PHYSICAL' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const numMode: 'AUTO' | 'CHOOSE' | 'OWN' = item.numberToken ? 'CHOOSE' : item.msisdn ? 'OWN' : 'AUTO';
  const [pickNumber, setPickNumber] = useState(!!item.numberToken);
  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-2"><h3 className="text-title3 font-semibold">{item.offer.name}</h3>{line?.vip && <Badge tone={TIER_TONE[line.vip.tier] ?? 'neutral'}>{line.vip.tier.toLowerCase()} number</Badge>}</div>

      <h4 className="mb-2 text-subhead font-semibold">SIM</h4>
      <Segmented<'NEXT' | 'CARD' | 'ESIM' | 'NONE'> label="SIM" value={simMode} onChange={(v) => { setSimMode(v); set(v === 'CARD' ? { iccid: '', simType: '' } : v === 'NEXT' ? { iccid: '', simType: 'PHYSICAL' } : v === 'ESIM' ? { iccid: '', simType: 'ESIM' } : { iccid: '', simType: '' }); }}
        options={[{ value: 'NEXT' as const, label: 'Next free card' }, { value: 'CARD' as const, label: 'A specific card' }, { value: 'ESIM' as const, label: 'eSIM' }, ...(requireSim ? [] : [{ value: 'NONE' as const, label: 'Later' }])]} />
      <div className="mt-3">
        {simMode === 'NEXT' && <p className="text-subhead text-label2">The next free SIM card {w.fixedStore ? `at your store (${w.fixedStore})` : 'in the warehouse'} is taken when the order is placed.</p>}
        {simMode === 'ESIM' && <p className="text-subhead text-label2">A new eSIM profile is issued; the customer scans its activation code on the device.</p>}
        {simMode === 'NONE' && <p className="text-subhead text-label2">No SIM now. It can be added when the service is set up.</p>}
        {simMode === 'CARD' && <CardPicker value={item.iccid ?? ''} onPick={(iccid) => set({ iccid, simType: iccid ? 'PHYSICAL' : '' })} />}
      </div>

      <h4 className="mb-2 mt-5 text-subhead font-semibold">Number</h4>
      <Segmented label="Number" value={pickNumber ? 'CHOOSE' : numMode === 'OWN' ? 'OWN' : 'AUTO'} onChange={(v) => { setPickNumber(v === 'CHOOSE'); if (v !== 'CHOOSE') release(item.msisdn, item.numberToken); set({ msisdn: '', numberToken: '', numberTier: '', numberFeeMinor: 0, numberExpires: '' }); }}
        options={[{ value: 'AUTO', label: 'Assign one' }, { value: 'CHOOSE', label: 'Choose a number' }, { value: 'OWN', label: 'Bring their own' }]} />
      <div className="mt-3">
        {!pickNumber && numMode !== 'OWN' && <p className="text-subhead text-label2">A standard number is assigned from the pool.</p>}
        {numMode === 'OWN' && !pickNumber && <Field label="Number to port in" hint="With the country code, for example +6591234567"><Input value={item.msisdn} onChange={(e) => set({ msisdn: e.target.value.replace(/[^\d+]/g, '') })} inputMode="tel" /></Field>}
        {pickNumber && <NumberChooser item={item} set={set} />}
      </div>
      {line?.vip && <p className="mt-3 text-footnote text-label2">A {line.vip.tier.toLowerCase()} number adds a connection fee of {money(line.vip.feeMinor, w.quote.currency)} to what is paid now{line.vip.etcMultiplierBps > 10000 ? `, and the early-termination charge is ${(line.vip.etcMultiplierBps / 10000).toFixed(2).replace(/\.?0+$/, '')}× if the contract ends early` : ''}.</p>}
    </Card>
  );
}

const release = (msisdn?: string, token?: string) => { if (msisdn && token) void post('/numbers/release', { msisdn }).catch(() => {}); };

function CardPicker({ value, onPick }: { value: string; onPick: (iccid: string) => void }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const list = useApi<{ items: any[] }>(`/sims/available?kind=PHYSICAL&limit=8&q=${encodeURIComponent(term)}`);
  return (
    <div>
      {value && <p className="mb-2 rounded-control bg-surface2 p-3 font-mono text-subhead">{value} <button type="button" className="ml-2 text-accent" onClick={() => onPick('')}>Change</button></p>}
      {!value && (
        <>
          <SearchField label="Scan or type the card number" placeholder="Scan or type the ICCID (the long number on the card)" value={q} onChange={setQ} />
          {!list.data ? <Spinner /> : list.data.items.length === 0 ? <p className="mt-2 text-footnote text-label2">{term ? 'No free card starts with that.' : 'There are no free SIM cards here.'}</p> : (
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {list.data.items.map((s) => <li key={s.iccid}><button type="button" onClick={() => onPick(s.iccid)} className="min-h-tap w-full rounded-control bg-surface2 px-3 text-left font-mono text-subhead hover:bg-accent/10">{s.iccid}</button></li>)}
            </ul>
          )}
          {/^89\d{17,18}$/.test(term) && !list.data?.items.some((s) => s.iccid === term) && <Button type="button" variant="secondary" className="mt-2" onClick={() => onPick(term)}>Use {term}</Button>}
        </>
      )}
    </div>
  );
}

function NumberChooser({ item, set }: { item: Item; set: (p: Partial<Item>) => void }) {
  const [tier, setTier] = useState('');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const list = useApi<{ items: any[] }>(`/numbers/search?limit=12&tier=${tier}&contains=${encodeURIComponent(term)}`);
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
      {!list.data ? <Spinner /> : list.data.items.length === 0 ? <p className="mt-2 text-footnote text-label2">No available number matches.</p> : (
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {list.data.items.map((n) => (
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
