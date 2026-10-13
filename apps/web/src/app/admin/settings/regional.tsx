'use client';
import { CURRENCIES, currencyInfo, DATE_FORMATS, formatDate, formatDateTime, formatMoney, regionalProblems, type RegionalSettings } from '@meridian/types';
import { Alert, Button, Card, Field, Input, SectionTitle, Select } from '@meridian/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { post, useAction } from '@/lib/api';

const THOUSANDS: Array<[string, string]> = [[',', 'Comma  1,234'], ['.', 'Dot  1.234'], [' ', 'Space  1 234'], ["'", "Apostrophe  1'234"], ['’', 'Right quote  1’234'], ['', 'None  1234']];
const zones = (): string[] => {
  try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { return ['UTC', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Manila', 'Europe/London', 'America/New_York']; }
};

export function RegionalSettingsForm({ initial, locked, onSaved }: { initial: RegionalSettings; locked: boolean; onSaved: () => void }) {
  const router = useRouter();
  const [f, setF] = useState<RegionalSettings>(initial);
  const act = useAction();
  const set = <K extends keyof RegionalSettings>(k: K, v: RegionalSettings[K]) => setF((s) => ({ ...s, [k]: v }));
  const tz = useMemo(zones, []);
  const problems = regionalProblems(f);
  const pickCurrency = (code: string) => {
    const c = currencyInfo(code);
    if (c) setF((s) => ({ ...s, currency: code, symbol: c.symbol, exponent: c.exponent, decimals: c.exponent }));
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { exponent: _ignored, ...body } = f;
    const r = await act.run(() => post('/settings/regional', body), 'Regional settings saved.');
    if (r) { onSaved(); router.refresh(); }
  };
  const now = new Date();

  return (
    <form onSubmit={submit} className="space-y-5">
      <Card>
        <SectionTitle>Currency</SectionTitle>
        {locked && <div className="mb-4"><Alert tone="info">Orders, invoices or payments already exist, so the currency is fixed at {initial.currency}. You can still change how amounts are written below.</Alert></div>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Currency" hint="Every currency in circulation (ISO 4217). Sets the symbol and the number of decimals as a starting point.">
            <Select value={f.currency} onChange={(e) => pickCurrency(e.target.value)} disabled={locked}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name} ({c.symbol})</option>)}
            </Select>
          </Field>
          <Field label="Symbol" hint="What appears next to amounts. Use the code (e.g. MYR) if you prefer.">
            <Input value={f.symbol} onChange={(e) => set('symbol', e.target.value)} maxLength={6} required />
          </Field>
          <fieldset>
            <legend className="mb-1 text-subhead font-medium">Symbol position</legend>
            <div className="flex gap-6">
              {(['before', 'after'] as const).map((p) => (
                <label key={p} className="flex min-h-tap items-center gap-2"><input type="radio" name="pos" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={f.symbolPosition === p} onChange={() => set('symbolPosition', p)} />{p === 'before' ? 'In front of the number' : 'Behind the number'}</label>
              ))}
            </div>
          </fieldset>
          <label className="flex min-h-tap items-center gap-3 self-end"><input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={f.symbolSpacing} onChange={(e) => set('symbolSpacing', e.target.checked)} />Space between symbol and number</label>
        </div>
      </Card>

      <Card>
        <SectionTitle>Number format</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Thousand separator"><Select value={f.thousandSeparator} onChange={(e) => set('thousandSeparator', e.target.value)}>{THOUSANDS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}</Select></Field>
          <Field label="Decimal separator"><Select value={f.decimalSeparator} onChange={(e) => set('decimalSeparator', e.target.value)}><option value=".">Dot  12.50</option><option value=",">Comma  12,50</option></Select></Field>
          <Field label="Decimal places" hint={`${f.currency} has ${f.exponent} minor-unit digit${f.exponent === 1 ? '' : 's'}.`}>
            <Input type="number" min={0} max={f.exponent} value={f.decimals} onChange={(e) => set('decimals', Number(e.target.value))} />
          </Field>
          <Field label="Digit grouping"><Select value={f.grouping} onChange={(e) => set('grouping', e.target.value as RegionalSettings['grouping'])}><option value="standard">Thousands  1,234,567</option><option value="indian">Lakhs / crores  12,34,567</option></Select></Field>
        </div>
        <div className="mt-4 rounded-control bg-surface2 p-4" aria-live="polite">
          <p className="text-footnote text-label2">Preview</p>
          <p className="text-title2 font-semibold tabular-nums">{formatMoney(123456789, f)}</p>
          <p className="text-subhead text-label2 tabular-nums">{formatMoney(1999, f)} · {formatMoney(-50, f)} · {formatMoney(0, f)}</p>
        </div>
      </Card>

      <Card>
        <SectionTitle>Dates, time and tax</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date format"><Select value={f.dateFormat} onChange={(e) => set('dateFormat', e.target.value as RegionalSettings['dateFormat'])}>{DATE_FORMATS.map((x) => <option key={x} value={x}>{x}  ({formatDate(now, { ...f, dateFormat: x })})</option>)}</Select></Field>
          <Field label="Time format"><Select value={f.timeFormat} onChange={(e) => set('timeFormat', e.target.value as '12h' | '24h')}><option value="24h">24-hour  14:30</option><option value="12h">12-hour  2:30 pm</option></Select></Field>
          <Field label="Time zone" hint={`Now: ${formatDateTime(now, f)}`}><Select value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>{(tz.includes(f.timezone) ? tz : [f.timezone, ...tz]).map((z) => <option key={z} value={z}>{z}</option>)}</Select></Field>
          <Field label="Week starts on"><Select value={String(f.weekStart)} onChange={(e) => set('weekStart', Number(e.target.value) as 0 | 1 | 6)}><option value="1">Monday</option><option value="0">Sunday</option><option value="6">Saturday</option></Select></Field>
          <Field label="Country" hint="Two-letter code, e.g. SG"><Input value={f.country} onChange={(e) => set('country', e.target.value.toUpperCase().slice(0, 2))} maxLength={2} required /></Field>
          <Field label="Phone dial code" hint="Prefix for newly issued numbers, e.g. +65"><Input value={f.dialCode} onChange={(e) => set('dialCode', e.target.value)} maxLength={5} required /></Field>
          <Field label="Tax name" hint="GST, VAT, SST…"><Input value={f.taxName} onChange={(e) => set('taxName', e.target.value)} maxLength={20} required /></Field>
          <Field label="Tax rate (%)"><Input type="number" min={0} max={100} step="0.01" value={f.taxBps / 100} onChange={(e) => set('taxBps', Math.round(Number(e.target.value) * 100))} /></Field>
        </div>
      </Card>

      {problems.length > 0 && <Alert>{problems.join(' ')}</Alert>}
      {act.error && <Alert>{act.error}</Alert>}
      {act.ok && <Alert tone="success">{act.ok}</Alert>}
      <Button type="submit" disabled={act.busy || problems.length > 0}>{act.busy ? 'Saving…' : 'Save regional settings'}</Button>
    </form>
  );
}
