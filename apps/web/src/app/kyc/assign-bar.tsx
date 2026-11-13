'use client';
import { Alert, Badge, Button, Field, Modal, Textarea } from '@meridian/ui';
import { useState } from 'react';
import { post } from '@/lib/api';
import { OfficerMultiPicker, OfficerPicker } from './officer-picker';
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
      {mode && <AssignDialog mode={mode} sel={sel} rows={rows} tab={tab} filters={filters} onClose={() => setMode(null)} onResult={(r) => { setMode(null); setResult(r); onDone(); }} />}
      {result && <ResultDialog r={result} onClose={() => setResult(null)} />}
    </>
  );
}

function AssignDialog({ mode, sel, rows, tab, filters, onClose, onResult }: { mode: Mode; sel: Selection; rows: Array<{ id: string; assignedTo: string | null }>; tab: Tab; filters: Filters; onClose: () => void; onResult: (r: Result) => void }) {
  const [officer, setOfficer] = useState<string | null>(null);
  const [everyone, setEveryone] = useState(true);
  const [many, setMany] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonNeeded = needsReason(sel, rows, tab);
  const ready = (mode === 'ASSIGN' ? !!officer : mode === 'DISTRIBUTE' ? everyone || many.length > 0 : true) && (!reasonNeeded || reason.trim().length > 0);
  const title = mode === 'ASSIGN' ? 'Assign to an officer' : mode === 'DISTRIBUTE' ? 'Distribute equally' : 'Return to the pool';
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const body = { ...assignmentTarget(sel, tab, filters), mode, reason: reason.trim() || undefined, ...(mode === 'ASSIGN' ? { officer, force: force || undefined } : {}), ...(mode === 'DISTRIBUTE' && !everyone ? { officers: many } : {}) };
      onResult(await post<Result>('/kyc/assignments', body));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-subhead text-label2">
          {mode === 'ASSIGN' && 'The chosen officer gets every selected case. Officers who cannot take cases are listed with the reason and cannot be picked.'}
          {mode === 'DISTRIBUTE' && 'The selected cases are shared out so each chosen officer gets about the same number. Officers who are away or at their open-case limit are left out.'}
          {mode === 'UNASSIGN' && 'The selected cases lose their officer and go back to the unassigned pool.'}
        </p>
        {sel.all && <Alert tone="info">This applies to every case matching the current search and filters, at most {MAX_FILTER_ASSIGN.toLocaleString()} of them.</Alert>}
        {mode === 'ASSIGN' && (
          <>
            <Field label="Officer" required><OfficerPicker label="Officer" value={officer} onChange={setOfficer} clearable={false} /></Field>
            <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={force} onChange={(e) => setForce(e.target.checked)} /><span><span className="block">Override the open-case limit</span><span className="text-footnote text-label2">Assign even if the officer would go over the limit set in the review rules.</span></span></label>
          </>
        )}
        {mode === 'DISTRIBUTE' && (
          <>
            <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} /><span>All available officers</span></label>
            {!everyone && <Field label="Officers" required hint="Pick two or more to share the cases between them."><OfficerMultiPicker label="Officers" value={many} onChange={setMany} /></Field>}
          </>
        )}
        <Field label="Reason" required={reasonNeeded} optional={!reasonNeeded} hint={reasonNeeded ? 'Some of these cases already have an officer, so say why they are being moved. It is kept in each case’s timeline.' : 'Kept in each case’s timeline.'}>
          <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant={mode === 'UNASSIGN' ? 'destructive' : 'primary'} disabled={busy || !ready} onClick={() => void submit()}>{busy ? 'Working…' : mode === 'ASSIGN' ? 'Assign' : mode === 'DISTRIBUTE' ? 'Distribute' : 'Return to pool'}</Button>
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
