'use client';
import { Alert, Badge, Button, Card, Empty, LargeTitle, SectionTitle, Spinner, Stat, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { useAction, useApi } from '@/lib/api';
import { d, dt, money } from '@/lib/format';

export default function Finance() {
  const recon = useApi('/gl/reconcile');
  const gl = useApi('/gl?limit=30');
  const batches = useApi('/gl/batches');
  const [msg, setMsg] = useState<string | null>(null);
  const { run, busy, error } = useAction(async () => { await Promise.all([recon.reload(), gl.reload(), batches.reload()]); });

  const exportNow = () => run(async () => {
    const res = await fetch('/api/gl/export', { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).error?.message ?? 'Export failed');
    if (res.headers.get('content-type')?.includes('json')) { setMsg('Nothing new to export.'); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'meridian-gl.csv';
    a.click(); URL.revokeObjectURL(a.href);
    setMsg(`Exported ${res.headers.get('x-entry-count')} journal lines. They are now marked as posted.`);
  });

  return (
    <>
      <LargeTitle subtitle="SAP general-ledger export and sub-ledger reconciliation">Finance</LargeTitle>
      {recon.loading && !recon.data && <Spinner />}
      {recon.data && (
        <>
          <Alert tone={recon.data.ok ? 'success' : 'danger'}>{recon.data.ok ? 'Ledger reconciles: all checks pass.' : 'Reconciliation FAILED: do not export until investigated.'}</Alert>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {recon.data.checks.map((c: any) => (
              <Card key={c.name} className="!p-4"><div className="flex items-start justify-between gap-2"><p className="font-medium">{c.name}</p><Badge tone={c.ok ? 'success' : 'danger'}>{c.ok ? 'Pass' : 'Fail'}</Badge></div>
                <p className="text-footnote text-label2">{c.note}</p><p className="mt-2 text-subhead tabular-nums">expected {c.expected.toLocaleString()} · actual {c.actual.toLocaleString()}</p></Card>
            ))}
          </div>
          <SectionTitle>Trial balance</SectionTitle>
          <TableWrap><thead><tr><Th>Account</Th><Th>Name</Th><Th right>Debit</Th><Th right>Credit</Th><Th right>Balance</Th></tr></thead><tbody>
            {recon.data.trialBalance.map((r: any) => <tr key={r.accountCode}><Td className="font-mono">{r.accountCode}</Td><Td>{r.accountName}</Td><Td right>{money(r.debitMinor)}</Td><Td right>{money(r.creditMinor)}</Td><Td right>{money(r.balanceMinor)}</Td></tr>)}
          </tbody></TableWrap>
        </>
      )}

      <SectionTitle action={<Button disabled={busy || !gl.data?.unexported.n} onClick={exportNow}>{busy ? 'Exporting…' : 'Export to SAP (CSV)'}</Button>}>Journal export</SectionTitle>
      {gl.data && <p className="mb-3 text-subhead text-label2">{gl.data.unexported.n.toLocaleString()} journal lines waiting to be exported ({money(gl.data.unexported.debit)} debits).</p>}
      {error && <Alert>{error}</Alert>}{msg && <Alert tone="info">{msg}</Alert>}
      {batches.data && batches.data.items.length > 0 && (
        <TableWrap><thead><tr><Th>Batch</Th><Th>Created</Th><Th right>Lines</Th><Th right>Debits = credits</Th><Th /></tr></thead><tbody>
          {batches.data.items.map((b: any) => <tr key={b.id}><Td className="font-mono">{b.id.slice(0, 8)}</Td><Td>{dt(b.createdAt)}</Td><Td right>{b.entryCount}</Td><Td right>{money(b.debitMinor)}</Td><Td right><a className="text-accent" href={`/api/gl/batches/${b.id}/csv`}>Download</a></Td></tr>)}
        </tbody></TableWrap>
      )}

      <SectionTitle>Latest journal lines</SectionTitle>
      {gl.data && (gl.data.items.length === 0 ? <Empty>No journal entries yet.</Empty> : (
        <TableWrap><thead><tr><Th>Date</Th><Th>Account</Th><Th>Description</Th><Th right>Debit</Th><Th right>Credit</Th><Th>Posted</Th></tr></thead><tbody>
          {gl.data.items.map((e: any) => <tr key={e.id}><Td>{d(e.entryDate)}</Td><Td className="font-mono">{e.accountCode}</Td><Td>{e.description}</Td><Td right>{e.debitMinor ? money(e.debitMinor, e.currency) : ''}</Td><Td right>{e.creditMinor ? money(e.creditMinor, e.currency) : ''}</Td><Td>{e.exportedBatchId ? <Badge tone="success">Exported</Badge> : <Badge>Pending</Badge>}</Td></tr>)}
        </tbody></TableWrap>
      ))}
    </>
  );
}
