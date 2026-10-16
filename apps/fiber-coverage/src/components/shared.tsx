'use client';
import type { ReactNode } from 'react';

export const Check = ({ on, set, children, disabled }: { on: boolean; set: (v: boolean) => void; children: ReactNode; disabled?: boolean }) => (
  <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={on} disabled={disabled} onChange={(e) => set(e.target.checked)} /> {children}</label>
);
/** Free ports out of the splitter, as a small bar: used and reserved dark, faulty red, free green. */
export function PortBar({ available, reserved, inUse, faulty, total }: { available: number; reserved: number; inUse: number; faulty: number; total: number }) {
  const w = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <div className="min-w-[8rem]" title={`${available} free, ${reserved} reserved, ${inUse} in use, ${faulty} faulty of ${total}`}>
      <div className="flex h-2 overflow-hidden rounded-full bg-surface2">
        <span style={{ width: w(inUse) }} className="bg-label2" /><span style={{ width: w(reserved) }} className="bg-warning" /><span style={{ width: w(faulty) }} className="bg-danger" /><span style={{ width: w(available) }} className="bg-success" />
      </div>
      <p className="mt-1 text-caption text-label2">{available} free of {total}</p>
    </div>
  );
}
export const LEVEL_TONE = { EXHAUSTED: 'danger', LOW: 'warning', OK: 'success' } as const;
export const AVAIL_TONE = { AVAILABLE: 'success', PORT_EXHAUSTED_WAITLIST: 'warning', UNSERVICEABLE: 'danger', UNKNOWN: 'neutral' } as const;
