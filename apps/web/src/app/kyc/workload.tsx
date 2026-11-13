'use client';
import { Alert, Badge, Button, Card, Field, Input, Modal } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { d } from '@/lib/format';
import { fmtHours, initials } from './view';

interface Workload { officers: Array<{ username: string; displayName: string; away: boolean; open: number; overdue: number; oldestHours: number | null; decidedToday: number; decidedWeek: number }>; unassigned: number; unassignedOverdue: number; oldestUnassignedHours: number | null }

/** Who has how much: for people with kyc:assign. Clicking an officer filters the list to them; "Set away" is per officer. */
export function WorkloadStrip({ active, onPick, onUnassigned, version, onChanged }: { active: string; onPick: (username: string) => void; onUnassigned: () => void; version: number; onChanged: () => void }) {
  const { data, error, reload } = useApi<Workload>(`/kyc/workload?v=${version}`);
  const [away, setAway] = useState<{ username: string; name: string } | null>(null);
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const act = useAction(async () => { await reload(); onChanged(); });
  if (error) return <div className="mb-5"><Alert tone="info">The workload overview could not be loaded: {error}</Alert></div>;
  if (!data) return null;
  const toggle = async (username: string, goAway: boolean) => {
    if (await act.run(() => post(`/kyc/officers/${encodeURIComponent(username)}/status`, { away: goAway, awayUntil: goAway && until ? until : undefined, note: goAway && note.trim() ? note.trim() : undefined }), goAway ? 'Marked as away.' : 'Marked as available.')) { setAway(null); setUntil(''); setNote(''); }
  };
  return (
    <section aria-label="Workload" className="mb-5">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-title3 font-semibold">Workload</h2>
        <button type="button" onClick={onUnassigned} className="rounded text-subhead text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {data.unassigned} unassigned{data.unassignedOverdue > 0 && <>, <span className="font-medium text-danger">{data.unassignedOverdue} overdue</span></>}{data.oldestUnassignedHours !== null && data.unassigned > 0 ? `, oldest ${fmtHours(data.oldestUnassignedHours)}` : ''}
        </button>
      </div>
      <ul className="-mx-4 flex snap-x scroll-pl-4 gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {data.officers.length === 0 && <li className="text-subhead text-label2">No officers yet. Give someone a role with the KYC review permission.</li>}
        {data.officers.map((o) => {
          const on = active === o.username;
          return (
            <li key={o.username} className="w-[15rem] shrink-0 snap-start">
              <Card className={`!p-3 ${on ? 'ring-2 ring-accent' : ''} ${o.away ? 'opacity-80' : ''}`}>
                <button type="button" aria-pressed={on} onClick={() => onPick(on ? '' : o.username)} className="flex w-full items-center gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-label/10 text-footnote font-semibold text-label2">{initials(o.displayName || o.username)}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium">{o.displayName || o.username}</span><span className="block text-caption text-label2">{on ? 'Showing their cases' : 'Show their cases'}</span></span>
                  {o.away && <Badge tone="warning">Away</Badge>}
                </button>
                <dl className="mt-2 grid grid-cols-4 gap-1 text-center">
                  {([['Open', o.open], ['Overdue', o.overdue], ['Oldest', fmtHours(o.oldestHours)], ['Today', o.decidedToday]] as const).map(([k, v]) => <div key={k}><dt className="text-caption text-label2">{k}</dt><dd className={`text-subhead font-semibold tabular-nums ${k === 'Overdue' && o.overdue > 0 ? 'text-danger' : ''}`}>{v}</dd></div>)}
                </dl>
                <button type="button" className="mt-2 min-h-[32px] rounded text-footnote text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => (o.away ? void toggle(o.username, false) : setAway({ username: o.username, name: o.displayName || o.username }))}>{o.away ? 'Mark as available' : 'Set away'}</button>
              </Card>
            </li>
          );
        })}
      </ul>
      <div aria-live="polite">{act.error && !away && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}</div>
      {away && (
        <Modal title={`Set ${away.name} as away`} onClose={() => setAway(null)}>
          <div className="space-y-4">
            <p className="text-subhead text-label2">An officer who is away is not given new cases. If the review rules redistribute cases of officers who are away, their open cases are shared out to others.</p>
            <Field label="Back on" optional hint="Their expected return, shown to the people who assign cases."><Input type="date" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} /></Field>
            <Field label="Note" optional><Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
            {act.error && <Alert>{act.error}</Alert>}
            <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setAway(null)}>Cancel</Button><Button disabled={act.busy} onClick={() => void toggle(away.username, true)}>Set as away{until ? ` until ${d(until)}` : ''}</Button></div>
          </div>
        </Modal>
      )}
    </section>
  );
}
