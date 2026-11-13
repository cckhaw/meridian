'use client';
import { Alert, Button, Card, Field, Input, SectionTitle, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';

interface Rules { autoAssign: boolean; strategy: 'EQUAL' | 'ROUND_ROBIN' | 'OFF'; maxOpenPerOfficer: number; stickyOnResubmit: boolean; redistributeAway: boolean; escalateOverdueHours: number; fourEyesHighRisk: boolean; qaSamplePercent: number; reopenDays: number; requireChecklist: boolean }
const Check = ({ checked, onChange, children, hint }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; hint: string }) => (
  <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span><span className="block text-subhead font-medium">{children}</span><span className="block text-footnote text-label2">{hint}</span></span></label>
);
const num = (v: string) => (v === '' ? 0 : Number(v));

/** Settings → KYC review: how new identity-check cases are shared out between officers, and the controls around a decision. */
export function KycReviewSettings() {
  const view = useApi<Rules>('/settings/kyc-review');
  const act = useAction(async () => { await view.reload(); });
  const [draft, setDraft] = useState<Rules | null>(null);
  if (view.error && !view.data) return <Alert>{view.error}</Alert>;
  if (!view.data) return <Spinner />;
  const r = draft ?? view.data;
  const set = (p: Partial<Rules>) => setDraft({ ...r, ...p });
  const save = async () => { if (await act.run(() => post('/settings/kyc-review', r), 'Saved.')) setDraft(null); };
  return (
    <div className="space-y-6">
      <Card><p className="text-subhead text-label2">These rules decide who gets a new identity-check case and what has to happen around a decision. People who can assign cases can always assign by hand, whatever is set here.</p></Card>
      {act.error && <div role="alert"><Alert>{act.error}</Alert></div>}{act.ok && <Alert tone="success">{act.ok}</Alert>}

      <section aria-label="Sharing out new cases" className="space-y-3">
        <SectionTitle>Sharing out new cases</SectionTitle>
        <Card className="space-y-4">
          <Check checked={r.autoAssign} onChange={(v) => set({ autoAssign: v })} hint="When on, a new case is given to an eligible compliance officer (active, holds the Review ID checks permission, not away, under the open-case limit, not the person who submitted it) as soon as it arrives; the super user is never given cases automatically. If nobody is eligible the case waits unassigned and is given out by the next sweep (about once a minute). When off, new cases wait in the unassigned pool until someone claims one, presses Get next case, or a manager assigns it.">Assign new cases automatically</Check>
          <Field label="How cases are shared" hint="Equally: the officer with the fewest open cases gets the next one, and a random officer is picked among those tied. In turn: officers take it in rotation. Not at all: nothing is assigned automatically.">
            <Select value={r.strategy} onChange={(e) => set({ strategy: e.target.value as Rules['strategy'] })}>
              <option value="EQUAL">Equally, random among those tied</option><option value="ROUND_ROBIN">In turn</option><option value="OFF">Not at all</option>
            </Select>
          </Field>
          <Field label="Most open cases per officer" hint="An officer who already has this many open cases is not given more by automatic assignment, and cannot claim or take more with Get next case. Cases a manager assigns by hand ignore the limit. 0 means no limit."><Input type="number" min={0} max={1000} value={r.maxOpenPerOfficer} onChange={(e) => set({ maxOpenPerOfficer: num(e.target.value) })} className="sm:max-w-[10rem]" /></Field>
          <Check checked={r.stickyOnResubmit} onChange={(v) => set({ stickyOnResubmit: v })} hint="When a case that was sent back is submitted again, it goes to the officer who sent it back instead of being shared out again, as long as that officer can take it (not away, under the limit). A reopened case always goes back to the officer who decided it when possible, whatever this says.">Return resubmitted cases to the same officer</Check>
          <Check checked={r.redistributeAway} onChange={(v) => set({ redistributeAway: v })} hint="When an officer is marked as away, their open cases are taken back and shared out to the other officers (or returned to the pool if automatic assignment is off). Officers who are away are never given new cases, whatever this says. The cases of an officer who is disabled or loses the permission always go back, whatever this says.">Redistribute when an officer is away</Check>
        </Card>
      </section>

      <section aria-label="Deadlines and escalation" className="space-y-3">
        <SectionTitle>Deadlines and escalation</SectionTitle>
        <Card className="space-y-4">
          <Field label="Escalate when overdue by (hours)" hint="A case that an officer holds and has still not decided this many hours after its review target is escalated: it is flagged and moved to a senior officer (someone with the Review ID checks and senior permissions; failing that someone who can assign cases; failing that it stays with its holder, flagged). The review target itself is under Integration → Store-front. 0 means never."><Input type="number" min={0} max={720} value={r.escalateOverdueHours} onChange={(e) => set({ escalateOverdueHours: num(e.target.value) })} className="sm:max-w-[10rem]" /></Field>
        </Card>
      </section>

      <section aria-label="Decision controls" className="space-y-3">
        <SectionTitle>Decision controls</SectionTitle>
        <Card className="space-y-4">
          <Check checked={r.fourEyesHighRisk} onChange={(v) => set({ fourEyesHighRisk: v })} hint="On a high risk case the first officer’s approve or reject is only a recommendation. A different officer (failing that a senior one, failing that anyone but the first officer from the pool) confirms it or decides differently, and only that decision takes effect. Sending a case back is never held for a second look.">Second reviewer for high-risk cases</Check>
          <Check checked={r.requireChecklist} onChange={(v) => set({ requireChecklist: v })} hint="Approving needs every check on the review checklist that applies to be ticked, or a checklist note that explains what is off. Rejecting and sending back never need it.">Require the checklist to approve</Check>
          <Field label="Quality-check sample (percent)" hint="The share of approvals made by a person (0 to 100) that is picked at random for a different officer to check. The checker agrees or disagrees; the original officer is told if they disagree. 0 means no checks."><Input type="number" min={0} max={100} value={r.qaSamplePercent} onChange={(e) => set({ qaSamplePercent: num(e.target.value) })} className="sm:max-w-[10rem]" /></Field>
          <Field label="A decision can be reopened for (days)" hint="A senior officer or a supervisor can put a decided case back in the queue for this many days after the decision. 0 means a case cannot be reopened."><Input type="number" min={0} max={365} value={r.reopenDays} onChange={(e) => set({ reopenDays: num(e.target.value) })} className="sm:max-w-[10rem]" /></Field>
        </Card>
      </section>

      <div className="flex flex-wrap gap-2">
        <Button disabled={act.busy || !draft} onClick={() => void save()}>{act.busy ? 'Saving…' : 'Save'}</Button>
        {draft && <Button variant="secondary" onClick={() => { setDraft(null); act.clear(); }}>Discard changes</Button>}
      </div>
    </div>
  );
}
