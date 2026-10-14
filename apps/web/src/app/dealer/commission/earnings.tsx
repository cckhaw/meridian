'use client';
import { Alert, Badge, Button, Card, DataList, Empty, Field, Input, LoadMore, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { d, label, money } from '@/lib/format';

const statusTone = (s: string) => (s === 'PAID' ? 'success' : s === 'CLAWED_BACK' ? 'danger' : s === 'APPROVED' ? 'warning' : 'neutral') as 'success' | 'danger' | 'warning' | 'neutral';

/** The earnings ledger: every commission earned, approved, paid or taken back, with how each amount was worked out. */
export function Earnings() {
  const { can } = useAuth();
  const [period, setPeriod] = useState('');
  const [status, setStatus] = useState('');
  const qs = new URLSearchParams({ limit: '30', ...(period ? { period } : {}), ...(status ? { status } : {}) }).toString();
  const led = usePaged(`/commission/ledger?${qs}`);
  const act = useAction(led.reload);
  const t = led.extra?.totals;
  const pending = led.items.filter((e: any) => e.status === 'PENDING').map((e: any) => e.id);
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-4">
        {[['Pending', t?.pending], ['Approved', t?.approved], ['Paid', t?.paid], ['Clawed back', t?.clawed]].map(([l, v]) => (
          <Card key={l as string} className="!p-4"><p className="text-footnote text-label2">{l}</p><p className="mt-1 text-title3 font-semibold tabular-nums">{v == null ? '—' : money(v as number)}</p></Card>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-[12rem_12rem_auto] sm:items-end">
        <Field label="Month"><Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></Field>
        <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="PENDING">Pending</option><option value="APPROVED">Approved</option><option value="PAID">Paid</option><option value="CLAWED_BACK">Clawed back</option></Select></Field>
        {can('commission:settle') && <Button variant="secondary" disabled={act.busy || !pending.length} onClick={() => act.run(() => post('/commission/ledger/approve', { ids: pending }))}>Approve the {pending.length} pending shown</Button>}
      </div>
      {act.error && <Alert>{act.error}</Alert>}
      {led.error && <Alert>{led.error}</Alert>}
      {led.loading && !led.items.length && <Spinner />}
      {!led.loading && !led.items.length ? <Empty>No commission yet. It is earned when an order a dealer or salesperson sold is completed.</Empty> : (
        <>
          <DataList label="Commission ledger" rows={led.items} rowKey={(e: any) => String(e.id)}
            columns={[
              { key: 'date', label: 'Date', primary: true, render: (e: any) => d(e.earnedOn) },
              { key: 'type', label: 'Type', render: (e: any) => label(e.entryType) },
              { key: 'who', label: 'Earned by', render: (e: any) => <span className="font-mono">{e.beneficiaryId}</span> },
              { key: 'order', label: 'Order', render: (e: any) => e.orderNumber ?? '—' },
              { key: 'units', label: 'Activations', right: true, render: (e: any) => <span className="tabular-nums">{e.units || '—'}</span> },
              { key: 'basis', label: 'Sale value', right: true, render: (e: any) => (e.basisMinor ? <span className="tabular-nums">{money(e.basisMinor, e.currency)}</span> : '—') },
              { key: 'rate', label: 'Rate', right: true, render: (e: any) => (e.rateBps == null ? '—' : `${(e.rateBps / 100).toFixed(2)}%`) },
              { key: 'amt', label: 'Amount', right: true, render: (e: any) => <span className={`font-semibold tabular-nums ${e.amountMinor < 0 ? 'text-danger' : ''}`}>{money(e.amountMinor, e.currency)}</span> },
              { key: 'st', label: 'Status', render: (e: any) => <Badge tone={statusTone(e.status)}>{label(e.status)}</Badge> },
              { key: 'why', label: 'How', render: (e: any) => <span className="text-footnote text-label2">{e.note ?? (e.calc?.rule ? `${e.calc.rule}${e.calc.segments?.[0]?.slab ? `, band ${e.calc.segments.map((s: any) => s.slab).join(' + ')}` : ''}` : '')}</span> },
            ]} />
          <LoadMore shown={led.items.length} hasMore={led.hasMore} loading={led.loadingMore} onMore={led.loadMore} noun="entries" />
        </>
      )}
    </div>
  );
}
