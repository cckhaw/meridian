'use client';
import { Alert, Badge, Button, Card, Field, Input, SectionTitle, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';

interface Mk { code: string; name: string; dialCode: string; taxName: string; taxBps: number }
interface View { multiple: boolean; defaultMarket: string; markets: Mk[]; home: string; known: Mk[] }

/** Settings → Markets: one market for the whole CRM (the default), or several countries, each with its own tax and dial code and one of them the default. */
export function MarketSettings() {
  const { data, error, reload } = useApi<View>('/settings/markets');
  const [pick, setPick] = useState<boolean | null>(null);
  const [list, setList] = useState<Mk[] | null>(null);
  const [dflt, setDflt] = useState<string | null>(null);
  const save = useAction(reload);
  const [add, setAdd] = useState('');
  const [custom, setCustom] = useState<Mk>({ code: '', name: '', dialCode: '', taxName: 'VAT', taxBps: 0 });
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const multiple = pick ?? data.multiple;
  const markets = list ?? data.markets;
  const defaultMarket = markets.some((m) => m.code === (dflt ?? data.defaultMarket)) ? (dflt ?? data.defaultMarket) : data.home;
  const home = markets.find((m) => m.code === data.home)?.name ?? data.home;
  const dirty = pick !== null && pick !== data.multiple || list !== null || dflt !== null;
  const edit = (code: string, patch: Partial<Mk>) => setList(markets.map((m) => (m.code === code ? { ...m, ...patch } : m)));
  const remove = (code: string) => { setList(markets.filter((m) => m.code !== code)); if (defaultMarket === code) setDflt(data.home); };
  const available = data.known.filter((k) => !markets.some((m) => m.code === k.code));
  const addKnown = () => { const k = data.known.find((x) => x.code === add); if (k) { setList([...markets, k]); setAdd(''); } };
  const addCustom = () => { const c = { ...custom, code: custom.code.trim().toUpperCase() }; if (!/^[A-Z]{2}$/.test(c.code) || markets.some((m) => m.code === c.code)) return; setList([...markets, c]); setCustom({ code: '', name: '', dialCode: '', taxName: 'VAT', taxBps: 0 }); };
  const choice = (value: boolean, title: string, body: string) => (
    <label className={`flex min-h-tap cursor-pointer items-start gap-3 rounded-control border p-3 ${multiple === value ? 'border-accent bg-accent/10' : 'border-separator bg-surface'}`}>
      <input type="radio" name="markets" className="mt-1 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={multiple === value} onChange={() => setPick(value)} />
      <span><span className="font-medium">{title}</span><span className="block text-footnote text-label2">{body}</span></span>
    </label>
  );
  return (
    <Card>
      <SectionTitle>Markets</SectionTitle>
      <p className="-mt-2 mb-4 text-subhead text-label2">A market is a country you sell in. Your own country is set under Regional format (currently <strong>{home}</strong>), together with the currency and tax. Prices stay in that one currency either way.</p>
      <div className="grid gap-2">
        {choice(false, `One market (${home})`, 'The whole CRM works in your own country. Offers, logins, stores and customers are not tied to a market, nothing asks for one, and every offer is available everywhere you sell.')}
        {choice(true, 'Several markets', 'Each offer says which markets it is sold in, each login and store belongs to a market, and a customer’s market decides which offers they can buy and which tax applies.')}
      </div>
      {multiple && (
        <div className="mt-5 space-y-4">
          <div className="max-w-xs"><Field label="Default market" hint="Used for new logins, offers, customers and store-front sales when nobody picks a market."><Select value={defaultMarket} onChange={(e) => setDflt(e.target.value)}>{markets.map((m) => <option key={m.code} value={m.code}>{m.name} ({m.code})</option>)}</Select></Field></div>
          <div>
            <h3 className="mb-2 text-subhead font-medium">Markets you sell in</h3>
            <ul className="space-y-2">
              {markets.map((m) => {
                const isHome = m.code === data.home;
                return (
                  <li key={m.code} className="rounded-control border border-separator bg-surface p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2"><span className="font-medium">{m.code}</span>{isHome && <Badge tone="neutral">Your country</Badge>}{m.code === defaultMarket && <Badge tone="success">Default</Badge>}
                      <span className="flex-1" />
                      {!isHome && <Button type="button" variant="secondary" aria-label={`Remove ${m.name}`} onClick={() => remove(m.code)}>Remove</Button>}</div>
                    <div className="grid gap-3 sm:grid-cols-4">
                      <Field label="Name"><Input value={m.name} onChange={(e) => edit(m.code, { name: e.target.value })} /></Field>
                      <Field label="Tax name" hint={isHome ? 'Set in Regional format' : undefined}><Input value={isHome ? data.markets.find((x) => x.code === m.code)?.taxName ?? m.taxName : m.taxName} disabled={isHome} onChange={(e) => edit(m.code, { taxName: e.target.value })} /></Field>
                      <Field label="Tax rate (%)" hint={isHome ? 'Set in Regional format' : undefined}><Input type="number" min={0} max={100} step={0.01} value={m.taxBps / 100} disabled={isHome} onChange={(e) => edit(m.code, { taxBps: Math.round(Number(e.target.value) * 100) })} /></Field>
                      <Field label="Dial code" hint={isHome ? 'Set in Regional format' : undefined}><Input value={m.dialCode} disabled={isHome} onChange={(e) => edit(m.code, { dialCode: e.target.value })} /></Field>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="rounded-control bg-surface2 p-3">
            <h3 className="mb-2 text-subhead font-medium">Add a market</h3>
            {available.length > 0 && (
              <div className="mb-3 flex flex-wrap items-end gap-2">
                <div className="min-w-48"><Field label="From the list"><Select value={add} onChange={(e) => setAdd(e.target.value)}><option value="">Choose a country…</option>{available.map((k) => <option key={k.code} value={k.code}>{k.name} ({k.code})</option>)}</Select></Field></div>
                <Button type="button" variant="secondary" disabled={!add} onClick={addKnown}>Add</Button>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-6">
              <Field label="Code" hint="Two letters"><Input maxLength={2} value={custom.code} onChange={(e) => setCustom({ ...custom, code: e.target.value.toUpperCase() })} /></Field>
              <div className="sm:col-span-2"><Field label="Name"><Input value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} /></Field></div>
              <Field label="Tax name"><Input value={custom.taxName} onChange={(e) => setCustom({ ...custom, taxName: e.target.value })} /></Field>
              <Field label="Tax rate (%)"><Input type="number" min={0} max={100} step={0.01} value={custom.taxBps / 100} onChange={(e) => setCustom({ ...custom, taxBps: Math.round(Number(e.target.value) * 100) })} /></Field>
              <Field label="Dial code"><Input placeholder="+81" value={custom.dialCode} onChange={(e) => setCustom({ ...custom, dialCode: e.target.value })} /></Field>
            </div>
            <div className="mt-3"><Button type="button" variant="secondary" disabled={!/^[A-Za-z]{2}$/.test(custom.code) || !custom.name.trim() || !/^\+\d{1,4}$/.test(custom.dialCode.trim()) || markets.some((m) => m.code === custom.code.toUpperCase())} onClick={addCustom}>Add this market</Button></div>
          </div>
          <p className="text-footnote text-label2">A market that offers, logins, customers or stores still use cannot be removed; move them to another market first.</p>
        </div>
      )}
      <p className="mt-4 text-footnote text-label2">Switching changes how things are shown and checked from now on; nothing is deleted. Offers, logins and customers keep the market they already have.</p>
      {save.error && <div className="mt-3"><Alert>{save.error}</Alert></div>}{save.ok && !dirty && <div className="mt-3"><Alert tone="success">{save.ok}</Alert></div>}
      <div className="mt-4 flex gap-2">
        <Button disabled={!dirty || save.busy} onClick={async () => { const r = await save.run(() => post('/settings/markets', { multiple, defaultMarket, markets }), 'Saved'); if (r) { setPick(null); setList(null); setDflt(null); } }}>{save.busy ? 'Saving…' : 'Save'}</Button>
        {dirty && <Button variant="secondary" onClick={() => { setPick(null); setList(null); setDflt(null); }}>Discard</Button>}
      </div>
    </Card>
  );
}
