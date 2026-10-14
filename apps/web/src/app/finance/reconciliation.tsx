'use client';
import { Alert, Badge, Button, Card, DataList, Empty, Field, Input, Modal, SectionTitle, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { d, dt, money } from '@/lib/format';

/** Reports comparing the ledger with what was exported and with what SAP says it posted. Any ERROR is a RECONCILIATION_MISMATCH. */
export function Reconciliation() {
  const { can } = useAuth();
  const reports = useApi<{ items: any[] }>('/finance/reconciliation?limit=30');
  const [open, setOpen] = useState<string | null>(null);
  const detail = useApi<any>(open ? `/finance/reconciliation/${open}` : null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const act = useAction(reports.reload);
  if (reports.error) return <Alert>{reports.error}</Alert>;
  if (!reports.data) return <Spinner />;
  const bad = reports.data.items.filter((r) => r.status === 'MISMATCH').length;

  return (
    <div className="space-y-5">
      <Alert tone={bad ? 'danger' : 'success'}>{bad ? `${bad} of the latest ${reports.data.items.length} reports show a mismatch.` : 'The latest reports are clean.'}</Alert>
      {can('finance:export') && (
        <Card>
          <SectionTitle>Check a period</SectionTitle>
          <div className="form-row">
            <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <Button disabled={act.busy || !from || !to} onClick={() => act.run(async () => { const r = await post('/finance/reconciliation/run', { from, to }); setOpen(r.id); })}>Run reconciliation</Button>
          </div>
          {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
        </Card>
      )}
      {reports.data.items.length === 0 ? <Empty>No reports yet. One is written after every export.</Empty> : (
        <DataList label="Reconciliation reports" rows={reports.data.items} rowKey={(r) => r.id}
          columns={[
            { key: 'when', label: 'Checked', primary: true, render: (r) => dt(r.createdAt) },
            { key: 'scope', label: 'Scope', render: (r) => (r.scope === 'BATCH' ? 'One batch' : `${d(r.periodFrom)} – ${d(r.periodTo)}`) },
            { key: 'status', label: 'Result', render: (r) => <Badge tone={r.status === 'OK' ? 'success' : 'danger'}>{r.status === 'OK' ? 'Clean' : 'Mismatch'}</Badge> },
            { key: 'ledger', label: 'Ledger debits', right: true, render: (r) => <span className="tabular-nums">{money(r.ledgerDebitMinor)}</span> },
            { key: 'sap', label: 'SAP debits', right: true, render: (r) => <span className="tabular-nums">{r.sapDebitMinor == null ? '—' : money(r.sapDebitMinor)}</span> },
            { key: 'ex', label: 'Exceptions', right: true, render: (r) => <span className="tabular-nums">{r.exceptionCount}</span> },
          ]}
          actions={(r) => <Button variant="secondary" onClick={() => setOpen(r.id)}>Details</Button>} />
      )}
      {open && (
        <Modal title="Reconciliation report" wide onClose={() => setOpen(null)}>
          {!detail.data ? <Spinner /> : detail.data.exceptions.length === 0 ? <Alert tone="success">Every total agrees.</Alert> : (
            <DataList label="Exceptions" rows={detail.data.exceptions} rowKey={(e: any) => String(e.id ?? e.detail)}
              columns={[
                { key: 'code', label: 'Exception', primary: true, render: (e: any) => <span className="font-mono">{e.code}</span> },
                { key: 'sev', label: 'Severity', render: (e: any) => <Badge tone={e.severity === 'ERROR' ? 'danger' : 'warning'}>{e.severity === 'ERROR' ? 'Error' : 'Warning'}</Badge> },
                { key: 'subject', label: 'Subject', render: (e: any) => e.subject ?? '—' },
                { key: 'exp', label: 'Expected', right: true, render: (e: any) => (e.expectedMinor == null ? '—' : money(e.expectedMinor)) },
                { key: 'act', label: 'Actual', right: true, render: (e: any) => (e.actualMinor == null ? '—' : money(e.actualMinor)) },
                { key: 'detail', label: 'What happened', render: (e: any) => e.detail },
              ]} />
          )}
        </Modal>
      )}
    </div>
  );
}
