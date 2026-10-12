'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LargeTitle, Segmented, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { label } from '@/lib/format';

const SEGMENTS = [{ value: '', label: 'All' }, { value: 'CONSUMER', label: 'Consumer' }, { value: 'FAMILY', label: 'Family' }, { value: 'ENTERPRISE', label: 'Enterprise' }, { value: 'IOT_ENTERPRISE', label: 'IoT' }];

export default function Customers() {
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState('');
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const { data, error, loading } = useApi(`/customers?limit=25&offset=${offset}&q=${encodeURIComponent(q)}&segment=${segment}`);
  return (
    <>
      <LargeTitle subtitle="Search by name, phone, email or mobile number">Customers</LargeTitle>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input type="search" aria-label="Search customers" placeholder="Search…" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} className="sm:max-w-sm" />
        <Segmented label="Segment" value={segment} options={SEGMENTS} onChange={(v) => { setSegment(v); setOffset(0); }} />
        <Button className="sm:ml-auto" onClick={() => setAdding((a) => !a)}>{adding ? 'Close' : 'New customer'}</Button>
      </div>
      {adding && <NewCustomer onDone={() => setAdding(false)} />}
      {error && <Alert>{error}</Alert>}
      {loading && !data && <Spinner />}
      {data && (data.items.length === 0 ? <Empty>No customers match.</Empty> : (
        <>
          <TableWrap>
            <thead><tr><Th>Name</Th><Th>Segment</Th><Th>Contact</Th><Th right>Services</Th><Th right>Sub-accounts</Th></tr></thead>
            <tbody>
              {data.items.map((c: any) => (
                <tr key={c.id}>
                  <Td><Link className="font-medium text-accent" href={`/customers/${c.id}`}>{c.displayName}</Link></Td>
                  <Td><Badge>{label(c.segment)}</Badge></Td>
                  <Td className="text-label2">{c.email ?? c.phone ?? '–'}</Td>
                  <Td right>{c.serviceCount.toLocaleString()}</Td><Td right>{c.childCount || '–'}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <div className="mt-4 flex items-center justify-between text-subhead text-label2">
            <span>{offset + 1}–{Math.min(offset + 25, data.total)} of {data.total.toLocaleString()}</span>
            <span className="flex gap-2">
              <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</Button>
              <Button variant="secondary" disabled={offset + 25 >= data.total} onClick={() => setOffset(offset + 25)}>Next</Button>
            </span>
          </div>
        </>
      ))}
    </>
  );
}

function NewCustomer({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [f, setF] = useState({ segment: 'CONSUMER', displayName: '', idDocument: '', email: '', phone: '', billCycleDay: '1' });
  const { run, busy, error } = useAction();
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => post('/customers', { ...f, account: { billCycleDay: f.billCycleDay === 'daily' ? null : Number(f.billCycleDay) } }));
    if (r) { onDone(); router.push(`/customers/${r.customer.id}`); }
  };
  return (
    <Card className="mb-6">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Segment"><Select value={f.segment} onChange={set('segment')}>{SEGMENTS.slice(1).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></Field>
        <Field label="Full name / company"><Input required value={f.displayName} onChange={set('displayName')} /></Field>
        <Field label="ID document (NRIC / passport / UEN)" hint="Stored masked; a keyed hash detects duplicates."><Input required minLength={3} value={f.idDocument} onChange={set('idDocument')} /></Field>
        <Field label="Bill cycle day" hint="Monthly cycle day, or a daily cycle."><Select value={f.billCycleDay} onChange={set('billCycleDay')}>{[...Array(28)].map((_, i) => <option key={i} value={i + 1}>Day {i + 1}</option>)}<option value="daily">Daily</option></Select></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Phone"><Input type="tel" value={f.phone} onChange={set('phone')} /></Field>
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <div className="sm:col-span-2"><Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create customer'}</Button></div>
      </form>
    </Card>
  );
}
