'use client';
import { Alert, Badge, Card, Empty, LoadMore, Spinner, Stat, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useApi, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { d, label, money, tone } from '@/lib/format';
import { GroupsPanel } from './groups-panel';
import { ServicePanel, ServicesTable } from './services-panel';

/** One billing account: what it owes, its recent invoices, and its services (searchable, paged). A service opened from the tree appears first. */
export function AccountPane({ accountId, serviceId, canBilling, onChange, onClearService }: { accountId: string; serviceId: string | null; canBilling: boolean; onChange: () => void; onClearService: () => void }) {
  const { can } = useAuth();
  const acct = useApi<any>(`/accounts/${accountId}`);
  const svc = useApi<any>(serviceId ? `/services/${serviceId}` : null);
  const invoices = usePaged<any>(canBilling ? `/invoices?accountId=${accountId}&limit=5` : null);
  if (acct.error) return <Alert>{acct.error}</Alert>;
  if (!acct.data) return <Spinner />;
  const a = acct.data;
  const refresh = () => { void acct.reload(); void svc.reload(); onChange(); };
  return (
    <div className="space-y-5">
      <header>
        <p className="text-footnote font-medium uppercase tracking-wide text-accent">Account</p>
        <h2 className="text-title1 font-bold tracking-tight">{a.name}</h2>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-subhead text-label2">
          <Badge tone={tone(a.status)}>{label(a.status)}</Badge>{a.dunningStage > 0 && <Badge tone="danger">Dunning stage {a.dunningStage}</Badge>}
          <span>{a.billCycleDay ? `Billed on day ${a.billCycleDay}` : 'Billed daily'} · {a.currency}</span>
        </p>
      </header>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {canBilling && a.balanceMinor !== null && <Stat label="Balance due" value={money(a.balanceMinor, a.currency)} tone={a.balanceMinor > 0 ? 'danger' : undefined} />}
        <Stat label="Live services" value={a.serviceCount.toLocaleString()} />
        <Stat label="Account ID" value={a.id.slice(0, 8)} />
      </div>

      {serviceId && (
        <section aria-label="Selected service">
          <div className="mb-2 flex items-center justify-between px-1"><h3 className="text-footnote font-semibold uppercase tracking-wide text-label2">Selected service</h3><button className="text-subhead text-accent" onClick={onClearService}>Done</button></div>
          {svc.error && <Alert>{svc.error}</Alert>}
          {svc.data && (
            <Card className="!p-4">
              <p className="font-mono text-title3 font-semibold">{svc.data.identifier}</p>
              <p className="text-subhead text-label2">{svc.data.offerName} · <Badge tone={tone(svc.data.status)}>{label(svc.data.status)}</Badge>{svc.data.contractTermMonths ? ` · ${svc.data.contractTermMonths}-month contract from ${d(svc.data.contractStart)}` : ' · no contract'}</p>
              {svc.data.status !== 'TERMINATED' && <ServicePanel service={svc.data} accounts={[]} onClose={onClearService} onDone={refresh} />}
            </Card>
          )}
        </section>
      )}

      {canBilling && (
        <section aria-label="Recent invoices">
          <h3 className="mb-2 px-1 text-footnote font-semibold uppercase tracking-wide text-label2">Recent invoices</h3>
          {invoices.loading && invoices.items.length === 0 ? <Spinner /> : invoices.items.length === 0 ? <Empty>No invoices on this account yet.</Empty> : (
            <>
              <TableWrap><thead><tr><Th>Invoice</Th><Th>Issued</Th><Th>Status</Th><Th right>Total</Th><Th right>Balance</Th></tr></thead><tbody>
                {invoices.items.map((i: any) => <tr key={i.id}><Td><Link className="font-medium text-accent" href={`/billing/${i.id}`}>{i.number}</Link></Td><Td>{d(i.issueDate)}</Td><Td><Badge tone={tone(i.status)}>{label(i.status)}</Badge></Td><Td right>{money(i.totalMinor, i.currency)}</Td><Td right>{money(i.totalMinor - i.paidMinor - i.creditedMinor, i.currency)}</Td></tr>)}
              </tbody></TableWrap>
              <LoadMore shown={invoices.items.length} hasMore={invoices.hasMore} loading={invoices.loadingMore} onMore={invoices.loadMore} noun="invoices" />
            </>
          )}
        </section>
      )}

      {can('service:read') && <GroupsPanel accountId={accountId} canManage={can('service:manage')} />}

      <ServicesTable accountId={accountId} onChange={refresh} />
    </div>
  );
}
