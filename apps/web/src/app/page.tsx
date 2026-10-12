'use client';
import { Alert, Badge, Card, LargeTitle, SectionTitle, Spinner, Stat, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useApi } from '@/lib/api';
import { dt, label, money, tone } from '@/lib/format';

export default function Home() {
  const { data: d, error, loading } = useApi('/dashboard');
  return (
    <>
      <LargeTitle subtitle="Live view of customers, orders, billing and the ledger">Meridian</LargeTitle>
      {error && <Alert>{error}</Alert>}
      {loading && !d && <Spinner />}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Stat label="Customers" value={d.customers.toLocaleString()} />
            <Stat label="Active services" value={d.activeServices.toLocaleString()} sub={`${d.suspendedServices} suspended`} />
            <Stat label="Monthly recurring revenue" value={money(d.mrrMinor)} sub="list price, active services" />
            <Stat label="Open orders" value={d.openOrders} />
            <Stat label="Receivables" value={money(d.receivableMinor)} />
            <Stat label="Overdue" value={money(d.overdueMinor)} tone={d.overdueMinor > 0 ? 'danger' : undefined} />
            <Stat label="Ledger revenue" value={money(d.ledgerRevenueMinor)} sub="net of credit notes" />
            <Stat label="Open cases" value={d.openCases} />
          </div>

          <SectionTitle action={<Link href="/orders/new" className="text-subhead font-medium text-accent">New order</Link>}>Recent orders</SectionTitle>
          <TableWrap>
            <thead><tr><Th>Customer</Th><Th>State</Th><Th right>Total</Th><Th>Placed</Th></tr></thead>
            <tbody>
              {d.recentOrders.map((o: any) => (
                <tr key={o.id}>
                  <Td><Link className="font-medium text-accent" href={`/orders/${o.id}`}>{o.customerName}</Link></Td>
                  <Td><Badge tone={tone(o.state)}>{label(o.state)}</Badge></Td>
                  <Td right>{money(o.totalMinor, o.currency)}</Td><Td>{dt(o.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>

          <SectionTitle>Top offers by active services</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {d.topOffers.map((o: any) => (
              <Card key={o.offerId} className="!p-4">
                <p className="font-medium">{o.name}</p>
                <p className="text-footnote text-label2">{label(o.kind)}</p>
                <p className="mt-2 text-title3 font-semibold tabular-nums">{o.services.toLocaleString()} <span className="text-subhead font-normal text-label2">services · {money(o.mrrMinor)}/mo</span></p>
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  );
}
