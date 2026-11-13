'use client';
import { Alert, Badge, Button, Card, Field, Modal, SectionTitle, Select, Textarea } from '@meridian/ui';
import { useState, type ReactNode } from 'react';
import { post, useAction } from '@/lib/api';
import { dt, label } from '@/lib/format';
import { ASSIGN_HOW, CHECKLIST, EVENT_LABEL } from '../flags';
import { OfficerPicker } from '../officer-picker';
import { Assignee, RiskBadge } from '../parts';
import { dueText } from '../view';

export type Checks = Record<string, boolean | string | undefined>;

/** A small dialog that asks for text (a reason or a note), sends it and closes. `extra` adds fields above the text box. */
function TextDialog({ title, intro, fieldLabel, hint, required = true, submit, onClose, onDone, extra, canSubmit = true, tone }: { title: string; intro?: ReactNode; fieldLabel: string; hint?: string; required?: boolean; submit: (text: string) => Promise<unknown>; onClose: () => void; onDone: () => void; extra?: ReactNode; canSubmit?: boolean; tone?: 'destructive' }) {
  const [text, setText] = useState('');
  const act = useAction();
  const go = async () => { if ((await act.run(() => submit(text.trim()))) !== undefined) { onClose(); onDone(); } };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        {intro && <p className="text-subhead text-label2">{intro}</p>}
        {extra}
        <Field label={fieldLabel} required={required} optional={!required} hint={hint}><Textarea rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        {act.error && <Alert>{act.error}</Alert>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={tone} disabled={act.busy || !canSubmit || (required && !text.trim())} onClick={() => void go()}>{title}</Button></div>
      </div>
    </Modal>
  );
}

/** Who has the case, since when and how, with the actions this person is allowed (the server says which in the can* flags). */
export function AssigneeCard({ c, me, reload }: { c: any; me?: string; reload: () => Promise<void> | void }) {
  const [dlg, setDlg] = useState<null | 'release' | 'reassign' | 'escalate' | 'reopen'>(null);
  const [officer, setOfficer] = useState<string | null>(null);
  const act = useAction(reload);
  const due = c.status === 'PENDING' ? dueText(c.dueAt) : null;
  const takeOver = !!c.assignedTo && c.assignedTo !== me;
  return (
    <Card className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-footnote text-label2">Assigned to</p>
          <div className="mt-1 text-body font-medium"><Assignee username={c.assignedTo ?? null} name={c.assignedToName} me={me} /></div>
          {c.assignedTo && <p className="mt-1 text-footnote text-label2">{c.assignedAt ? `Since ${dt(c.assignedAt)}` : ''}{c.assignedAt && c.assignmentSource ? ' · ' : ''}{c.assignmentSource ? ASSIGN_HOW[c.assignmentSource] ?? label(c.assignmentSource) : ''}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RiskBadge risk={c.risk} />{c.escalated && <Badge tone="danger">Escalated</Badge>}
          {due && <Badge tone={due.overdue ? 'danger' : 'warning'}>{due.overdue ? `Overdue ${due.text.replace('overdue ', '')}` : `Due ${due.text}`}</Badge>}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {c.canClaim && <Button disabled={act.busy} onClick={() => void act.run(() => post(`/kyc/cases/${c.id}/claim`), takeOver ? 'You took over this case.' : 'This case is yours now.')}>{takeOver ? 'Take over' : 'Claim'}</Button>}
        {c.canRelease && <Button variant="secondary" onClick={() => setDlg('release')}>Release</Button>}
        {c.canAssign && <Button variant="secondary" onClick={() => { setOfficer(null); setDlg('reassign'); }}>{c.assignedTo ? 'Reassign' : 'Assign'}</Button>}
        {c.canEscalate && <Button variant="secondary" onClick={() => setDlg('escalate')}>Escalate</Button>}
        {c.canReopen && <Button variant="secondary" onClick={() => setDlg('reopen')}>Reopen</Button>}
      </div>
      <div aria-live="polite">{act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}{act.ok && <div className="mt-3"><Alert tone="success">{act.ok}</Alert></div>}</div>
      {dlg === 'release' && <TextDialog title="Release case" intro="The case goes back to the pool so someone else can take it." fieldLabel="Reason" hint="Kept in the timeline." submit={(reason) => post(`/kyc/cases/${c.id}/release`, { reason })} onClose={() => setDlg(null)} onDone={() => void reload()} />}
      {dlg === 'reassign' && <TextDialog title={c.assignedTo ? 'Reassign case' : 'Assign case'} fieldLabel="Reason" required={!!c.assignedTo} hint="Kept in the timeline." canSubmit={!!officer}
        extra={<Field label="Officer" required><OfficerPicker label="Officer" value={officer} onChange={setOfficer} clearable={false} /></Field>}
        submit={(reason) => post('/kyc/assignments', { caseIds: [c.id], mode: 'ASSIGN', officer, reason: reason || undefined })} onClose={() => setDlg(null)} onDone={() => void reload()} />}
      {dlg === 'escalate' && <EscalateDialog id={c.id} onClose={() => setDlg(null)} onDone={() => void reload()} />}
      {dlg === 'reopen' && <TextDialog title="Reopen case" intro="The decision is withdrawn and the case goes back to the waiting list." fieldLabel="Reason" hint="Kept in the timeline." submit={(reason) => post(`/kyc/cases/${c.id}/reopen`, { reason })} onClose={() => setDlg(null)} onDone={() => void reload()} />}
    </Card>
  );
}

function EscalateDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState<string | null>(null);
  return <TextDialog title="Escalate case" intro="Pass this case up to a senior reviewer for a decision." fieldLabel="Note for the senior reviewer" hint="Say what worries you." extra={<Field label="Senior reviewer" optional hint="Name the reviewer you want to look at it."><OfficerPicker label="Senior reviewer" value={to} onChange={setTo} /></Field>} submit={(note) => post(`/kyc/cases/${id}/escalate`, { note, to: to ?? undefined })} onClose={onClose} onDone={onDone} />;
}

