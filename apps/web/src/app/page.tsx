'use client';
import { Alert, Badge, Card, LargeTitle, SectionTitle, Spinner, Stat, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label, money, tone } from '@/lib/format';
import { useOfferTypes } from '@/lib/offer-types';

/** Overview. The API returns only the sections this role may see, and the page renders exactly what came back. */
export default function Home() {
  const types = useOfferTypes();
  const { me, can } = useAuth();
  const { data: d, error, loading } = useApi('/dashboard');
  const has = (k: string) => d && d[k] !== undefined;
  return (
    <>
      <LargeTitle subtitle={me ? `${me.displayName} · ${me.roleLabels.join(', ')}` : undefined}>Overview</LargeTitle>
      {error && <Alert>{error}</Alert>}
      {loading && !d && <Spinner />}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {has('customers') && <Stat label="Customers" value={d.customers.toLocaleString()} />}
            {has('activeServices') && <Stat label="Active services" value={d.activeServices.toLocaleString()} sub={`${d.suspendedServices} suspended`} />}
            {has('mrrMinor') && <Stat label="Monthly recurring revenue" value={money(d.mrrMinor)} sub="list price, active services" />}
            {has('openOrders') && <Stat label="Open orders" value={d.openOrders} />}
            {has('receivableMinor') && <Stat label="Receivables" value={money(d.receivableMinor)} />}
            {has('overdueMinor') && <Stat label="Overdue" value={money(d.overdueMinor)} tone={d.overdueMinor > 0 ? 'danger' : undefined} />}
            {has('ledgerRevenueMinor') && <Stat label="Ledger revenue" value={money(d.ledgerRevenueMinor)} sub="net of credit notes" />}
            {has('openCases') && <Stat label="Open cases" value={d.openCases} />}
          </div>

          {has('recentOrders') && (
            <>
              <SectionTitle action={can('order:create:SELF_SERVE', 'order:create:RETAIL_ASSISTED', 'order:create:QUICK_SALE', 'order:create:TELESALES', 'order:create:DEALER', 'order:create:CALL_CENTER') ? <Link href="/orders/new" className="text-subhead font-medium text-accent">New order</Link> : undefined}>Recent orders</SectionTitle>
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
                  {d.recentOrders.length === 0 && <tr><Td className="text-label2">No orders yet.</Td><Td /><Td /><Td /></tr>}
                </tbody>
              </TableWrap>
            </>
          )}

          {has('topOffers') && d.topOffers.length > 0 && (
            <>
              <SectionTitle>Top offers by active services</SectionTitle>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {d.topOffers.map((o: any) => (
                  <Card key={o.offerId} className="!p-4">
                    <p className="font-medium">{o.name}</p>
                    <p className="text-footnote text-label2">{types.name(o.kind)}</p>
                    <p className="mt-2 text-title3 font-semibold tabular-nums">{o.services.toLocaleString()} <span className="text-subhead font-normal text-label2">services · {money(o.mrrMinor)}/mo</span></p>
                  </Card>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
