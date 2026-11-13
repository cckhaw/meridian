'use client';
import { Alert, Badge, Button, Field, Modal, Textarea } from '@meridian/ui';
import { useState } from 'react';
import { api, post } from '@/lib/api';
import { awayQuestion, isAwayConfirm, OfficerMultiPicker, OfficerPicker, type Officer } from './officer-picker';
import { assignmentTarget, MAX_FILTER_ASSIGN, needsReason, type Filters, type Selection, type Tab } from './view';

interface Result { requested: number; assigned: number; skipped: Array<{ caseId: string; caseNumber: string; reason: string }>; perOfficer: Record<string, number> }
type Mode = 'ASSIGN' | 'DISTRIBUTE' | 'UNASSIGN';

/** The sticky bar that appears when rows are selected (people with kyc:assign): assign, share out equally, or return to the pool. */
export function AssignBar({ sel, count, rows, tab, filters, onClear, onDone }: { sel: Selection; count: number | null; rows: Array<{ id: string; assignedTo: string | null }>; tab: Tab; filters: Filters; onClear: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const label = sel.all ? `Every case matching this search${count !== null ? ` (${count.toLocaleString()})` : ''}` : `${sel.ids.length} selected`;
  return (
    <>
      <div role="region" aria-label="Batch actions" className="material-thick sticky bottom-[calc(72px+var(--sab,0px))] z-20 mt-4 flex flex-wrap items-center gap-2 rounded-card border border-separator p-3 shadow-card md:bottom-4">
        <p className="mr-auto min-w-0 px-1 text-subhead font-semibold" aria-live="polite">{label}{sel.all && <span className="block text-caption font-normal text-label2">At most {MAX_FILTER_ASSIGN.toLocaleString()} cases are changed in one go.</span>}</p>
        <Button onClick={() => setMode('ASSIGN')}>Assign to…</Button>
        <Button variant="secondary" onClick={() => setMode('DISTRIBUTE')}>Distribute equally…</Button>
        <Button variant="secondary" onClick={() => setMode('UNASSIGN')}>Return to pool</Button>
        <Button variant="plain" onClick={onClear}>Clear</Button>
      </div>
      {mode && <AssignDialog mode={mode} sel={sel} rows={rows} tab={tab} filters={filters} onClose={() => setMode(null)} onResult={(r) => { setMode(null); setResult(r); }} />}
      {result && <ResultDialog r={result} onClose={() => { setResult(null); onDone(); }} />}
    </>
  );
}

function AssignDialog({ mode, sel, rows, tab, filters, onClose, onResult }: { mode: Mode; sel: Selection; rows: Array<{ id: string; assignedTo: string | null }>; tab: Tab; filters: Filters; onClose: () => void; onResult: (r: Result) => void }) {
  const [officer, setOfficer] = useState<string | null>(null);
  const [everyone, setEveryone] = useState(true);
  const [many, setMany] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonNeeded = needsReason(sel, rows, tab);
  const ready = (mode === 'ASSIGN' ? !!officer : mode === 'DISTRIBUTE' ? everyone || many.length > 0 : true) && (!reasonNeeded || reason.trim().length > 0);
  const title = mode === 'ASSIGN' ? 'Assign to an officer' : mode === 'DISTRIBUTE' ? 'Distribute equally' : 'Return to the pool';
  const submit = async (force = false) => {
    setBusy(true); setError(null); setConfirm(null);
    try {
      // "All available officers" is the list of officers automatic distribution would use: not away, under their limit, not the super user.
      const officers = mode === 'DISTRIBUTE' ? (everyone ? (await api<{ items: Officer[] }>('/kyc/officers?limit=200')).items.filter((o) => o.eligible).map((o) => o.username) : many) : undefined;
      if (mode === 'DISTRIBUTE' && officers!.length === 0) { setError('No officer is available to take cases right now. Pick officers by name instead.'); return; }
      const body = { ...assignmentTarget(sel, tab, filters), mode, reason: reason.trim() || undefined, ...(mode === 'ASSIGN' ? { officer } : {}), ...(mode === 'DISTRIBUTE' ? { officers } : {}), ...(force ? { force: true } : {}) };
      onResult(await post<Result>('/kyc/assignments', body));
    } catch (e) { if (isAwayConfirm(e)) setConfirm(awayQuestion(e)); else setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-subhead text-label2">
          {mode === 'ASSIGN' && 'The chosen officer gets every selected case, whatever the open-case limit says: the limit only applies to automatic assignment. An officer who is away can be chosen after a confirmation.'}
          {mode === 'DISTRIBUTE' && 'The selected cases are shared out so each chosen officer ends up with about the same number of open cases, counting what they already hold. The open-case limit is not applied to cases you assign by hand.'}
          {mode === 'UNASSIGN' && 'The selected cases lose their officer and go back to the unassigned pool. With automatic assignment on, the next sweep (about a minute) gives them out again.'}
        </p>
        {sel.all && <Alert tone="info">This applies to every case matching the current search and filters, at most {MAX_FILTER_ASSIGN.toLocaleString()} of them.</Alert>}
        {mode === 'ASSIGN' && (
          <>
            <Field label="Officer" required><OfficerPicker label="Officer" value={officer} onChange={setOfficer} clearable={false} /></Field>
          </>
        )}
        {mode === 'DISTRIBUTE' && (
          <>
            <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} /><span><span className="block">All available officers</span><span className="block text-footnote text-label2">Everyone who can be given cases automatically: not away, under their open-case limit, not the super user.</span></span></label>
            {!everyone && <Field label="Officers" required hint="Pick two or more to share the cases between them."><OfficerMultiPicker label="Officers" value={many} onChange={setMany} /></Field>}
          </>
        )}
        <Field label="Reason" required={reasonNeeded} optional={!reasonNeeded} hint={reasonNeeded ? 'Some of these cases already have an officer, so say why they are being moved. It is kept in each case’s timeline.' : 'Kept in each case’s timeline.'}>
          <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error && <Alert>{error}</Alert>}
        {confirm && <div role="alert"><Alert tone="warning">{confirm}</Alert></div>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {confirm && <Button disabled={busy} onClick={() => void submit(true)}>{busy ? 'Working…' : 'Assign anyway'}</Button>}
          <Button variant={confirm ? 'secondary' : mode === 'UNASSIGN' ? 'destructive' : 'primary'} disabled={busy || !ready || !!confirm} onClick={() => void submit()}>{busy ? 'Working…' : mode === 'ASSIGN' ? 'Assign' : mode === 'DISTRIBUTE' ? 'Distribute' : 'Return to pool'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function ResultDialog({ r, onClose }: { r: Result; onClose: () => void }) {
  const per = Object.entries(r.perOfficer ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <Modal title="Assignment finished" onClose={onClose} wide>
      <div className="space-y-4" aria-live="polite">
        <p className="text-body"><strong>{r.assigned}</strong> of {r.requested} {r.requested === 1 ? 'case' : 'cases'} changed{r.skipped.length > 0 ? <>, <strong className="text-warning">{r.skipped.length} skipped</strong></> : ''}.</p>
        {per.length > 0 && <div><h3 className="mb-1 text-subhead font-semibold">Per officer</h3><ul className="flex flex-wrap gap-2">{per.map(([u, n]) => <li key={u}><Badge tone="success">{u}: {n}</Badge></li>)}</ul></div>}
        {r.skipped.length > 0 && (
          <div>
            <h3 className="mb-1 text-subhead font-semibold">Skipped</h3>
            <ul className="max-h-60 divide-y divide-separator overflow-y-auto rounded-control border border-separator text-subhead">{r.skipped.map((s) => <li key={s.caseId} className="flex flex-wrap gap-x-3 px-3 py-2"><span className="font-mono">{s.caseNumber}</span><span className="text-label2">{s.reason}</span></li>)}</ul>
          </div>
        )}
        <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
      </div>
    </Modal>
  );
}
