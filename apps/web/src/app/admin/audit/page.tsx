'use client';
import { Alert, Empty, LargeTitle, LoadMore, SearchField, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { useDebounced, usePaged } from '@/lib/api';
import { dt } from '@/lib/format';

const ENTITIES = ['customer', 'order', 'invoice', 'case', 'user', 'kyc', 'catalog', 'inventory', 'gl', 'settings', 'authz'];

export default function Audit() {
  const [actor, setActor] = useState('');
  const [entity, setEntity] = useState('');
  const who = useDebounced(actor.trim());
  const list = usePaged(`/audit?limit=50&actor=${encodeURIComponent(who)}&entity=${encodeURIComponent(entity)}`);
  return (
    <>
      <LargeTitle subtitle="Who did what, newest first. Filter by exact username or record type.">Audit log</LargeTitle>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <SearchField label="Filter by username" placeholder="Username (exact)…" value={actor} onChange={setActor} className="md:max-w-sm md:flex-1" />
        <Select aria-label="Record type" value={entity} onChange={(e) => setEntity(e.target.value)} className="md:max-w-[220px]"><option value="">All record types</option>{ENTITIES.map((e) => <option key={e}>{e}</option>)}</Select>
      </div>
      {list.error && <Alert>{list.error}</Alert>}{list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>{who || entity ? 'Nothing matches.' : 'Nothing recorded yet.'}</Empty>}
      {list.items.length > 0 && (
        <>
          <TableWrap><thead><tr><Th>When</Th><Th>Actor</Th><Th>Entity</Th><Th>Action</Th><Th>Detail</Th></tr></thead><tbody>
            {list.items.map((a: any) => <tr key={a.id}><Td className="whitespace-nowrap">{dt(a.at)}</Td><Td>{a.actor}</Td><Td><span className="font-mono">{a.entity} {a.entityId.slice(0, 8)}</span></Td><Td>{a.action}</Td><Td className="font-mono text-caption text-label2">{JSON.stringify(a.detail)}</Td></tr>)}
          </tbody></TableWrap>
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="entries" />
        </>
      )}
    </>
  );
}
