'use client';
import { Alert, Empty, LargeTitle, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useApi } from '@/lib/api';
import { money } from '@/lib/format';

export default function Commission() {
  const { data, error, loading } = useApi('/commissions');
  return (
    <>
      <LargeTitle subtitle="Accrued on completed orders, attributed to store and salesperson or dealer">Commission</LargeTitle>
      {error && <Alert>{error}</Alert>}{loading && !data && <Spinner />}
      {data && (data.length === 0 ? <Empty>No commission accrued yet. Complete an order with a salesperson or dealer attached.</Empty> : (
        <TableWrap><thead><tr><Th>Store</Th><Th>Agent / dealer</Th><Th right>Orders</Th><Th right>Basis</Th><Th right>Commission</Th></tr></thead><tbody>
          {data.map((r: any, i: number) => <tr key={i}><Td>{r.storeId}</Td><Td>{r.agent}</Td><Td right>{r.orders}</Td><Td right>{money(r.basisMinor, r.currency)}</Td><Td right className="font-semibold">{money(r.commissionMinor, r.currency)}</Td></tr>)}
        </tbody></TableWrap>
      ))}
    </>
  );
}