/** The six checks an officer ticks. They are saved with the decision. */
export function ChecklistForm({ value, onChange, disabled }: { value: Checks; onChange: (v: Checks) => void; disabled?: boolean }) {
  return (
    <fieldset disabled={disabled} className="mb-4 min-w-0">
      <legend className="mb-1 text-subhead font-medium">Review checklist</legend>
      <p className="mb-2 text-footnote text-label2">Tick what you have checked. The ticks are saved with your decision.</p>
      <ul className="grid gap-x-4 sm:grid-cols-2">
        {CHECKLIST.map((i) => (
          <li key={i.key}><label className="flex min-h-tap items-start gap-3 py-1.5"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={!!value[i.key]} onChange={(e) => onChange({ ...value, [i.key]: e.target.checked })} /><span><span className="block text-subhead">{i.label}</span><span className="block text-caption text-label2">{i.hint}</span></span></label></li>
        ))}
      </ul>
      <div className="mt-2"><Field label="Checklist notes" optional><Textarea rows={2} maxLength={300} value={String(value.notes ?? '')} onChange={(e) => onChange({ ...value, notes: e.target.value })} /></Field></div>
    </fieldset>
  );
}

/** Internal notes: only staff see them, they never reach the applicant. */
export function NotesCard({ c, reload }: { c: any; reload: () => Promise<void> | void }) {
  const [text, setText] = useState('');
  const act = useAction(reload);
  const notes: any[] = c.notes ?? [];
  const add = async () => { if (await act.run(() => post(`/kyc/cases/${c.id}/notes`, { text: text.trim() }), 'Note added.')) setText(''); };
  return (
    <Card>
      <SectionTitle>Internal notes</SectionTitle>
      {notes.length === 0 ? <p className="text-subhead text-label2">No notes yet.</p> : (
        <ul className="space-y-3">{notes.map((n, i) => <li key={n.id ?? i} className="rounded-control bg-surface2 p-3 text-subhead"><p className="whitespace-pre-wrap break-words">{n.text}</p><p className="mt-1 text-caption text-label2">{n.actorName ?? n.authorName ?? n.actor ?? n.author ?? n.by} · {dt(n.at ?? n.createdAt)}</p></li>)}</ul>
      )}
      <div className="mt-4"><Field label="Add a note" hint="Notes are for the team. The applicant does not see them."><Textarea rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} /></Field></div>
      <div aria-live="polite">{act.error && <div className="mt-2"><Alert>{act.error}</Alert></div>}{act.ok && <div className="mt-2"><Alert tone="success">{act.ok}</Alert></div>}</div>
      <div className="mt-3"><Button variant="secondary" disabled={act.busy || !text.trim()} onClick={() => void add()}>Add note</Button></div>
    </Card>
  );
}

