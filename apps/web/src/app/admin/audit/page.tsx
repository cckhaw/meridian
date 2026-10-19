'use client';
import { Alert, Empty, LargeTitle, LoadMore, SearchField, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useEffect, useState } from 'react';
import { api, useDebounced, usePaged } from '@/lib/api';
import { dt } from '@/lib/format';

/** Plain names for the record types the system writes to the audit log (the value sent to the API is the key). */
const ENTITY_LABELS: Record<string, string> = {
  account: 'Billing account', api_client: 'API client', application: 'Store application', auth: 'Sign-in and security', authz: 'Access denied', bill_template: 'Bill template',
  billing: 'Billing run', blacklist: 'Blacklist', case: 'Case', case_sla: 'Case service level', case_taxonomy: 'Case categories', catalog: 'Catalogue', coa_mapping: 'Ledger account mapping',
  collection_placement: 'Collections placement', commission: 'Commission', commission_plan: 'Commission plan', credit_check: 'Credit check', customer: 'Customer', customer_segment: 'Customer segment',
  dealer: 'Dealer', dealer_agent: 'Dealer agent', document: 'Document', donor_operator: 'Donor operator', dunning_rule: 'Dunning rule', etc_rule: 'Early-termination rule', event_topic: 'Event topic',
  fraud_alert: 'Fraud alert', fulfilment_option: 'Fulfilment option', gl: 'General ledger', integration_endpoint: 'Integration connection', interaction: 'Customer interaction', inventory: 'Inventory',
  invoice: 'Invoice', kyc_case: 'Identity check (KYC)', late_fee: 'Late fee', ledger_event: 'Ledger event', migration: 'Data migration', numbering: 'Numbering', oauth_client: 'API sign-in client',
  offer_type: 'Offer type', order: 'Order', payment_arrangement: 'Payment arrangement', payment_intent: 'Online payment', port_in: 'Number porting (port-in)', print_job: 'Print job',
  rate_limit: 'Rate limit', role: 'Role', service: 'Service', service_group: 'Service group', service_kind: 'Service kind', settings: 'Settings', stock_transfer: 'Stock transfer',
  store: 'Store', user: 'User', warehouse: 'Warehouse', webhook: 'Webhook',
};
/** A name for a type this screen has no wording for yet: "some_thing" reads "Some thing". */
const entityLabel = (e: string) => ENTITY_LABELS[e] ?? (e.charAt(0).toUpperCase() + e.slice(1).replace(/_/g, ' '));
const sortedTypes = (types: string[]) => [...new Set(types)].sort((a, b) => entityLabel(a).localeCompare(entityLabel(b)));

export default function Audit() {
  const [actor, setActor] = useState('');
  const [entity, setEntity] = useState('');
  const [types, setTypes] = useState<string[]>(Object.keys(ENTITY_LABELS));   // until the real list arrives
  useEffect(() => { api<{ items: string[] }>('/audit/entities').then((r) => setTypes(r.items)).catch(() => {}); }, []);
  const who = useDebounced(actor.trim());
  const list = usePaged(`/audit?limit=50&actor=${encodeURIComponent(who)}&entity=${encodeURIComponent(entity)}`);
  return (
    <>
      <LargeTitle subtitle="Who did what, newest first. Filter by exact username or record type.">Audit log</LargeTitle>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <SearchField label="Filter by username" placeholder="Username (exact)…" value={actor} onChange={setActor} className="md:max-w-sm md:flex-1" />
        <Select aria-label="Record type" value={entity} onChange={(e) => setEntity(e.target.value)} className="md:max-w-[220px]"><option value="">All record types</option>{sortedTypes(entity && !types.includes(entity) ? [...types, entity] : types).map((e) => <option key={e} value={e}>{entityLabel(e)}</option>)}</Select>
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
