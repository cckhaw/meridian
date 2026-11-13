'use client';
import { Alert, Badge, Button, Card, Field, Modal, SectionTitle, Select, Textarea } from '@meridian/ui';
import { useState, type ReactNode } from 'react';
import { post, useAction } from '@/lib/api';
import { dt, label } from '@/lib/format';
import { ASSIGN_HOW, CHECKLIST, EVENT_LABEL } from '../flags';
import { awayQuestion, isAwayConfirm, OfficerPicker } from '../officer-picker';
import { Assignee, RiskBadge } from '../parts';
import { dueText } from '../view';

export type Checks = Record<string, boolean | string | undefined>;

/**
 * A small dialog that asks for text (a reason or a note), sends it and closes. `extra` adds fields above the text box. `awayRetry`: when the server answers that the chosen
 * officer is away, the question is shown and "Assign anyway" sends the same request again with `force`.
 */
function TextDialog({ title, intro, fieldLabel, hint, required = true, submit, awayRetry, onClose, onDone, extra, canSubmit = true, tone }: { title: string; intro?: ReactNode; fieldLabel: string; hint?: string; required?: boolean; submit: (text: string) => Promise<unknown>; awayRetry?: (text: string) => Promise<unknown>; onClose: () => void; onDone: (result?: any) => void; extra?: ReactNode; canSubmit?: boolean; tone?: 'destructive' }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [away, setAway] = useState<string | null>(null);
  const go = async (force = false) => {
    setBusy(true); setError(null); setAway(null);
    try { const r = await (force && awayRetry ? awayRetry(text.trim()) : submit(text.trim())); onClose(); onDone(r); }
    catch (e) { if (awayRetry && isAwayConfirm(e)) setAway(awayQuestion(e)); else setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        {intro && <p className="text-subhead text-label2">{intro}</p>}
        {extra}
        <Field label={fieldLabel} required={required} optional={!required} hint={hint}><Textarea rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        {error && <Alert>{error}</Alert>}
        {away && <div role="alert"><Alert tone="warning">{away}</Alert></div>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {away && <Button disabled={busy} onClick={() => void go(true)}>{busy ? 'Working…' : 'Assign anyway'}</Button>}
          <Button variant={away ? 'secondary' : tone} disabled={busy || !canSubmit || !!away || (required && !text.trim())} onClick={() => void go()}>{title}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Who has the case, since when and how, with the actions this person is allowed (the server says which in the can* flags). */
export function AssigneeCard({ c, me, reload }: { c: any; me?: string; reload: () => Promise<void> | void }) {
  const [dlg, setDlg] = useState<null | 'release' | 'reassign' | 'takeover' | 'escalate' | 'reopen'>(null);
  const [officer, setOfficer] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const act = useAction(reload);
  const due = c.status === 'PENDING' ? dueText(c.dueAt) : null;
  const held = !!c.assignedTo && c.assignedTo !== me;
  const done = (msg: (r: any) => string) => (r?: any) => { setFlash(msg(r)); void reload(); };
  return (
    <Card className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-footnote text-label2">{c.status === 'PENDING' ? 'Assigned to' : 'Officer of record'}</p>
          <div className="mt-1 text-body font-medium"><Assignee username={c.assignedTo ?? null} name={c.assignedToName} me={me} /></div>
          {c.assignedTo && <p className="mt-1 text-footnote text-label2">{c.assignedAt ? `Since ${dt(c.assignedAt)}` : ''}{c.assignedAt && c.assignmentSource ? ' · ' : ''}{c.assignmentSource ? ASSIGN_HOW[c.assignmentSource] ?? label(c.assignmentSource) : ''}</p>}
          {c.escalatedAt && c.escalationNote && <p className="mt-1 text-footnote text-label2">Escalated{c.escalatedBy ? ` by ${c.escalatedBy === 'system' ? 'the system' : c.escalatedBy}` : ''}: {c.escalationNote}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RiskBadge risk={c.risk} />{c.escalatedAt && <Badge tone="danger">Escalated</Badge>}
          {due && <Badge tone={due.overdue ? 'danger' : 'warning'}>{due.overdue ? `Overdue ${due.text.replace('overdue ', '')}` : `Due ${due.text}`}</Badge>}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {c.canClaim && <Button disabled={act.busy} onClick={() => void act.run(() => post(`/kyc/cases/${c.id}/claim`), 'This case is yours now.')}>Claim</Button>}
        {c.canAssign && held && <Button variant="secondary" onClick={() => setDlg('takeover')}>Take over</Button>}
        {c.canRelease && <Button variant="secondary" onClick={() => setDlg('release')}>Release</Button>}
        {c.canAssign && <Button variant="secondary" onClick={() => { setOfficer(null); setDlg('reassign'); }}>{c.assignedTo ? 'Reassign' : 'Assign'}</Button>}
        {c.canEscalate && <Button variant="secondary" onClick={() => setDlg('escalate')}>Escalate</Button>}
        {c.canReopen && <Button variant="secondary" onClick={() => setDlg('reopen')}>Reopen</Button>}
      </div>
      {!c.canReopen && c.status !== 'PENDING' && c.reopenBlockedReason && !/needs a senior/.test(c.reopenBlockedReason) && <p className="mt-3 text-footnote text-label2">Cannot be reopened: {c.reopenBlockedReason}</p>}
      <div aria-live="polite">{act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}{(act.ok || flash) && <div className="mt-3"><Alert tone="success">{flash ?? act.ok}</Alert></div>}</div>
      {dlg === 'release' && <TextDialog title="Release case" intro="The case goes back to the pool so someone else can take it. It is not handed straight back to you." fieldLabel="Reason" hint="Kept in the timeline." submit={(reason) => post(`/kyc/cases/${c.id}/release`, { reason })} onClose={() => setDlg(null)} onDone={done(() => 'The case is back in the pool.')} />}
      {dlg === 'takeover' && <TextDialog title="Take over case" intro={`The case moves from ${c.assignedToName ?? c.assignedTo} to you.`} fieldLabel="Reason" hint="Kept in the timeline." submit={(reason) => post(`/kyc/cases/${c.id}/take-over`, { reason })} onClose={() => setDlg(null)} onDone={done(() => 'You took over this case.')} />}
      {dlg === 'reassign' && <TextDialog title={c.assignedTo ? 'Reassign case' : 'Assign case'} fieldLabel="Reason" required={!!c.assignedTo} hint="Kept in the timeline." canSubmit={!!officer}
        extra={<Field label="Officer" required hint="The open-case limit does not apply to cases you assign by hand. An officer who is away can be chosen after a confirmation."><OfficerPicker label="Officer" value={officer} onChange={setOfficer} clearable={false} /></Field>}
        submit={(reason) => post('/kyc/assignments', { caseIds: [c.id], mode: 'ASSIGN', officer, reason: reason || undefined }).then(skipCheck)}
        awayRetry={(reason) => post('/kyc/assignments', { caseIds: [c.id], mode: 'ASSIGN', officer, reason: reason || undefined, force: true }).then(skipCheck)}
        onClose={() => setDlg(null)} onDone={done(() => 'The case was assigned.')} />}
      {dlg === 'escalate' && <EscalateDialog id={c.id} canPick={!!c.canAssign} onClose={() => setDlg(null)} onDone={done((r) => (r?.escalatedTo ? `Escalated to ${r.escalatedTo}.` : 'Escalated. Nobody senior is available to take it, so it stays with its holder, flagged and higher in the list.'))} />}
      {dlg === 'reopen' && <TextDialog title="Reopen case" intro="The decision is withdrawn and the case goes back to the waiting list (to the officer who decided it, when they can take it)." fieldLabel="Reason" hint="Kept in the timeline." submit={(reason) => post(`/kyc/cases/${c.id}/reopen`, { reason })} onClose={() => setDlg(null)} onDone={done(() => 'The case is waiting for review again.')} />}
    </Card>
  );
}

/** A one-case assignment that the server skipped (for example the officer submitted the case) answers 200 with the reason: show it as the error it is. */
const skipCheck = (r: { assigned: number; skipped: Array<{ reason: string }> }) => { if (!r.assigned) throw new Error(r.skipped[0]?.reason ?? 'The case was not assigned.'); return r; };

/**
 * Escalate to the senior pool, or (for people who may list officers, i.e. hold the assign permission) to a named reviewer. Everyone else cannot load the officer list, so
 * the picker is not offered and the case goes to the senior pool.
 */
function EscalateDialog({ id, canPick, onClose, onDone }: { id: string; canPick: boolean; onClose: () => void; onDone: (r?: any) => void }) {
  const [to, setTo] = useState<string | null>(null);
  return <TextDialog title="Escalate case" intro={canPick ? 'Pass this case up to a senior reviewer. Without a name it goes to the senior officer with the fewest open cases.' : 'Pass this case up to a senior reviewer: it goes to the senior officer with the fewest open cases.'} fieldLabel="Note for the senior reviewer" hint="Say what worries you." extra={canPick ? <Field label="Senior reviewer" optional hint="Name the reviewer you want to look at it."><OfficerPicker label="Senior reviewer" value={to} onChange={setTo} /></Field> : undefined} submit={(note) => post(`/kyc/cases/${id}/escalate`, { note, to: to ?? undefined })} onClose={onClose} onDone={onDone} />;
}

/** The six checks an officer ticks. They are saved with the decision. `notApplicable` lists checks with nothing to compare (a MyDigital ID case has no photographs): they are sent as "not applicable". */
export function ChecklistForm({ value, onChange, disabled, notApplicable = [] }: { value: Checks; onChange: (v: Checks) => void; disabled?: boolean; notApplicable?: string[] }) {
  return (
    <fieldset disabled={disabled} className="mb-4 min-w-0">
      <legend className="mb-1 text-subhead font-medium">Review checklist</legend>
      <p className="mb-2 text-footnote text-label2">Tick what you have checked. The ticks are saved with your decision. When the review rules require the checklist, approving needs every check ticked, or a note that explains what is off.</p>
      <ul className="grid gap-x-4 sm:grid-cols-2">
        {CHECKLIST.map((i) => {
          const na = notApplicable.includes(i.key);
          return (
            <li key={i.key}><label className="flex min-h-tap items-start gap-3 py-1.5"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" disabled={na} checked={!na && !!value[i.key]} onChange={(e) => onChange({ ...value, [i.key]: e.target.checked })} /><span><span className="block text-subhead">{i.label}</span><span className="block text-caption text-label2">{na ? 'Not applicable: there is nothing to compare for this case.' : i.hint}</span></span></label></li>
          );
        })}
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
        <ul className="space-y-3">{notes.map((n, i) => <li key={i} className="rounded-control bg-surface2 p-3 text-subhead"><p className="whitespace-pre-wrap break-words">{n.text}</p><p className="mt-1 text-caption text-label2">{n.actorName ?? n.actor} · {dt(n.at)}</p></li>)}</ul>
      )}
      <div className="mt-4"><Field label="Add a note" hint="Notes are for the team. The applicant does not see them."><Textarea rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} /></Field></div>
      <div aria-live="polite">{act.error && <div className="mt-2"><Alert>{act.error}</Alert></div>}{act.ok && <div className="mt-2"><Alert tone="success">{act.ok}</Alert></div>}</div>
      <div className="mt-3"><Button variant="secondary" disabled={act.busy || !text.trim()} onClick={() => void add()}>Add note</Button></div>
    </Card>
  );
}

const DECISION_WORD: Record<string, string> = { APPROVE: 'approve', REJECT: 'reject', RETURN: 'send back' };
/** One line about what an event carried (who it went to, why), from the event's own fields. */
export function eventText(e: { action: string; target?: string | null; detail?: Record<string, any> | null }): string {
  const x = e.detail ?? {};
  const why = x.reason ? ` Reason: ${x.reason}` : '';
  switch (e.action) {
    case 'ASSIGNED': case 'REASSIGNED': case 'CLAIMED': return `${x.from ? `From ${x.from} to ` : 'To '}${x.to ?? e.target ?? ''}.${why}`;
    case 'UNASSIGNED': case 'RELEASED': return `${x.from ? `Was with ${x.from}.` : ''}${why}`.trim();
    case 'NOTE': return x.text ?? '';
    case 'ESCALATED': return `${x.to ? `Sent to ${x.to}.` : 'No senior officer was free, so it stays with its holder.'}${x.reason ? ` ${x.reason}` : ''}`;
    case 'RECOMMENDED': return `Recommends to ${DECISION_WORD[x.decision] ?? x.decision}${x.to ? `; ${x.to} confirms` : ''}.${why}`;
    case 'SECOND_REVIEW_DECIDED': return `${x.decision === 'OVERRIDE' ? 'Overrode' : 'Confirmed'} ${x.recommendedBy ?? 'the first officer'}'s recommendation (${DECISION_WORD[x.recommended] ?? x.recommended}); applied: ${DECISION_WORD[x.applied] ?? x.applied}.${x.note ? ` ${x.note}` : ''}`;
    case 'DECIDED': case 'RETURNED': return `${label(String(x.decision ?? '')).replace('Return', 'Send back')}${x.auto ? ' (automatic rules)' : ''}${x.onBehalf ? ` on behalf of ${x.assignedTo}` : ''}${typeof x.minutes === 'number' ? `, ${x.minutes} min after it was assigned` : ''}.${why}`;
    case 'REOPENED': return `Was ${String(x.from ?? '').toLowerCase()}.${why}`;
    case 'SLA_BREACHED': return `Past the ${x.slaHours} hour review target.`;
    case 'QA_SAMPLED': return `Picked for a quality check${e.target ? ` by ${e.target}` : ''}.`;
    case 'QA_DONE': return `${x.result === 'AGREE' ? 'Agrees' : 'Disagrees'}.${x.note ? ` ${x.note}` : ''}`;
    case 'SUBMITTED': return x.resubmitted ? 'Submitted again.' : '';
    default: return '';
  }
}
export function Timeline({ events }: { events: any[] }) {
  return (
    <Card>
      <SectionTitle>Timeline</SectionTitle>
      {events.length === 0 ? <p className="text-subhead text-label2">Nothing recorded yet.</p> : (
        <ol className="relative space-y-4 border-l border-separator pl-5">
          {[...events].reverse().map((e, i) => {
            const text = eventText(e);
            return (
              <li key={i} className="relative text-subhead">
                <span aria-hidden className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full bg-accent" />
                <p><span className="font-medium">{EVENT_LABEL[e.action] ?? label(e.action)}</span> <span className="text-label2">by {e.actorName ?? e.actor ?? 'the system'}</span></p>
                {text && <p className="whitespace-pre-wrap break-words text-label2">{text}</p>}
                <p className="text-caption text-label2">{dt(e.at)}</p>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/** A high-risk decision waits for a different officer: confirm it, or override it with a decision of their own. `c.secondReview` is the case's own record: { status: 'AWAITING', recommended, by, byName, at, note, reasonCode }. */
export function SecondReview({ c, reload }: { c: any; reload: () => Promise<void> | void }) {
  const [mode, setMode] = useState<'CONFIRM' | 'OVERRIDE'>('CONFIRM');
  const [decision, setDecision] = useState('APPROVE');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const act = useAction(reload);
  const sr = c.secondReview ?? {};
  const go = () => act.run(() => post(`/kyc/cases/${c.id}/second-review`, mode === 'CONFIRM' ? { decision: 'CONFIRM', note: note.trim() || undefined } : { decision: 'OVERRIDE', decisionBody: { decision, reason: reason.trim() }, note: note.trim() }), 'Second review recorded.');
  return (
    <Card className="mb-5 ring-2 ring-warning/50">
      <SectionTitle>Second review needed</SectionTitle>
      <p className="mb-3 text-subhead">This is a high risk case. {sr.byName ?? sr.by ?? 'The first officer'} recommends to <strong>{DECISION_WORD[sr.recommended] ?? String(sr.recommended ?? '').toLowerCase()}</strong>{sr.at ? ` (${dt(sr.at)})` : ''}{sr.note ? <>: “{sr.note}”</> : '.'} A different officer has to confirm the decision or replace it before it takes effect.</p>
      {c.canDecide === false && c.decideBlockedReason ? <Alert tone="info">{c.decideBlockedReason}</Alert> : (
        <div className="space-y-3">
          <Segmentedish value={mode} onChange={setMode} />
          {mode === 'OVERRIDE' && (
            <>
              <Field label="New decision"><Select value={decision} onChange={(e) => setDecision(e.target.value)}><option value="APPROVE">Approve</option><option value="REJECT">Reject</option>{c.canReturn && <option value="RETURN">Send back for corrections</option>}</Select></Field>
              <Field label="Reason for the new decision" required={decision !== 'APPROVE'} optional={decision === 'APPROVE'} hint="The applicant or store sees it when the decision is a rejection or a send-back."><Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            </>
          )}
          <Field label="Note" required={mode === 'OVERRIDE'} optional={mode === 'CONFIRM'} hint={mode === 'OVERRIDE' ? 'Explain why you override the first officer. Kept in the timeline.' : 'Kept in the timeline.'}><Textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          {act.error && <Alert>{act.error}</Alert>}
          <Button disabled={act.busy || (mode === 'OVERRIDE' && (!note.trim() || (decision !== 'APPROVE' && !reason.trim())))} onClick={() => void go()}>{mode === 'CONFIRM' ? 'Confirm the decision' : 'Override the decision'}</Button>
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
      <p className="mb-3 text-subhead">{c.decidedBy ? `${c.decidedBy}'s` : 'This'} approval was picked for a quality check. Look at the documents and say whether you would have decided the same.</p>
      <div className="space-y-3">
        <div role="radiogroup" aria-label="Your verdict" className="flex flex-wrap gap-4">{([['AGREE', 'I agree with the decision'], ['DISAGREE', 'I disagree']] as const).map(([v, l]) => <label key={v} className="flex min-h-tap items-center gap-2 text-subhead"><input type="radio" name="qa" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={result === v} onChange={() => setResult(v)} />{l}</label>)}</div>
        <Field label="Note" required={result === 'DISAGREE'} optional={result === 'AGREE'}><Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {act.error && <Alert>{act.error}</Alert>}
        <Button disabled={act.busy || (result === 'DISAGREE' && !note.trim())} onClick={() => void act.run(() => post(`/kyc/cases/${c.id}/qa`, { result, note: note.trim() }), 'Quality check recorded.')}>Record the check</Button>
      </div>
    </Card>
  );
}
