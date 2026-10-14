'use client';
import { Alert, Badge, Button, Card, DataList, Empty, Field, Input, SectionTitle, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { dt, label, money } from '@/lib/format';

/** Month close, payout files and the daily commission job. */
export function Payouts() {
  const batches = useApi<{ items: any[] }>('/commission/payouts');
  const settings = useApi<{ autoClose: boolean }>('/commission/settings');
  const [period, setPeriod] = useState(() => { const x = new Date(); x.setUTCMonth(x.getUTCMonth() - 1); return x.toISOString().slice(0, 7); });
  const [note, setNote] = useState<string | null>(null);
  const act = useAction(async () => { await Promise.all([batches.reload(), settings.reload()]); });
  const download = async (b: any) => {
    const res = await fetch(`/api/commission/payouts/${b.id}/file`);
    if (!res.ok) { setNote('Could not download the file.'); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = b.fileName; a.click(); URL.revokeObjectURL(a.href);
  };
  if (batches.error) return <Alert>{batches.error}</Alert>;
  if (!batches.data || !settings.data) return <Spinner />;
  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle>Close a month</SectionTitle>
        <p className="mb-3 text-subhead text-label2">Approves what is due, pays volume accelerators and bonuses, and issues one statement per payee. A payee whose claw-backs exceed their earnings gets no statement: the balance carries to the next month.</p>
        <div className="form-row">
          <Field label="Month"><Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></Field>
          <Button disabled={act.busy || !period} onClick={() => act.run(async () => { const r = await post('/commission/close', { period }); setNote(`${r.period}: ${r.issued} statement(s) issued, ${r.accelerators} accelerator(s), ${r.bonuses} bonus(es)${r.carriedForward?.length ? `, ${r.carriedForward.length} balance(s) carried forward` : ''}.`); })}>Close month</Button>
          <Button variant="secondary" disabled={act.busy} onClick={() => act.run(async () => { const r = await post('/commission/payouts', {}); setNote(r.batch ? `Payout file ${r.batch.batchNo}: ${r.batch.statementCount} payment(s), ${money(r.batch.totalMinor, r.batch.currency)}.${r.skipped.length ? ` Left out: ${r.skipped.map((s: any) => `${s.statementNo} (${s.reason})`).join('; ')}.` : ''}` : `No payout file: ${r.skipped.length ? r.skipped.map((s: any) => s.reason).join('; ') : 'nothing is waiting'}.`); })}>Create payout file</Button>
          <Button variant="plain" disabled={act.busy} onClick={() => act.run(async () => { const r = await post('/commission/run', {}); setNote(`Daily job: ${r.approved} approved, ${r.clawbacks.services} service(s) checked for claw-back.`); })}>Run daily job</Button>
        </div>
        <label className="mt-4 flex items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5" checked={settings.data.autoClose} onChange={(e) => act.run(() => post('/commission/settings', { autoClose: e.target.checked }))} /><span><span className="font-medium">Close the month automatically</span><span className="block text-footnote text-label2">On the 1st, the daily job closes the month just ended and issues statements. Payout files are still created and confirmed by hand.</span></span></label>
      </Card>
      {act.error && <Alert>{act.error}</Alert>}{note && <Alert tone="info">{note}</Alert>}
      <SectionTitle>Payout files</SectionTitle>
      {batches.data.items.length === 0 ? <Empty>No payout files yet.</Empty> : (
        <DataList label="Payout files" rows={batches.data.items} rowKey={(b) => b.id}
          columns={[
            { key: 'no', label: 'Payout', primary: true, render: (b) => <span className="font-mono">{b.batchNo}</span> },
            { key: 'when', label: 'Created', render: (b) => dt(b.createdAt) },
            { key: 'n', label: 'Payments', right: true, render: (b) => <span className="tabular-nums">{b.statementCount}</span> },
            { key: 'tot', label: 'Total', right: true, render: (b) => <span className="font-semibold tabular-nums">{money(b.totalMinor, b.currency)}</span> },
            { key: 'st', label: 'Status', render: (b) => <Badge tone={b.status === 'PAID' ? 'success' : 'warning'}>{label(b.status)}</Badge> },
          ]}
          actions={(b) => (<><Button variant="secondary" onClick={() => download(b)}>Download</Button>{b.status === 'PENDING' && <Button disabled={act.busy} onClick={() => { if (window.confirm('Confirm only once the bank has paid this file. It books the payout and marks every line paid.')) void act.run(() => post(`/commission/payouts/${b.id}/confirm`), 'Confirmed.'); }}>Bank paid it</Button>}</>)} />
      )}
    </div>
  );
}
