'use client';
import { Alert, Empty, LargeTitle, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useApi } from '@/lib/api';
import { dt } from '@/lib/format';

export default function Audit() {
  const { data, error, loading } = useApi('/audit?limit=200');
  return (
    <>
      <LargeTitle subtitle="Who did what, newest first">Audit log</LargeTitle>
      {error && <Alert>{error}</Alert>}{loading && !data && <Spinner />}
      {data && (data.length === 0 ? <Empty>Nothing recorded yet.</Empty> : (
        <TableWrap><thead><tr><Th>When</Th><Th>Actor</Th><Th>Entity</Th><Th>Action</Th><Th>Detail</Th></tr></thead><tbody>
          {data.map((a: any) => <tr key={a.id}><Td className="whitespace-nowrap">{dt(a.at)}</Td><Td>{a.actor}</Td><Td><span className="font-mono">{a.entity} {a.entityId.slice(0, 8)}</span></Td><Td>{a.action}</Td><Td className="font-mono text-caption text-label2">{JSON.stringify(a.detail)}</Td></tr>)}
        </tbody></TableWrap>
      ))}
    </>
  );
}
