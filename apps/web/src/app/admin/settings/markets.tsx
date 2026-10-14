'use client';
import { Alert, Button, Card, SectionTitle, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';

/** Settings → Markets: one market for the whole CRM (the default), or several countries each with their own offers, logins and customers. */
export function MarketSettings() {
  const { data, error, reload } = useApi<{ multiple: boolean; home: string; markets: Record<string, { name: string; dialCode: string; taxName: string; taxBps: number }> }>('/settings/markets');
  const [pick, setPick] = useState<boolean | null>(null);
  const save = useAction(reload);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const multiple = pick ?? data.multiple;
  const home = data.markets[data.home]?.name ?? data.home;
  const choice = (value: boolean, title: string, body: string) => (
    <label className={`flex min-h-tap cursor-pointer items-start gap-3 rounded-control border p-3 ${multiple === value ? 'border-accent bg-accent/10' : 'border-separator bg-surface'}`}>
      <input type="radio" name="markets" className="mt-1 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={multiple === value} onChange={() => setPick(value)} />
      <span><span className="font-medium">{title}</span><span className="block text-footnote text-label2">{body}</span></span>
    </label>
  );
  return (
    <Card>
      <SectionTitle>Markets</SectionTitle>
      <p className="-mt-2 mb-4 text-subhead text-label2">A market is a country you sell in. Your own country is set under Regional (currently <strong>{home}</strong>), together with the currency and tax. Prices stay in that one currency either way.</p>
      <div className="grid gap-2">
        {choice(false, `One market (${home})`, 'The whole CRM works in your own country. Offers, logins, stores and customers are not tied to a market, nothing asks for one, and every offer is available everywhere you sell.')}
        {choice(true, 'Several markets', 'Each offer says which markets it is sold in, each login and store belongs to a market, and a customer’s market decides which offers they can buy and which tax applies.')}
      </div>
      {multiple && (
        <div className="mt-4 rounded-control bg-surface2 p-3 text-footnote text-label2">
          Markets available: {Object.values(data.markets).map((m) => `${m.name} (${m.taxName} ${(m.taxBps / 100).toFixed(m.taxBps % 100 ? 1 : 0)}%, ${m.dialCode})`).join(' · ')}. {home} uses the tax and dial code from Regional.
        </div>
      )}
      <p className="mt-4 text-footnote text-label2">Switching changes how things are shown and checked from now on; nothing is deleted. Offers, logins and customers keep the market they already have, so switching back to several markets brings those limits back.</p>
      {save.error && <div className="mt-3"><Alert>{save.error}</Alert></div>}{save.ok && pick === null && <div className="mt-3"><Alert tone="success">{save.ok}</Alert></div>}
      <div className="mt-4"><Button disabled={pick === null || pick === data.multiple || save.busy} onClick={async () => { const r = await save.run(() => post('/settings/markets', { multiple }), 'Saved'); if (r) setPick(null); }}>{save.busy ? 'Saving…' : 'Save'}</Button></div>
    </Card>
  );
}
