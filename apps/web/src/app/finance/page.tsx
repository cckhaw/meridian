'use client';
import { Alert, Badge, Card, Empty, LargeTitle, LoadMore, Segmented, SectionTitle, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { useApi, usePaged } from '@/lib/api';
import { Batches } from './batches';
import { Reconciliation } from './reconciliation';
import { PostingRules } from './rules';
import { SapSettings } from './sap-settings';
import { d, dt, money } from '@/lib/format';

function Ledger() {
  const recon = useApi('/gl/reconcile');
  const gl = usePaged('/gl?limit=30');
  return (
    <>
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

      <SectionTitle>Latest journal lines</SectionTitle>
      {!gl.loading && gl.items.length === 0 && <Empty>No journal entries yet.</Empty>}
      {gl.items.length > 0 && (
        <>
        <TableWrap><thead><tr><Th>Date</Th><Th>Account</Th><Th>Description</Th><Th right>Debit</Th><Th right>Credit</Th><Th>Posted</Th></tr></thead><tbody>
          {gl.items.map((e: any) => <tr key={e.id}><Td>{d(e.entryDate)}</Td><Td className="font-mono">{e.accountCode}</Td><Td>{e.description}</Td><Td right>{e.debitMinor ? money(e.debitMinor, e.currency) : ''}</Td><Td right>{e.creditMinor ? money(e.creditMinor, e.currency) : ''}</Td><Td>{e.exportedBatchId ? <Badge tone="success">Exported</Badge> : <Badge>Pending</Badge>}</Td></tr>)}
        </tbody></TableWrap>
        <LoadMore shown={gl.items.length} hasMore={gl.hasMore} loading={gl.loadingMore} onMore={gl.loadMore} noun="journal lines" />
        </>
      )}
    </>
  );
}

const TABS = [['ledger', 'Ledger'], ['batches', 'SAP export'], ['recon', 'Reconciliation'], ['rules', 'Posting rules'], ['sap', 'SAP settings']] as const;
type Tab = (typeof TABS)[number][0];

export default function Finance() {
  const [tab, setTab] = useState<Tab>('ledger');
  return (
    <>
      <LargeTitle subtitle="Sub-ledger, SAP journal export and reconciliation">Finance</LargeTitle>
      <div className="mb-5"><Segmented label="Finance sections" value={tab} onChange={setTab} options={TABS.map(([value, label]) => ({ value, label }))} /></div>
      {tab === 'ledger' && <Ledger />}
      {tab === 'batches' && <Batches />}
      {tab === 'recon' && <Reconciliation />}
      {tab === 'rules' && <PostingRules />}
      {tab === 'sap' && <SapSettings />}
    </>
  );
}
