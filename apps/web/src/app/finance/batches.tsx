'use client';
import { Alert, Badge, Button, Card, DataList, Empty, Field, Input, Modal, SectionTitle, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, money } from '@/lib/format';

const FORMATS = [['', 'Use the setting'], ['FLAT', 'Flat file'], ['IDOC', 'IDoc (XML)'], ['JSON', 'JSON'], ['CSV', 'CSV']] as const;

/** Journal batch runs: what was sent to SAP, when, in which file, and whether SAP confirmed the same totals. */
export function Batches() {
  const { can } = useAuth();
  const list = useApi<{ items: any[] }>('/finance/batches');
  const gl = useApi<any>('/gl?limit=1');
  const [format, setFormat] = useState('');
  const [asOf, setAsOf] = useState('');
  const [ack, setAck] = useState<any | null>(null);
  const [ackDebit, setAckDebit] = useState('');
  const [ackCredit, setAckCredit] = useState('');
  const [ackRef, setAckRef] = useState('');
  const reload = async () => { await Promise.all([list.reload(), gl.reload()]); };
  const act = useAction(reload);
  const [note, setNote] = useState<string | null>(null);
  const waiting = gl.data?.unexported;

  const runNow = () => act.run(async () => {
    const r = await post('/finance/batches/run', { ...(format ? { format } : {}), ...(asOf ? { asOf } : {}) });
    setNote(r.batch ? `Batch ${r.batch.batchNo}: ${r.batch.entryCount} lines in ${r.batch.documentCount} SAP document(s). Reconciliation: ${r.reconciliation?.status === 'OK' ? 'clean' : 'see Reconciliation'}.` : 'Nothing new to export.');
  });
  const closeNow = () => act.run(async () => {
    const r = await post('/finance/close', asOf ? { asOf } : {});
    setNote(r.batch ? `Close through ${r.asOf}: batch ${r.batch.batchNo}.` : `Close through ${r.asOf}: nothing to export.`);
  });
  const download = async (b: any) => {
    const res = await fetch(`/api/finance/batches/${b.id}/file`);
    if (!res.ok) { setNote('Could not download the file.'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob()); a.download = b.fileName ?? 'journal.txt'; a.click(); URL.revokeObjectURL(a.href);
  };
  if (list.error) return <Alert>{list.error}</Alert>;
  if (!list.data) return <Spinner />;

  return (
    <div className="space-y-5">
      {can('finance:export') && (
        <Card>
          <SectionTitle>Send journals to SAP</SectionTitle>
          <p className="mb-3 text-subhead text-label2">{waiting ? `${waiting.n.toLocaleString()} ledger lines (${money(waiting.debit)} debits) are waiting.` : 'Nothing is waiting.'} Each run turns them into balanced SAP documents using the posting rules, keeps the exact file, and checks it against the ledger.</p>
          <div className="form-row">
            <Field label="File format"><Select value={format} onChange={(e) => setFormat(e.target.value)}>{FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
            <Field label="Up to date (optional)"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
            <Button disabled={act.busy || !waiting?.n} onClick={runNow}>{act.busy ? 'Working…' : 'Run export now'}</Button>
            <Button variant="secondary" disabled={act.busy} onClick={closeNow}>Run daily close</Button>
          </div>
        </Card>
      )}
      {act.error && <Alert>{act.error}</Alert>}{note && <Alert tone="info">{note}</Alert>}
      {list.data.items.length === 0 ? <Empty>No runs yet.</Empty> : (
        <DataList label="Journal batch runs" rows={list.data.items} rowKey={(b) => b.id}
          columns={[
            { key: 'no', label: 'Batch', primary: true, render: (b) => <span className="font-mono">{b.batchNo ?? b.id.slice(0, 8)}</span> },
            { key: 'when', label: 'Run', render: (b) => <>{dt(b.createdAt)} · {String(b.runType ?? 'MANUAL').toLowerCase()} · {b.format ?? 'CSV'}</> },
            { key: 'status', label: 'Status', render: (b) => <Badge tone={b.status === 'FAILED' ? 'danger' : 'success'}>{b.status === 'FAILED' ? 'Failed' : 'Completed'}</Badge> },
            { key: 'sent', label: 'Delivery', render: (b) => <Badge tone={b.deliveryStatus === 'DELIVERED' ? 'success' : b.deliveryStatus === 'FAILED' ? 'danger' : 'neutral'}>{b.deliveryStatus === 'DELIVERED' ? 'Delivered' : b.deliveryStatus === 'FAILED' ? 'Failed' : 'Download'}</Badge> },
            { key: 'sap', label: 'SAP confirmed', render: (b) => (b.acknowledgedAt ? <span className="tabular-nums">{money(b.sapDebitMinor)}</span> : <span className="text-label2">—</span>) },
            { key: 'n', label: 'Lines', right: true, render: (b) => <span className="tabular-nums">{b.entryCount}</span> },
            { key: 'dr', label: 'Debits = credits', right: true, render: (b) => <span className="tabular-nums">{money(b.debitMinor)}</span> },
          ]}
          actions={(b) => (b.status === 'FAILED' ? <span className="text-footnote text-danger">{b.error}</span> : (
            <>
              {can('finance:export') && <Button variant="secondary" onClick={() => download(b)}>Download</Button>}
              {can('finance:export') && b.deliveryStatus !== 'NOT_SENT' && b.deliveryStatus !== 'DELIVERED' && <Button variant="secondary" disabled={act.busy} onClick={() => act.run(() => post(`/finance/batches/${b.id}/redeliver`))}>Send again</Button>}
              {can('finance:export') && <Button variant="plain" onClick={() => { setAck(b); setAckDebit(''); setAckCredit(''); setAckRef(b.sapReference ?? ''); }}>Record SAP answer</Button>}
            </>
          ))} />
      )}
      {ack && (
        <Modal title={`SAP answer for ${ack.batchNo}`} onClose={() => setAck(null)}>
          <p className="mb-3 text-subhead text-label2">Enter the totals SAP reports it posted for this batch. A difference from the ledger is raised as a reconciliation mismatch.</p>
          <div className="grid gap-3">
            <Field label="SAP reference"><Input value={ackRef} onChange={(e) => setAckRef(e.target.value)} /></Field>
            <Field label="Total debits SAP posted" hint={`Ledger: ${money(ack.debitMinor)}`}><Input inputMode="decimal" value={ackDebit} onChange={(e) => setAckDebit(e.target.value)} /></Field>
            <Field label="Total credits SAP posted" hint={`Ledger: ${money(ack.creditMinor)}`}><Input inputMode="decimal" value={ackCredit} onChange={(e) => setAckCredit(e.target.value)} /></Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="plain" onClick={() => setAck(null)}>Cancel</Button>
            <Button disabled={act.busy || !ackDebit || !ackCredit} onClick={async () => {
              const { toMinor } = await import('@/lib/format');
              const r = await act.run(() => post(`/finance/batches/${ack.id}/ack`, { reference: ackRef || undefined, debitMinor: toMinor(ackDebit), creditMinor: toMinor(ackCredit) }));
              if (r) { setNote(r.status === 'OK' ? 'SAP agrees with the ledger.' : `Mismatch raised: ${r.exceptionCount} exception(s). See Reconciliation.`); setAck(null); }
            }}>Reconcile</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
