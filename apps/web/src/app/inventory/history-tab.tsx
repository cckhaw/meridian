'use client';
import { Alert, Badge, Empty, LoadMore, SearchField, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt } from '@/lib/format';
import { REASONS } from './stock-tab';
import { useLocations } from './locations';

const KINDS: Array<[string, string]> = [['RECEIPT', 'Received'], ['IMPORT', 'CSV batch'], ['COUNT', 'Count (CSV)'], ['WRITE_OFF', 'Written off'], ['TRANSFER_OUT', 'Transferred out'], ['TRANSFER_IN', 'Transferred in'], ['TRANSFER_SHORT', 'Short on arrival']];

/** The history of stock movements: who received or wrote off what, where and why. */
export function HistoryTab() {
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const [loc, setLoc] = useState('');
  const [kind, setKind] = useState('');
  const term = useDebounced(q.trim());
  const locations = useLocations();
  const list = usePaged(`/inventory/movements?limit=50&locationId=${encodeURIComponent(loc)}&kind=${kind}&sku=${encodeURIComponent(term)}`);
  const reason = (r: string | null) => REASONS.find(([v]) => v === r)?.[1] ?? r ?? '';
  return (
    <>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <SearchField label="Search SKU" placeholder="SKU starts with…" value={q} onChange={setQ} className="md:max-w-md md:flex-1" />
        {!me?.storeId && <Select aria-label="Location" value={loc} onChange={(e) => setLoc(e.target.value)} className="md:max-w-[240px]"><option value="">All locations</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</Select>}
        <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} className="md:max-w-[200px]"><option value="">All movements</option>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
      </div>
      {list.error && <Alert>{list.error}</Alert>}{list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>No stock movements yet. Receipts, CSV loads, write-offs and transfers appear here.</Empty>}
      {list.items.length > 0 && (
        <>
          <TableWrap><thead><tr><Th>When</Th><Th>Location</Th><Th>SKU</Th><Th>Movement</Th><Th right>Change</Th><Th right>On hand after</Th><Th>By</Th></tr></thead><tbody>
            {list.items.map((m: any) => (
              <tr key={m.id}>
                <Td>{dt(m.at)}</Td><Td>{m.locationId}</Td><Td className="font-mono">{m.sku}</Td>
                <Td><Badge tone={m.kind === 'WRITE_OFF' ? 'danger' : 'neutral'}>{KINDS.find(([v]) => v === m.kind)?.[1] ?? m.kind}</Badge>{(m.reason || m.note) && <div className="text-caption text-label2">{[reason(m.reason), m.note].filter(Boolean).join(' · ')}</div>}</Td>
                <Td right className={m.delta < 0 ? 'font-semibold text-danger' : ''}>{m.delta > 0 ? `+${m.delta}` : m.delta}</Td><Td right>{m.onHand}</Td><Td>{m.actor}</Td>
              </tr>
            ))}
          </tbody></TableWrap>
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="movements" />
        </>
      )}
    </>
  );
}
