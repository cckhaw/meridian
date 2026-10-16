'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LargeTitle, Segmented, Spinner, Stat, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { dt, label, money, toInput, toMinor } from '@/lib/format';

export default function StoreDesk() {
  const [tab, setTab] = useState('sales');
  return (
    <>
      <LargeTitle subtitle="How the store is selling, and the end-of-day cash count.">Store desk</LargeTitle>
      <div className="mb-4"><Segmented label="Store desk" value={tab} options={[{ value: 'sales', label: 'Sales' }, { value: 'drawer', label: 'Cash drawer' }]} onChange={setTab} /></div>
      {tab === 'sales' ? <Sales /> : <Drawer />}
    </>
  );
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
function Sales() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const s = useApi<any>(`/store/sales?from=${from}&to=${to}`);
  const d = s.data;
  return (
    <div className="grid gap-4">
      <div className="grid max-w-md grid-cols-2 gap-3"><Field label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field></div>
      {s.error && <Alert>{s.error}</Alert>}{s.loading && !d && <Spinner />}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Orders" value={d.totals.orders} /><Stat label="Sales" value={money(d.totals.salesMinor, d.currency)} /><Stat label="Cash taken" value={money(d.totals.cashMinor, d.currency)} />
            <Stat label="Commission earned" value={money(d.commissionMinor, d.currency)} sub="Attributed to these sales" />
          </div>
          {d.totals.orders === 0 && <Empty>No sales in this period.</Empty>}
          {d.byDay.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-3">
              <Table title="By day" head={['Day', 'Orders', 'Sales']} rows={d.byDay.map((r: any) => [r.day, r.orders, money(r.salesMinor, d.currency)])} />
              <Table title="By salesperson" head={['Salesperson', 'Orders', 'Sales']} rows={d.bySalesperson.map((r: any) => [r.salesperson, r.orders, money(r.salesMinor, d.currency)])} />
              <Table title="By payment method" head={['Method', 'Payments', 'Amount']} rows={d.byMethod.map((r: any) => [label(r.method), r.payments, money(r.amountMinor, d.currency)])} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
function Table({ title, head, rows }: { title: string; head: string[]; rows: Array<Array<string | number>> }) {
  return (
    <Card className="p-0 sm:p-0"><h2 className="px-5 pt-4 text-headline font-semibold">{title}</h2>
      <TableWrap><thead><tr>{head.map((h, i) => <Th key={h} right={i > 0}>{h}</Th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <Td key={j} right={j > 0}>{c}</Td>)}</tr>)}</tbody></TableWrap></Card>
  );
}

function Drawer() {
  const [date, setDate] = useState(iso(new Date()));
  const st = useApi<any>(`/store/cash-drawer?date=${date}`);
  const act = useAction(st.reload);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const d = st.data;
  const variance = d && counted !== '' ? toMinor(counted) - d.expectedMinor : null;
  return (
    <div className="grid max-w-3xl gap-4">
      {(st.error || act.error) && <Alert>{st.error || act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <div className="max-w-xs"><Field label="Business day"><Input type="date" value={date} max={iso(new Date())} onChange={(e) => setDate(e.target.value)} /></Field></div>
      {st.loading && !d && <Spinner />}
      {d && (
        <Card>
          <div className="grid grid-cols-2 gap-3"><Stat label="Expected in the drawer" value={money(d.expectedMinor, d.currency)} sub="Cash taken less cash refunded" />
            {d.closing && <Stat label="Counted" value={money(d.closing.countedMinor, d.currency)} sub={`Closed by ${d.closing.closedBy}, ${dt(d.closing.closedAt)}`} tone={d.closing.varianceMinor === 0 ? 'success' : 'danger'} />}</div>
          {d.closing ? (
            <p className="mt-3 text-subhead">{d.closing.varianceMinor === 0 ? 'The count matched.' : <>Difference <b>{money(d.closing.varianceMinor, d.currency)}</b>{d.closing.note ? `: ${d.closing.note}` : ''}</>}</p>
          ) : (
            <div className="mt-4 grid gap-3">
              <Field label="Cash counted"><Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder={toInput(d.expectedMinor)} /></Field>
              {variance !== null && variance !== 0 && <><Alert tone="info">{variance < 0 ? 'Short' : 'Over'} by {money(Math.abs(variance), d.currency)}. Add a note to close.</Alert><Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field></>}
              <div><Button disabled={act.busy || counted === '' || (variance !== 0 && !note.trim())} onClick={async () => { await act.run(() => post('/store/cash-drawer/close', { date, countedMinor: toMinor(counted), note: note || undefined }), 'Day closed'); setCounted(''); setNote(''); }}>Close the day</Button></div>
            </div>
          )}
        </Card>
      )}
      {d?.history?.length > 0 && (
        <TableWrap><thead><tr><Th>Day</Th><Th right>Expected</Th><Th right>Counted</Th><Th right>Difference</Th><Th>Closed by</Th></tr></thead>
          <tbody>{d.history.map((h: any) => <tr key={h.id}><Td>{h.businessDate}</Td><Td right>{money(h.expectedMinor, h.currency)}</Td><Td right>{money(h.countedMinor, h.currency)}</Td><Td right>{h.varianceMinor === 0 ? <Badge tone="success">Matched</Badge> : <Badge tone="danger">{money(h.varianceMinor, h.currency)}</Badge>}</Td><Td className="text-label2">{h.closedBy}</Td></tr>)}</tbody></TableWrap>
      )}
    </div>
  );
}
