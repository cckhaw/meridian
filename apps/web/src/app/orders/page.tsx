'use client';
import { Alert, Badge, Button, Empty, LargeTitle, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useApi } from '@/lib/api';
import { dt, label, money, tone } from '@/lib/format';

const STATES = ['', 'PAYMENT_PENDING', 'FULFILMENT', 'AWAITING_INSTALLATION', 'SHIPPED', 'COMPLETED', 'CANCELLED', 'FAILED'];

export default function Orders() {
  const [state, setState] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useApi(`/orders?limit=25&offset=${offset}&state=${state}`);
  return (
    <>
      <LargeTitle subtitle="Order capture through fulfilment and activation">Orders</LargeTitle>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select aria-label="State" value={state} onChange={(e) => { setState(e.target.value); setOffset(0); }} className="sm:max-w-xs">{STATES.map((s) => <option key={s} value={s}>{s ? label(s) : 'All states'}</option>)}</Select>
        <Link href="/orders/new" className="sm:ml-auto"><Button>New order</Button></Link>
      </div>
      {error && <Alert>{error}</Alert>}
      {loading && !data && <Spinner />}
      {data && (data.items.length === 0 ? <Empty>No orders.</Empty> : (
        <>
          <TableWrap><thead><tr><Th>Order</Th><Th>Customer</Th><Th>Items</Th><Th>Channel</Th><Th>State</Th><Th right>Total</Th><Th>Placed</Th></tr></thead><tbody>
            {data.items.map((o: any) => (
              <tr key={o.id}><Td><Link className="font-mono text-accent" href={`/orders/${o.id}`}>{o.id.slice(0, 8)}</Link></Td>
                <Td><Link className="text-accent" href={`/customers/${o.customerId}`}>{o.customerName}</Link></Td><Td className="max-w-xs">{o.summary}</Td>
                <Td>{label(o.channel)}</Td><Td><Badge tone={tone(o.state)}>{label(o.state)}</Badge></Td><Td right>{money(o.totalMinor, o.currency)}</Td><Td>{dt(o.createdAt)}</Td></tr>
            ))}
          </tbody></TableWrap>
          <div className="mt-4 flex items-center justify-between text-subhead text-label2"><span>{data.total.toLocaleString()} orders</span>
            <span className="flex gap-2"><Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</Button><Button variant="secondary" disabled={offset + 25 >= data.total} onClick={() => setOffset(offset + 25)}>Next</Button></span></div>
        </>
      ))}
    </>
  );
}