export function Timeline({ events }: { events: any[] }) {
  return (
    <Card>
      <SectionTitle>Timeline</SectionTitle>
      {events.length === 0 ? <p className="text-subhead text-label2">Nothing recorded yet.</p> : (
        <ol className="relative space-y-4 border-l border-separator pl-5">
          {events.map((e, i) => (
            <li key={i} className="relative text-subhead">
              <span aria-hidden className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full bg-accent" />
              <p><span className="font-medium">{EVENT_LABEL[e.action] ?? label(e.action)}</span> <span className="text-label2">by {e.actorName ?? e.actor ?? 'the system'}</span></p>
              {e.detail && <p className="whitespace-pre-wrap break-words text-label2">{typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)}</p>}
              <p className="text-caption text-label2">{dt(e.at)}</p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** A high-risk decision waits for a senior reviewer: confirm it, or override it with a decision of their own. */
export function SecondReview({ c, reload }: { c: any; reload: () => Promise<void> | void }) {
  const [mode, setMode] = useState<'CONFIRM' | 'OVERRIDE'>('CONFIRM');
  const [decision, setDecision] = useState('APPROVE');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const act = useAction(reload);
  const sr = c.secondReview ?? {};
  const go = () => act.run(() => post(`/kyc/cases/${c.id}/second-review`, mode === 'CONFIRM' ? { decision: 'CONFIRM', note: note.trim() } : { decision: 'OVERRIDE', decisionBody: { decision, reason: reason.trim(), reasonCode: undefined }, note: note.trim() }), 'Second review recorded.');
  return (
    <Card className="mb-5 ring-2 ring-warning/50">
      <SectionTitle>Second review needed</SectionTitle>
      <p className="mb-3 text-subhead">{sr.firstDecision ? <>The first reviewer{sr.by ? ` (${sr.by})` : ''} chose <strong>{label(String(sr.firstDecision))}</strong>. </> : ''}A senior reviewer has to confirm the decision or replace it before it takes effect.</p>
      {c.canDecide === false && c.decideBlockedReason ? <Alert tone="info">{c.decideBlockedReason}</Alert> : (
        <div className="space-y-3">
          <Segmentedish value={mode} onChange={setMode} />
          {mode === 'OVERRIDE' && (
            <>
              <Field label="New decision"><Select value={decision} onChange={(e) => setDecision(e.target.value)}><option value="APPROVE">Approve</option><option value="REJECT">Reject</option>{c.canReturn && <option value="RETURN">Send back for corrections</option>}</Select></Field>
              <Field label="Reason for the new decision" required hint="The applicant or store sees it when the decision is a rejection or a send-back."><Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            </>
          )}
          <Field label="Note" required hint="Kept in the timeline."><Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          {act.error && <Alert>{act.error}</Alert>}
          <Button disabled={act.busy || !note.trim() || (mode === 'OVERRIDE' && !reason.trim())} onClick={() => void go()}>{mode === 'CONFIRM' ? 'Confirm the decision' : 'Override the decision'}</Button>
        </div>
      )}
    </Card>
  );
}
const Segmentedish = ({ value, onChange }: { value: 'CONFIRM' | 'OVERRIDE'; onChange: (v: 'CONFIRM' | 'OVERRIDE') => void }) => (
  <div role="radiogroup" aria-label="Second review" className="flex flex-wrap gap-4">
    {([['CONFIRM', 'Confirm the first decision'], ['OVERRIDE', 'Override it']] as const).map(([v, l]) => <label key={v} className="flex min-h-tap items-center gap-2 text-subhead"><input type="radio" name="sr" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={value === v} onChange={() => onChange(v)} />{l}</label>)}
  </div>
);

/** Quality check of an earlier decision: does the checker agree with it? */
export function QaForm({ c, reload }: { c: any; reload: () => Promise<void> | void }) {
  const [result, setResult] = useState<'AGREE' | 'DISAGREE'>('AGREE');
  const [note, setNote] = useState('');
  const act = useAction(reload);
  return (
    <Card className="mb-5 ring-2 ring-accent/40">
      <SectionTitle>Quality check</SectionTitle>
      <p className="mb-3 text-subhead">This decision was picked for a quality check. Look at the documents and say whether you would have decided the same.</p>
      <div className="space-y-3">
        <div role="radiogroup" aria-label="Your verdict" className="flex flex-wrap gap-4">{([['AGREE', 'I agree with the decision'], ['DISAGREE', 'I disagree']] as const).map(([v, l]) => <label key={v} className="flex min-h-tap items-center gap-2 text-subhead"><input type="radio" name="qa" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={result === v} onChange={() => setResult(v)} />{l}</label>)}</div>
        <Field label="Note" required={result === 'DISAGREE'} optional={result === 'AGREE'}><Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {act.error && <Alert>{act.error}</Alert>}
        <Button disabled={act.busy || (result === 'DISAGREE' && !note.trim())} onClick={() => void act.run(() => post(`/kyc/cases/${c.id}/qa`, { result, note: note.trim() }), 'Quality check recorded.')}>Record the check</Button>
      </div>
    </Card>
  );
}
