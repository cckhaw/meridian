'use client';
import { Alert, Button, Field, Input, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { useRegional } from '@/components/settings-provider';
import { useApi } from '@/lib/api';
import { useSegments } from '@/lib/segments';
import { emptyIdentity, IdentityFields, identityPayload, MethodChoice, MyDigitalIdRun, useCrmMydigitalId, type IdentityState, type KycMethod } from '@/components/identity-capture';
import { post } from '@/lib/api';

/** Two-letter country codes offered in the country list (named with the browser's own country names). */
const COUNTRIES = ['SG', 'MY', 'ID', 'TH', 'VN', 'PH', 'BN', 'KH', 'LA', 'MM', 'CN', 'HK', 'TW', 'JP', 'KR', 'IN', 'LK', 'BD', 'PK', 'AU', 'NZ', 'AE', 'SA', 'QA', 'GB', 'IE', 'FR', 'DE', 'NL', 'ES', 'IT', 'CH', 'SE', 'NO', 'DK', 'US', 'CA', 'MX', 'BR', 'ZA', 'EG', 'NG', 'KE'];
const countryName = (c: string) => { try { return new Intl.DisplayNames(undefined, { type: 'region' }).of(c) ?? c; } catch { return c; } };
const GENDERS = [['FEMALE', 'Female'], ['MALE', 'Male'], ['OTHER', 'Other'], ['UNDISCLOSED', 'Prefer not to say']] as const;

export interface CustomerFormValues { segment: string; displayName: string; idDocument: string; email: string; phone: string; dateOfBirth: string; gender: string; line1: string; line2: string; postcode: string; city: string; state: string; country: string; billCycle: string }

/**
 * The new-customer form, shared by the Customers screen and the order wizard. Which details appear, and which are required, comes from Settings → Customers;
 * the bill cycles in the list come from Settings → Bill cycles.
 */
export function CustomerForm({ submitLabel, busy, error, initial, context, onSubmit, onConfirmed }: { submitLabel: string; busy: boolean; error: string | null; initial?: Partial<CustomerFormValues>; context?: 'order'; onSubmit: (body: Record<string, unknown>) => void; onConfirmed?: (customerId: string) => void }) {
  const segs = useSegments();
  const regional = useRegional();
  const meta = useApi<any>('/meta');
  const fields = meta.data?.customers?.fields ?? {};
  const cycles = meta.data?.billCycles as { days: number[]; defaultCycle: number; defaultDay: number; defaultMode: string } | undefined;
  const [f, setF] = useState<CustomerFormValues>({ segment: '', displayName: '', idDocument: '', email: '', phone: '', dateOfBirth: '', gender: '', line1: '', line2: '', postcode: '', city: '', state: '', country: '', billCycle: '', ...initial });
  const [idn, setIdn] = useState<IdentityState>(emptyIdentity());
  const [problem, setProblem] = useState('');
  const mdid = useCrmMydigitalId();
  const [method, setMethod] = useState<KycMethod>('photos');
  const set = (k: keyof CustomerFormValues) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const show = (k: string) => (fields[k] ?? 'optional') !== 'hidden';
  const req = (k: string) => fields[k] === 'required';
  const cycle = f.billCycle || String(cycles?.defaultDay ?? 1);
  const country = f.country || (show('country') ? regional?.country ?? '' : '');
  const today = new Date().toISOString().slice(0, 10);

  if (meta.error) return <Alert>{meta.error}</Alert>;
  if (!meta.data) return <Spinner />; // the settings decide which details appear, so wait for them rather than show fields that then vanish

  const segmentId = f.segment || segs.list[0]?.id || '';
  const individual = segs.individual(segmentId);
  const dobShown = show('dateOfBirth');
  const details = (extra: Record<string, unknown>) => ({
    ...extra, segment: f.segment || segs.list[0]?.id, displayName: f.displayName, idDocument: f.idDocument,
    email: f.email || undefined, phone: f.phone || undefined, dateOfBirth: f.dateOfBirth || undefined, gender: f.gender || undefined,
    address: { line1: f.line1, line2: f.line2, postcode: f.postcode, city: f.city, state: f.state, country },
    account: { billCycleDay: Number(cycle) },
  });
  const useMdid = mdid.available && individual && !!onConfirmed && method === 'mydigitalid';
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (useMdid) return;
    // No customer without an identity check: the ID details and live photographs travel with the customer.
    const p = identityPayload(idn, individual, { dobKnown: dobShown && !!f.dateOfBirth });
    if ('missing' in p) { setProblem(p.missing); return; }
    setProblem('');
    onSubmit(details({ identity: { ...p.identity, dateOfBirth: (dobShown ? f.dateOfBirth : idn.dateOfBirth) || undefined } }));
  };
  // With MyDigital ID nothing is created until the customer approves; the form waits on the server and the customer appears when it is confirmed.
  const startMdid = async () => {
    if (!f.displayName.trim() || f.idDocument.trim().length < 3) throw new Error('Enter the name and the ID number first.');
    if (!(dobShown ? f.dateOfBirth : idn.dateOfBirth)) throw new Error('Enter the date of birth as it is on the ID.');
    return post('/kyc/mydigitalid/customer', details({ identity: { idType: idn.idType, idExpiry: idn.idExpiry || undefined, nationality: idn.nationality || undefined, dateOfBirth: (dobShown ? f.dateOfBirth : idn.dateOfBirth) || undefined }, context }));
  };
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Segment"><Select value={f.segment} onChange={set('segment')}>{segs.list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
      <Field label="Full name / Company name"><Input required value={f.displayName} onChange={set('displayName')} /></Field>
      <Field label="ID document (NRIC / passport / business registration)" hint="Stored masked; a keyed hash detects duplicates."><Input required minLength={3} value={f.idDocument} onChange={set('idDocument')} /></Field>
      <Field label="Bill cycle" hint={cycles?.defaultMode === 'NEXT' ? 'The day of the month the bill is raised. Starts at the next bill cycle date after today.' : cycles?.defaultMode === 'PREVIOUS' ? 'The day of the month the bill is raised. Starts at the previous bill cycle date before today.' : 'The day of the month the bill is raised.'}><Select value={cycle} onChange={set('billCycle')}>
        {(cycles?.days ?? Array.from({ length: 28 }, (_, i) => i + 1)).map((d) => <option key={d} value={d}>Day {d}</option>)}</Select></Field>
      {show('email') && <Field label="E-mail"><Input type="email" required={req('email')} value={f.email} onChange={set('email')} /></Field>}
      {show('phone') && <Field label="Phone"><Input type="tel" required={req('phone')} value={f.phone} onChange={set('phone')} /></Field>}
      {show('dateOfBirth') && <Field label="Date of birth" hint="Needed for the identity check."><Input type="date" max={today} min="1900-01-01" required value={f.dateOfBirth} onChange={set('dateOfBirth')} /></Field>}
      {show('gender') && <Field label="Gender"><Select required={req('gender')} value={f.gender} onChange={set('gender')}><option value="">{req('gender') ? 'Choose…' : 'Not stated'}</option>{GENDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>}
      {show('address') && (
        <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
          <Field label="Address"><Input autoComplete="address-line1" required={req('address')} value={f.line1} onChange={set('line1')} /></Field>
          <Field label="Address line 2"><Input autoComplete="address-line2" value={f.line2} onChange={set('line2')} /></Field>
        </div>
      )}
      {show('postcode') && <Field label="Postcode"><Input autoComplete="postal-code" required={req('postcode')} value={f.postcode} onChange={set('postcode')} /></Field>}
      {show('city') && <Field label="City"><Input autoComplete="address-level2" required={req('city')} value={f.city} onChange={set('city')} /></Field>}
      {show('state') && <Field label="State or region"><Input autoComplete="address-level1" required={req('state')} value={f.state} onChange={set('state')} /></Field>}
      {show('country') && <Field label="Country"><Select required={req('country')} value={country} onChange={set('country')}><option value="">Choose…</option>{[...new Set([...(country && !COUNTRIES.includes(country) ? [country] : []), ...COUNTRIES])].map((c) => <option key={c} value={c}>{countryName(c)}</option>)}</Select></Field>}
      {mdid.available && individual && onConfirmed && <MethodChoice value={method} onChange={setMethod} label={mdid.label} disabled={busy} />}
      <IdentityFields state={idn} onChange={setIdn} individual={individual} hideDob={dobShown} disabled={busy} hidePhotos={useMdid} />
      {(problem || error) && <div className="sm:col-span-2"><Alert>{problem || error}</Alert></div>}
      {useMdid
        ? <MyDigitalIdRun label={mdid.label} disabled={busy} submitLabel={`Verify with ${mdid.label} and create`} start={startMdid} onDone={(r) => r.customerId && onConfirmed!(r.customerId)} />
        : <div className="sm:col-span-2"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : submitLabel}</Button></div>}
    </form>
  );
}
