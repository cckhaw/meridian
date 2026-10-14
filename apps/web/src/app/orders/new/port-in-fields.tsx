'use client';
import { Field, Input, Select } from '@meridian/ui';
import type { PortInForm } from './wizard-types';

const ID_TYPES: Array<[string, string]> = [['NATIONAL_ID', 'National ID'], ['PASSPORT', 'Passport'], ['COMPANY_REG', 'Company registration'], ['OTHER', 'Other']];

/** What the national clearinghouse needs to move a number from another operator: the donor, the number, and who holds the account there. */
export function PortInFields({ value, onChange }: { value: PortInForm; onChange: (v: PortInForm) => void }) {
  const set = (patch: Partial<PortInForm>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-3 rounded-control bg-surface2 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Current operator (donor)"><Input value={value.donorOperator} maxLength={60} onChange={(e) => set({ donorOperator: e.target.value })} /></Field>
        <Field label="Number to bring over" hint="Start with the country code, no + needed: 60128001234"><Input value={value.donorMsisdn} inputMode="tel" onChange={(e) => set({ donorMsisdn: e.target.value.replace(/[^\d+\s-]/g, '') })} /></Field>
        <Field label="Account holder’s name" hint="As the current operator has it"><Input value={value.holderName} maxLength={100} onChange={(e) => set({ holderName: e.target.value })} /></Field>
        <div className="grid grid-cols-[9rem_1fr] gap-2">
          <Field label="ID type"><Select value={value.holderIdType} onChange={(e) => set({ holderIdType: e.target.value })}>{ID_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <Field label="ID number"><Input value={value.holderIdNumber} maxLength={40} onChange={(e) => set({ holderIdNumber: e.target.value })} /></Field>
        </div>
      </div>
      <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={value.temporaryNumber} onChange={(e) => set({ temporaryNumber: e.target.checked })} />
        <span><span className="font-medium">Give a temporary number meanwhile</span><span className="block text-footnote text-label2">The line works straight away on a number from our pool. When the other operator approves the port, it is swapped for their number. Without it, the line starts when the number arrives.</span></span></label>
    </div>
  );
}
