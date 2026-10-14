'use client';
import { Alert, Badge, Button, Card, DataList, Empty, Field, Input, Modal, SectionTitle, Select, Spinner, Textarea } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { label } from '@/lib/format';

interface Rule { id: string; name: string; priority: number; matchAccount: string | null; matchStream: string | null; matchEvent: string | null; matchSource: string | null; sapAccount: string; costCenter: string | null; profitCenter: string | null; taxCode: string | null; status: 'ACTIVE' | 'INACTIVE'; validFrom: string | null; validTo: string | null; note: string | null }
const BLANK = { name: '', priority: '100', matchAccount: '', matchStream: '', matchEvent: '', matchSource: '', sapAccount: '', costCenter: '', profitCenter: '', taxCode: '', status: 'ACTIVE', validFrom: '', validTo: '', note: '' };
type Draft = typeof BLANK;
const orNull = (s: string) => (s.trim() ? s.trim() : null);

/** Posting rules: which SAP account, cost centre and profit centre each kind of ledger line goes to. Edited here, effective on the next export; no deployment. */
export function PostingRules() {
  const { can } = useAuth();
  const edit = can('finance:configure');
  const rules = useApi<{ items: Rule[]; unmapped: any[] }>('/finance/coa');
  const meta = useApi<any>('/finance/meta');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [test, setTest] = useState({ accountCode: '4000', stream: 'SUBSCRIPTION' });
  const [tested, setTested] = useState<any | undefined>(undefined);
  const act = useAction(rules.reload);
  if (rules.error) return <Alert>{rules.error}</Alert>;
  if (!rules.data || !meta.data) return <Spinner />;
  const set = (k: keyof Draft, v: string) => setDraft((x) => (x ? { ...x, [k]: v } : x));
  const open = (r?: Rule) => {
    setId(r?.id ?? null);
    setDraft(r ? { name: r.name, priority: String(r.priority), matchAccount: r.matchAccount ?? '', matchStream: r.matchStream ?? '', matchEvent: r.matchEvent ?? '', matchSource: r.matchSource ?? '', sapAccount: r.sapAccount, costCenter: r.costCenter ?? '', profitCenter: r.profitCenter ?? '', taxCode: r.taxCode ?? '', status: r.status, validFrom: r.validFrom ?? '', validTo: r.validTo ?? '', note: r.note ?? '' } : { ...BLANK });
  };
  const body = (x: Draft) => ({ name: x.name, priority: Number(x.priority) || 100, matchAccount: orNull(x.matchAccount), matchStream: orNull(x.matchStream), matchEvent: orNull(x.matchEvent), matchSource: orNull(x.matchSource), sapAccount: x.sapAccount, costCenter: orNull(x.costCenter), profitCenter: orNull(x.profitCenter), taxCode: orNull(x.taxCode), status: x.status, validFrom: orNull(x.validFrom), validTo: orNull(x.validTo), note: orNull(x.note) });
  const any = (v: string | null) => v ?? <span className="text-label2">any</span>;

  return (
    <div className="space-y-5">
      {rules.data.unmapped.length > 0 && (
        <Alert>
          {rules.data.unmapped.length} kind(s) of ledger line have no rule and will stop the next export: {rules.data.unmapped.map((u) => `${u.accountCode}${u.stream ? ` / ${label(u.stream)}` : ''} (${u.lines})`).join(', ')}.
        </Alert>
      )}
      <Card>
        <SectionTitle>Try a line</SectionTitle>
        <div className="form-row">
          <Field label="Ledger account"><Input className="font-mono" value={test.accountCode} onChange={(e) => setTest({ ...test, accountCode: e.target.value })} /></Field>
          <Field label="Revenue stream"><Select value={test.stream} onChange={(e) => setTest({ ...test, stream: e.target.value })}><option value="">(none)</option>{meta.data.streams.map((s: string) => <option key={s} value={s}>{label(s)}</option>)}</Select></Field>
          <Button variant="secondary" onClick={async () => setTested((await post('/finance/coa/preview', { accountCode: test.accountCode, stream: test.stream || null })).resolved ?? null)}>Which SAP account?</Button>
        </div>
        {tested === null && <div className="mt-3"><Alert>No rule covers this line.</Alert></div>}
        {tested && <div className="mt-3"><Alert tone="success">SAP account <b className="font-mono">{tested.sapAccount}</b> · cost centre {tested.costCenter ?? '—'} · profit centre {tested.profitCenter ?? '—'} · tax code {tested.taxCode ?? '—'} (rule “{tested.ruleName}”)</Alert></div>}
        <p className="mt-2 text-footnote text-label2">The most specific rule wins (account, then stream, event and source); between equals the lower priority number wins.</p>
      </Card>
      <SectionTitle action={edit ? <Button onClick={() => open()}>Add a rule</Button> : undefined}>Posting rules</SectionTitle>
      {act.error && <Alert>{act.error}</Alert>}
      {rules.data.items.length === 0 ? <Empty>No rules yet.</Empty> : (
        <DataList label="Posting rules" rows={rules.data.items} rowKey={(r) => r.id}
          columns={[
            { key: 'name', label: 'Rule', primary: true, render: (r) => <span className="font-medium">{r.name}</span> },
            { key: 'acct', label: 'Ledger account', render: (r) => <span className="font-mono">{any(r.matchAccount)}</span> },
            { key: 'stream', label: 'Stream', render: (r) => any(r.matchStream && label(r.matchStream)) },
            { key: 'event', label: 'Event', render: (r) => any(r.matchEvent && label(r.matchEvent)) },
            { key: 'sap', label: 'SAP account', render: (r) => <span className="font-mono">{r.sapAccount}</span> },
            { key: 'cc', label: 'Cost centre', render: (r) => r.costCenter ?? '—' },
            { key: 'pc', label: 'Profit centre', render: (r) => r.profitCenter ?? '—' },
            { key: 'st', label: 'Status', render: (r) => <Badge tone={r.status === 'ACTIVE' ? 'success' : 'neutral'}>{r.status === 'ACTIVE' ? 'Active' : 'Off'}</Badge> },
          ]}
          actions={edit ? (r) => (
            <>
              <Button variant="secondary" onClick={() => open(r)}>Edit</Button>
              <Button variant="secondary" disabled={act.busy} onClick={() => act.run(() => patch(`/finance/coa/${r.id}`, { ...body({ ...BLANK, name: r.name, priority: String(r.priority), matchAccount: r.matchAccount ?? '', matchStream: r.matchStream ?? '', matchEvent: r.matchEvent ?? '', matchSource: r.matchSource ?? '', sapAccount: r.sapAccount, costCenter: r.costCenter ?? '', profitCenter: r.profitCenter ?? '', taxCode: r.taxCode ?? '', validFrom: r.validFrom ?? '', validTo: r.validTo ?? '', note: r.note ?? '' }), status: r.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }))}>{r.status === 'ACTIVE' ? 'Switch off' : 'Switch on'}</Button>
              <Button variant="plain" disabled={act.busy} onClick={() => { if (window.confirm(`Remove “${r.name}”? Lines it covered will stop the next export unless another rule covers them.`)) void act.run(() => del(`/finance/coa/${r.id}`)); }}>Remove</Button>
            </>
          ) : undefined} />
      )}
      {draft && (
        <Modal title={id ? 'Edit posting rule' : 'Add a posting rule'} wide onClose={() => setDraft(null)}>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => (id ? patch(`/finance/coa/${id}`, body(draft)) : post('/finance/coa', body(draft))))) setDraft(null); }}>
            <div className="sm:col-span-2"><Field label="Name"><Input value={draft.name} maxLength={120} onChange={(e) => set('name', e.target.value)} required /></Field></div>
            <Field label="Ledger account" hint="Blank = any"><Input className="font-mono" value={draft.matchAccount} onChange={(e) => set('matchAccount', e.target.value)} /></Field>
            <Field label="Revenue stream" hint="Blank = any"><Select value={draft.matchStream} onChange={(e) => set('matchStream', e.target.value)}><option value="">Any</option>{meta.data.streams.map((s: string) => <option key={s} value={s}>{label(s)}</option>)}</Select></Field>
            <Field label="Event" hint="Blank = any"><Select value={draft.matchEvent} onChange={(e) => set('matchEvent', e.target.value)}><option value="">Any</option>{meta.data.eventTypes.map((s: string) => <option key={s} value={s}>{label(s)}</option>)}</Select></Field>
            <Field label="Priority" hint="Lower wins a tie"><Input type="number" min={0} value={draft.priority} onChange={(e) => set('priority', e.target.value)} /></Field>
            <Field label="SAP G/L account"><Input className="font-mono" value={draft.sapAccount} maxLength={40} onChange={(e) => set('sapAccount', e.target.value)} required /></Field>
            <Field label="Cost centre"><Input className="font-mono" value={draft.costCenter} maxLength={40} onChange={(e) => set('costCenter', e.target.value)} /></Field>
            <Field label="Profit centre"><Input className="font-mono" value={draft.profitCenter} maxLength={40} onChange={(e) => set('profitCenter', e.target.value)} /></Field>
            <Field label="Tax code"><Input className="font-mono" value={draft.taxCode} maxLength={20} onChange={(e) => set('taxCode', e.target.value)} /></Field>
            <Field label="Valid from"><Input type="date" value={draft.validFrom} onChange={(e) => set('validFrom', e.target.value)} /></Field>
            <Field label="Valid to"><Input type="date" value={draft.validTo} onChange={(e) => set('validTo', e.target.value)} /></Field>
            <div className="sm:col-span-2"><Field label="Note"><Textarea rows={2} maxLength={500} value={draft.note} onChange={(e) => set('note', e.target.value)} /></Field></div>
            {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
            <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="plain" onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" disabled={act.busy}>{act.busy ? 'Saving…' : 'Save rule'}</Button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}
