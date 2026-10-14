'use client';
import { Alert, Badge, Button, DataList, Empty, Modal, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { useApi } from '@/lib/api';
import { d, label, money } from '@/lib/format';

/** Monthly settlement statements: what was earned, what was taken back, and what is paid. */
export function Statements() {
  const list = useApi<{ items: any[] }>('/commission/statements');
  const [open, setOpen] = useState<string | null>(null);
  const detail = useApi<any>(open ? `/commission/statements/${open}` : null);
  if (list.error) return <Alert>{list.error}</Alert>;
  if (!list.data) return <Spinner />;
  return (
    <div className="space-y-5">
      {list.data.items.length === 0 ? <Empty>No statements yet. They are issued when Finance closes a month.</Empty> : (
        <DataList label="Commission statements" rows={list.data.items} rowKey={(s) => s.id}
          columns={[
            { key: 'no', label: 'Statement', primary: true, render: (s) => <span className="font-mono">{s.statementNo}</span> },
            { key: 'period', label: 'Month', render: (s) => s.period },
            { key: 'who', label: 'Payee', render: (s) => s.beneficiaryName },
            { key: 'gross', label: 'Earned', right: true, render: (s) => <span className="tabular-nums">{money(s.grossMinor, s.currency)}</span> },
            { key: 'claw', label: 'Taken back', right: true, render: (s) => <span className="tabular-nums">{s.clawbackMinor ? money(s.clawbackMinor, s.currency) : '—'}</span> },
            { key: 'net', label: 'To pay', right: true, render: (s) => <span className="font-semibold tabular-nums">{money(s.netMinor, s.currency)}</span> },
            { key: 'st', label: 'Status', render: (s) => <Badge tone={s.status === 'PAID' ? 'success' : 'warning'}>{label(s.status)}</Badge> },
          ]}
          actions={(s) => (<><Button variant="secondary" onClick={() => setOpen(s.id)}>View</Button><a className="inline-flex min-h-[44px] items-center justify-center rounded-control bg-surface2 px-4 text-subhead font-medium text-accent" href={`/api/commission/statements/${s.id}/csv`}>Download CSV</a></>)} />
      )}
      {open && (
        <Modal title={detail.data ? `Statement ${detail.data.statementNo}` : 'Statement'} wide onClose={() => setOpen(null)}>
          {!detail.data ? <Spinner /> : (
            <DataList label="Statement lines" rows={detail.data.entries} rowKey={(e: any) => String(e.id)}
              columns={[
                { key: 'date', label: 'Date', primary: true, render: (e: any) => d(e.earnedOn) },
                { key: 'type', label: 'Type', render: (e: any) => label(e.entryType) },
                { key: 'order', label: 'Order', render: (e: any) => e.orderNumber ?? '—' },
                { key: 'amt', label: 'Amount', right: true, render: (e: any) => <span className={`tabular-nums ${e.amountMinor < 0 ? 'text-danger' : ''}`}>{money(e.amountMinor, e.currency)}</span> },
                { key: 'note', label: 'Note', render: (e: any) => e.note ?? '' },
              ]} />
          )}
        </Modal>
      )}
    </div>
  );
}
