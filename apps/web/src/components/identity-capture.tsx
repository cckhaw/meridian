'use client';
import { Alert, Button, Field, IdCamera, Input, Select, type CapturedPhoto } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction } from '@/lib/api';

/**
 * The identity check as the CRM asks for it: the ID details, and the photographs taken live with the device camera. There is no way to choose a picture
 * from the gallery. The same fields serve a new customer (inside the customer form) and an existing customer who has no verified identity yet.
 */
export const ID_TYPES = [['NATIONAL_ID', 'National ID card'], ['PASSPORT', 'Passport'], ['DRIVING_LICENCE', 'Driving licence'], ['RESIDENCE_PERMIT', 'Residence permit']] as const;
export type ShotKind = 'ID_FRONT' | 'ID_BACK' | 'SELFIE' | 'COMPANY_REGISTRATION';
export interface IdentityState { idType: string; idExpiry: string; nationality: string; dateOfBirth: string; shots: Partial<Record<ShotKind, CapturedPhoto>> }
export const emptyIdentity = (): IdentityState => ({ idType: 'NATIONAL_ID', idExpiry: '', nationality: '', dateOfBirth: '', shots: {} });

/** What has to be photographed for this kind of customer and ID. */
export function neededShots(individual: boolean, idType: string): Array<{ kind: ShotKind; label: string; hint: string; facing: 'environment' | 'user'; frame: 'card' | 'face' | 'page' }> {
  const id = idType === 'PASSPORT'
    ? [{ kind: 'ID_FRONT' as const, label: 'Passport photo page', hint: 'The page with the photo and the number.', facing: 'environment' as const, frame: 'page' as const }]
    : [{ kind: 'ID_FRONT' as const, label: 'ID, front', hint: 'The side with the photo.', facing: 'environment' as const, frame: 'card' as const }, { kind: 'ID_BACK' as const, label: 'ID, back', hint: 'The other side.', facing: 'environment' as const, frame: 'card' as const }];
  return individual
    ? [...id, { kind: 'SELFIE', label: 'Selfie', hint: 'The customer’s face, in good light.', facing: 'user', frame: 'face' }]
    : [{ kind: 'COMPANY_REGISTRATION', label: 'Company registration certificate', hint: 'The whole page, readable.', facing: 'environment', frame: 'page' }, ...id.map((s) => ({ ...s, label: `Signatory’s ${s.label.toLowerCase().replace('passport photo page', 'passport')}` }))];
}

const FRESH_MS = 12 * 60_000;
export const staleShots = (s: IdentityState): ShotKind[] => (Object.entries(s.shots) as Array<[ShotKind, CapturedPhoto]>).filter(([, p]) => Date.now() - Date.parse(p.capture.at) > FRESH_MS).map(([k]) => k);

/** The request body part, or the first thing that is missing. */
export function identityPayload(s: IdentityState, individual: boolean, o: { dobKnown?: boolean } = {}): { identity: Record<string, unknown> } | { missing: string } {
  const need = neededShots(individual, s.idType);
  const lacking = need.find((n) => !s.shots[n.kind]);
  if (lacking) return { missing: `Take the photo: ${lacking.label}.` };
  if (!o.dobKnown && !s.dateOfBirth) return { missing: 'Enter the date of birth as it is on the ID.' };
  if ((s.idType === 'PASSPORT' || s.idType === 'RESIDENCE_PERMIT') && !s.idExpiry) return { missing: 'Enter the expiry date of the passport or permit.' };
  const old = staleShots(s);
  if (old.length) return { missing: 'A photo was taken more than ten minutes ago. Take it again.' };
  return { identity: {
    idType: s.idType, idExpiry: s.idExpiry || undefined, nationality: s.nationality || undefined, dateOfBirth: s.dateOfBirth || undefined,
    documents: need.map((n) => ({ kind: n.kind, dataBase64: s.shots[n.kind]!.dataBase64, capture: s.shots[n.kind]!.capture })),
  } };
}

