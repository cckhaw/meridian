'use client';
import { Alert, Button, Card, Field, Input, SectionTitle, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';

interface Rules { autoAssign: boolean; strategy: 'EQUAL' | 'ROUND_ROBIN' | 'OFF'; maxOpenPerOfficer: number; stickyOnResubmit: boolean; redistributeAway: boolean; escalateOverdueHours: number; fourEyesHighRisk: boolean; qaSamplePercent: number; reopenDays: number }
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
          <Check checked={r.autoAssign} onChange={(v) => set({ autoAssign: v })} hint="When on, a new case is given to a KYC compliance officer as soon as it arrives. When off, new cases wait in the unassigned pool until someone claims one or a manager assigns it.">Assign new cases automatically</Check>
          <Field label="How cases are shared" hint="Equally: the officer with the fewest open cases gets the next one, and a random officer is picked among those tied. In turn: officers take it in rotation. Not at all: nothing is assigned automatically.">
            <Select value={r.strategy} onChange={(e) => set({ strategy: e.target.value as Rules['strategy'] })}>
              <option value="EQUAL">Equally, random among those tied</option><option value="ROUND_ROBIN">In turn</option><option value="OFF">Not at all</option>
            </Select>
          </Field>
          <Field label="Most open cases per officer" hint="An officer who already has this many open cases is not given more automatically."><Input type="number" min={0} value={r.maxOpenPerOfficer} onChange={(e) => set({ maxOpenPerOfficer: num(e.target.value) })} className="sm:max-w-[10rem]" /></Field>
          <Check checked={r.stickyOnResubmit} onChange={(v) => set({ stickyOnResubmit: v })} hint="When an applicant corrects a case that was sent back and submits it again, it goes to the officer who sent it back instead of being shared out again.">Return resubmitted cases to the same officer</Check>
          <Check checked={r.redistributeAway} onChange={(v) => set({ redistributeAway: v })} hint="When an officer is marked as away or their account is disabled, their open cases are shared out to the other officers. Officers who are away are never given new cases, whatever this says.">Redistribute when an officer is away or disabled</Check>
        </Card>
      </section>

      <section aria-label="Deadlines and escalation" className="space-y-3">
        <SectionTitle>Deadlines and escalation</SectionTitle>
        <Card className="space-y-4">
          <Field label="Escalate when overdue by (hours)" hint="A case still waiting this many hours after its due time is escalated to a senior reviewer."><Input type="number" min={0} value={r.escalateOverdueHours} onChange={(e) => set({ escalateOverdueHours: num(e.target.value) })} className="sm:max-w-[10rem]" /></Field>
        </Card>
      </section>

      <section aria-label="Decision controls" className="space-y-3">
        <SectionTitle>Decision controls</SectionTitle>
        <Card className="space-y-4">
          <Check checked={r.fourEyesHighRisk} onChange={(v) => set({ fourEyesHighRisk: v })} hint="A decision on a high-risk case only takes effect after a senior reviewer confirms it or replaces it.">Second reviewer for high-risk cases</Check>
          <Field label="Quality-check sample (percent)" hint="The share of decided cases, from 0 to 100, that is picked at random for a second officer to check."><Input type="number" min={0} max={100} value={r.qaSamplePercent} onChange={(e) => set({ qaSamplePercent: num(e.target.value) })} className="sm:max-w-[10rem]" /></Field>
          <Field label="A decision can be reopened for (days)" hint="After this many days a decided case can no longer be reopened."><Input type="number" min={0} value={r.reopenDays} onChange={(e) => set({ reopenDays: num(e.target.value) })} className="sm:max-w-[10rem]" /></Field>
        </Card>
      </section>

      <div className="flex flex-wrap gap-2">
        <Button disabled={act.busy || !draft} onClick={() => void save()}>{act.busy ? 'Saving…' : 'Save'}</Button>
        {draft && <Button variant="secondary" onClick={() => { setDraft(null); act.clear(); }}>Discard changes</Button>}
      </div>
    </div>
  );
}
