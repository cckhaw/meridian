'use client';
import { Alert, Badge, Button, Empty, LargeTitle, LoadMore, SearchField, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label, money, tone } from '@/lib/format';

const STATES = ['', 'PAYMENT_PENDING', 'FULFILMENT', 'AWAITING_INSTALLATION', 'SHIPPED', 'COMPLETED', 'CANCELLED', 'FAILED'];

export default function Orders() {
  const { can } = useAuth();
  const [state, setState] = useState('');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const list = usePaged(`/orders?limit=25&state=${state}&q=${encodeURIComponent(term)}`);
  return (
    <>
      <LargeTitle subtitle="Newest first. Search by customer name, mobile number, e-mail or an order id.">Orders</LargeTitle>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <SearchField label="Search orders" placeholder="Customer, mobile number or order number (20261014-00042)…" value={q} onChange={setQ} className="md:max-w-md md:flex-1" />
        <Select aria-label="State" value={state} onChange={(e) => setState(e.target.value)} className="md:max-w-[220px]">{STATES.map((s) => <option key={s} value={s}>{s ? label(s) : 'All states'}</option>)}</Select>
        {can('order:create:SELF_SERVE', 'order:create:RETAIL_ASSISTED', 'order:create:QUICK_SALE', 'order:create:TELESALES', 'order:create:DEALER', 'order:create:CALL_CENTER') && <Link href="/orders/new" className="md:ml-auto"><Button>New order</Button></Link>}
      </div>
      {list.error && <Alert>{list.error}</Alert>}
      {list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>{term || state ? 'No orders match.' : 'No orders yet.'}</Empty>}
      {list.items.length > 0 && (
        <>
          <TableWrap><thead><tr><Th>Order</Th><Th>Customer</Th><Th>Items</Th><Th>Channel</Th><Th>State</Th><Th right>Total</Th><Th>Placed</Th></tr></thead><tbody>
            {list.items.map((o: any) => (
              <tr key={o.id}><Td><Link className="font-mono text-accent" href={`/orders/${o.id}`}>{o.number ?? o.id.slice(0, 8)}</Link></Td>
                <Td><Link className="text-accent" href={`/customers/${o.customerId}`}>{o.customerName}</Link></Td><Td className="max-w-xs">{o.summary}</Td>
                <Td>{label(o.channel)}</Td><Td><Badge tone={tone(o.state)}>{label(o.state)}</Badge></Td><Td right>{money(o.totalMinor, o.currency)}</Td><Td>{dt(o.createdAt)}</Td></tr>
            ))}
          </tbody></TableWrap>
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="orders" />
        </>
      )}
    </>
  );
}