/** The fields: ID type, expiry, date of birth (when the customer form does not already ask), and the photograph tiles. */
export function IdentityFields({ state, onChange, individual, hideDob, disabled, onFile }: { state: IdentityState; onChange: (s: IdentityState) => void; individual: boolean; hideDob?: boolean; disabled?: boolean; onFile?: Partial<Record<ShotKind, boolean>> }) {
  const need = neededShots(individual, state.idType);
  const set = (k: keyof Omit<IdentityState, 'shots'>) => (e: { target: { value: string } }) => onChange({ ...state, [k]: e.target.value });
  const today = new Date().toISOString().slice(0, 10);
  const stale = new Set(staleShots(state));
  return (
    <fieldset className="grid gap-4 sm:col-span-2 sm:grid-cols-2" disabled={disabled}>
      <legend className="mb-1 text-headline font-semibold">Identity check</legend>
      <p className="text-footnote text-label2 sm:col-span-2">The photographs are taken with the camera now; a picture cannot be chosen from the gallery. They go to the secure document store and a compliance officer reviews them.</p>
      <Field label={individual ? 'Type of ID' : 'Signatory’s type of ID'}><Select value={state.idType} onChange={(e) => onChange({ ...state, idType: e.target.value, shots: e.target.value === 'PASSPORT' ? { ...state.shots, ID_BACK: undefined } : state.shots })}>{ID_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
      <Field label="ID expiry date" hint={state.idType === 'PASSPORT' || state.idType === 'RESIDENCE_PERMIT' ? 'Required for this type of ID.' : 'If the ID has one.'}><Input type="date" min={today} value={state.idExpiry} onChange={set('idExpiry')} required={state.idType === 'PASSPORT' || state.idType === 'RESIDENCE_PERMIT'} /></Field>
      {!hideDob && <Field label="Date of birth" hint="As it is on the ID. Checked against the minimum age."><Input type="date" max={today} min="1900-01-01" value={state.dateOfBirth} onChange={set('dateOfBirth')} required /></Field>}
      <Field label="Nationality" hint="Optional."><Input value={state.nationality} onChange={set('nationality')} maxLength={60} /></Field>
      <div className="grid gap-3 sm:col-span-2">
        {need.map((n) => (
          <div key={n.kind}>
            <IdCamera label={n.label} hint={n.hint} facing={n.facing} frame={n.frame} disabled={disabled} done={!!onFile?.[n.kind]} value={state.shots[n.kind] ?? null} onChange={(p) => onChange({ ...state, shots: { ...state.shots, [n.kind]: p ?? undefined } })} />
            {stale.has(n.kind) && <p className="mt-1 text-footnote text-danger">Taken too long ago: take it again.</p>}
          </div>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Starts the identity check of a customer who has none (an older record) or whose check was sent back. The ID number is typed again: the customer record keeps
 * only a masked copy and a code, and the number must match it.
 */
export function VerifyIdentity({ customerId, individual, dobKnown, context, previous, onFile, onSubmitted }: {
  customerId: string; individual: boolean; dobKnown: boolean; context: 'order' | 'customer'; previous?: string | null; onFile?: Partial<Record<ShotKind, boolean>>; onSubmitted: () => void;
}) {
  const [s, setS] = useState<IdentityState>(emptyIdentity());
  const [idNumber, setIdNumber] = useState('');
  const [problem, setProblem] = useState('');
  const { run, busy, error } = useAction();
  const send = async () => {
    const p = identityPayload(s, individual, { dobKnown });
    if ('missing' in p) { setProblem(p.missing); return; }
    if (idNumber.trim().length < 4) { setProblem('Enter the ID number as it is on the ID.'); return; }
    setProblem('');
    const r = await run(() => post(`/customers/${customerId}/kyc`, { ...p.identity, idNumber: idNumber.trim(), context }), 'Sent for review.');
    if (r) onSubmitted();
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {previous && <div className="sm:col-span-2"><Alert tone="info">Sent back by the reviewer: {previous}</Alert></div>}
      <Field label="ID number" hint="Must match the ID on the customer record."><Input value={idNumber} onChange={(e) => setIdNumber(e.target.value)} autoComplete="off" /></Field>
      <span className="hidden sm:block" />
      <IdentityFields state={s} onChange={setS} individual={individual} hideDob={dobKnown} disabled={busy} onFile={onFile} />
      {(problem || error) && <div className="sm:col-span-2"><Alert>{problem || error}</Alert></div>}
      <div className="sm:col-span-2"><Button type="button" disabled={busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Send for review'}</Button></div>
    </div>
  );
}
