'use client';
import { Alert, Button, Card, Field, Input } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { d } from '@/lib/format';
import { fmtMinutes } from './view';

interface Counts { decided: number; approved: number; rejected: number; returned: number }
interface Me { username: string; away: boolean; awayUntil: string | null; today: Counts; week: Counts; month: Counts; open: number; overdue: number; avgMinutesWeek: number | null }

/** The signed-in officer's own numbers and their Available/Away switch. Renders nothing until /kyc/me answers (older servers refuse it). */
export function OfficerCard({ onChanged }: { onChanged: () => void }) {
  const { data: m, reload } = useApi<Me>('/kyc/me');
  const act = useAction(async () => { await reload(); onChanged(); });
  const [asking, setAsking] = useState(false);
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  if (!m) return null;
  const set = async (away: boolean) => {
    if (await act.run(() => post('/kyc/me/status', { away, awayUntil: away && until ? until : undefined, note: away && note.trim() ? note.trim() : undefined }), away ? 'You are marked as away.' : 'You are available again.')) { setAsking(false); setUntil(''); setNote(''); }
  };
  const tiles: Array<[string, string | number, boolean?]> = [['Open', m.open], ['Overdue', m.overdue, m.overdue > 0], ['Done today', m.today.decided], ['This week', m.week.decided], ['This month', m.month.decided]];
  return (
    <Card className="mb-5 !p-4 sm:!p-5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <dl className="grid flex-1 grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-5" aria-label="Your reviews">
          {tiles.map(([k, v, bad]) => <div key={k}><dt className="text-footnote text-label2">{k}</dt><dd className={`text-title2 font-semibold tabular-nums ${bad ? 'text-danger' : ''}`}>{v}</dd></div>)}
        </dl>
        <div className="flex items-center gap-3">
          <span id="away-label" className="text-subhead"><span className="block font-medium">{m.away ? 'Away' : 'Available'}</span>{m.away && m.awayUntil && <span className="block text-caption text-label2">until {d(m.awayUntil)}</span>}</span>
          <button type="button" role="switch" aria-checked={!m.away} aria-labelledby="away-label" disabled={act.busy} onClick={() => (m.away ? void set(false) : setAsking((a) => !a))}
            className={`relative h-8 w-[52px] shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50 ${m.away ? 'bg-label/20' : 'bg-success'}`}>
            <span className={`absolute top-0.5 h-7 w-7 rounded-full bg-white shadow transition-[left] ${m.away ? 'left-0.5' : 'left-[22px]'}`} />
          </button>
        </div>
      </div>
      {asking && !m.away && (
        <div className="mt-4 grid gap-3 border-t border-separator pt-4 sm:grid-cols-2">
          <p className="text-subhead text-label2 sm:col-span-2">While you are away you are not given new cases. If the review rules redistribute cases of officers who are away, your open cases are shared out to others.</p>
          <Field label="Back on" optional hint="Your expected return, shown to the people who assign cases."><Input type="date" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} /></Field>
          <Field label="Note" optional><Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. annual leave" /></Field>
          <div className="flex gap-2 sm:col-span-2"><Button disabled={act.busy} onClick={() => void set(true)}>Set as away</Button><Button variant="secondary" onClick={() => setAsking(false)}>Cancel</Button></div>
        </div>
      )}
      {m.avgMinutesWeek !== null && <p className="mt-3 text-caption text-label2">Average handling time this week: {fmtMinutes(m.avgMinutesWeek)}.</p>}
      <div aria-live="polite">{act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}{act.ok && <div className="mt-3"><Alert tone="success">{act.ok}</Alert></div>}</div>
    </Card>
  );
}
