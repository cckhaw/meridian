'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LargeTitle, SectionTitle, Select, Spinner, Stat, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { d, dt, label, money, tone } from '@/lib/format';
import { AccountPane } from './account-pane';
import { CasesPanel } from './cases-panel';
import { HierarchyNav } from './hierarchy-nav';
import { ServicesTable } from './services-panel';

const CHANNEL_PERMS = ['SELF_SERVE', 'RETAIL_ASSISTED', 'QUICK_SALE', 'TELESALES', 'DEALER', 'CALL_CENTER'].map((c) => `order:create:${c}`);

/**
 * One customer's 360 view, with the hierarchy always in reach: Group → Customer → Account → Service. The tree on the left walks it (and loads only what
 * you open); the right shows whatever you picked. The selection is in the address (?account=…&service=…) so it can be linked and Back works.
 * Staff reach it from Customers; a portal customer sees only their own through /account. Sections follow the user's permissions.
 */
export function CustomerView({ id }: { id: string }) {
  const { can } = useAuth();
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const accountId = sp.get('account'), serviceId = accountId ? sp.get('service') : null;
  const { data: c, error, loading, reload } = useApi<any>(`/customers/${id}`);
  const [navOpen, setNavOpen] = useState(false);

  const select = useCallback((account: string | null, service?: string | null) => {
    const q = new URLSearchParams();
    if (account) q.set('account', account);
    if (account && service) q.set('service', service);
    router.push(`${path}${q.size ? `?${q}` : ''}`, { scroll: false });
    setNavOpen(false);
  }, [router, path]);

  if (error) return <Alert>{error}</Alert>;
  if (loading && !c) return <Spinner />;
  if (!c) return null;
  const cust = c.customer;
  const canBrowse = can('customer:search');
  const acctName: string | undefined = c.accounts.find((a: any) => a.id === accountId)?.name;
  const trail = [...(canBrowse ? c.memberOf.slice(0, 1).map((g: any) => ({ label: g.displayName, href: `/customers/${g.id}` })) : []), { label: cust.displayName, href: accountId ? path : undefined },
    ...(accountId ? [{ label: acctName ?? 'Account', href: serviceId ? `${path}?account=${accountId}` : undefined }] : []), ...(serviceId ? [{ label: 'Service' }] : [])];

  return (
    <>
      <LargeTitle subtitle={<span className="flex flex-wrap items-center gap-2"><Badge>{label(cust.segment)}</Badge><Badge tone={tone(cust.status)}>{label(cust.status)}</Badge><Badge tone={cust.kycStatus === 'VERIFIED' ? 'success' : 'warning'}>{cust.kycStatus === 'VERIFIED' ? 'KYC verified' : 'KYC not verified'}</Badge><span>{cust.email ?? 'no email'} · {cust.phone ?? 'no phone'} · ID {cust.idDocumentRef}</span></span>}>{cust.displayName}</LargeTitle>

      <div className="mb-4 flex items-center justify-between gap-3 lg:hidden">
        <nav aria-label="Where you are" className="min-w-0 flex-1 truncate text-subhead text-label2">{trail.map((t, i) => <span key={i}>{i > 0 && ' › '}{t.label}</span>)}</nav>
        <Button variant="secondary" className="!min-h-[36px] shrink-0 !px-3 !text-subhead" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}>{navOpen ? 'Hide hierarchy' : 'Hierarchy'}</Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(280px,340px)_1fr] lg:items-start">
        <aside className={`${navOpen ? 'block' : 'hidden'} min-w-0 lg:sticky lg:top-6 lg:block lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto`}>
          <HierarchyNav customer={cust} ancestors={c.ancestors} groups={c.memberOf} counts={{ accounts: c.accountCount, children: c.childCount, members: c.memberCount }}
            canBrowse={canBrowse} canBilling={can('billing:read')} accountId={accountId} serviceId={serviceId} onAccount={(a) => select(a)} onService={(a, s) => select(a, s)} />
        </aside>

        <div className="min-w-0">
          <nav aria-label="Breadcrumb" className="mb-3 hidden flex-wrap items-center gap-1 text-subhead text-label2 lg:flex">
            {trail.map((t, i) => (
              <span key={i} className="flex items-center gap-1">{i > 0 && <span aria-hidden>›</span>}
                {t.href ? (t.href.startsWith('/customers/') ? <Link className="hover:text-label" href={t.href}>{t.label}</Link> : <button className="hover:text-label" onClick={() => select(t.href!.includes('account=') ? accountId : null)}>{t.label}</button>) : <span className="font-medium text-label" aria-current="page">{t.label}</span>}
              </span>
            ))}
          </nav>
          {accountId
            ? <AccountPane key={accountId} accountId={accountId} serviceId={serviceId} canBilling={can('billing:read')} onChange={() => void reload()} onClearService={() => select(accountId)} />
            : <Overview c={c} id={id} onPick={(a) => select(a)} reload={reload} />}
        </div>
      </div>
    </>
  );
}

function Overview({ c, id, onPick, reload }: { c: any; id: string; onPick: (accountId: string) => void; reload: () => Promise<void> }) {
  const { can } = useAuth();
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {can('billing:read') && <Stat label="Outstanding" value={money(c.outstandingMinor)} />}
        {can('billing:read') && <Stat label="Overdue" value={money(c.overdueMinor)} tone={c.overdueMinor > 0 ? 'danger' : undefined} />}
        <Stat label="Accounts" value={c.accountCount.toLocaleString()} />
        <Stat label="Services" value={c.serviceSummary.filter((s: any) => s.status !== 'TERMINATED').reduce((n: number, s: any) => n + s.n, 0).toLocaleString()} sub={c.serviceSummary.map((s: any) => `${s.n.toLocaleString()} ${s.type.toLowerCase()} ${s.status.toLowerCase()}`).join(' · ')} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {can(...CHANNEL_PERMS) && <Link href={`/orders/new?customerId=${id}`}><Button>New order</Button></Link>}
        {can('billing:read') && <Link href={`/billing?customerId=${id}`}><Button variant="secondary">Invoices</Button></Link>}
      </div>

      {c.recommendations.length > 0 && (
        <>
          <SectionTitle>Next best actions</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {c.recommendations.map((r: any) => (
              <Card key={r.id} className="!p-4">
                <Badge tone={r.kind === 'COLLECTIONS' ? 'danger' : r.kind === 'RETENTION' ? 'warning' : 'neutral'}>{label(r.kind)}</Badge>
                <p className="mt-2 font-medium">{r.title}</p>
                <p className="text-footnote text-label2">{r.reason}</p>
                {r.offerId && <Link className="mt-2 inline-block text-subhead text-accent" href={`/orders/new?customerId=${id}&offerId=${r.offerId}`}>Start order</Link>}
              </Card>
            ))}
          </div>
          <p className="mt-2 text-caption text-label2">Rules-based today (contract end, product gaps, arrears); the same shape can be fed by a model later.</p>
        </>
      )}

      <SectionTitle>Accounts</SectionTitle>
      <ul className="grid gap-3 sm:grid-cols-2">
        {c.accounts.map((a: any) => (
          <li key={a.id}>
            <button onClick={() => onPick(a.id)} className="flex w-full items-center gap-3 rounded-card bg-surface p-4 text-left shadow-card transition active:scale-[0.99] hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2"><span className="truncate font-medium">{a.name}</span><Badge tone={tone(a.status)}>{label(a.status)}</Badge>{a.dunningStage > 0 && <Badge tone="danger">Dunning {a.dunningStage}</Badge>}</span>
                <span className="block text-footnote text-label2">{a.billCycleDay ? `Day ${a.billCycleDay}` : 'Daily'} · {a.serviceCount.toLocaleString()} service{a.serviceCount === 1 ? '' : 's'}{a.balanceMinor !== null && a.balanceMinor !== undefined ? ` · ${money(a.balanceMinor, a.currency)} due` : ''}</span>
              </span>
              <span aria-hidden className="text-label2">›</span>
            </button>
          </li>
        ))}
      </ul>
      {c.accountCount > c.accounts.length && <p className="mt-2 text-footnote text-label2">Showing the first {c.accounts.length} of {c.accountCount.toLocaleString()} accounts. Use the hierarchy on the left to search the rest.</p>}
      {can('customer:write') && <AddAccount customerId={id} onDone={reload} />}

      {can('service:read') && <div className="mt-6"><ServicesTable customerId={id} onChange={() => void reload()} /></div>}

      {can('order:read') && <><SectionTitle>Recent orders</SectionTitle>
      {c.recentOrders.length === 0 ? <Empty>No orders yet.</Empty> : (
        <TableWrap><thead><tr><Th>Order</Th><Th>Items</Th><Th>State</Th><Th right>Total</Th><Th>Placed</Th></tr></thead><tbody>
          {c.recentOrders.map((o: any) => <tr key={o.id}><Td><Link className="font-mono text-accent" href={`/orders/${o.id}`}>{o.id.slice(0, 8)}</Link></Td><Td>{o.summary}</Td><Td><Badge tone={tone(o.state)}>{label(o.state)}</Badge></Td><Td right>{money(o.totalMinor, o.currency)}</Td><Td>{dt(o.createdAt)}</Td></tr>)}
        </tbody></TableWrap>
      )}</>}

      {can('billing:read') && <><SectionTitle>Recent invoices</SectionTitle>
      {c.recentInvoices.length === 0 ? <Empty>No invoices yet. They appear after the first bill run.</Empty> : (
        <TableWrap><thead><tr><Th>Invoice</Th><Th>Issued</Th><Th>Due</Th><Th>Status</Th><Th right>Total</Th><Th right>Balance</Th></tr></thead><tbody>
          {c.recentInvoices.map((i: any) => <tr key={i.id}><Td><Link className="font-medium text-accent" href={`/billing/${i.id}`}>{i.number}</Link></Td><Td>{d(i.issueDate)}</Td><Td>{d(i.dueDate)}</Td><Td><Badge tone={tone(i.status)}>{label(i.status)}</Badge></Td><Td right>{money(i.totalMinor, i.currency)}</Td><Td right>{money(i.balanceMinor, i.currency)}</Td></tr>)}
        </tbody></TableWrap>
      )}</>}

      {can('case:read') && <CasesPanel customerId={id} cases={c.cases} onChange={() => void reload()} />}
    </>
  );
}

function AddAccount({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [day, setDay] = useState('1');
  const { run, busy, error } = useAction(onDone);
  if (!open) return <Button variant="plain" className="mt-2" onClick={() => setOpen(true)}>Add account</Button>;
  return (
    <Card className="mt-3">
      <form className="grid gap-3 sm:grid-cols-3 sm:items-end" onSubmit={async (e) => { e.preventDefault(); if (await run(() => post(`/customers/${customerId}/accounts`, { name: name || undefined, billCycleDay: day === 'daily' ? null : Number(day) }))) setOpen(false); }}>
        <Field label="Account name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Engineering mobiles" /></Field>
        <Field label="Bill cycle"><Select value={day} onChange={(e) => setDay(e.target.value)}>{[...Array(28)].map((_, i) => <option key={i} value={i + 1}>Day {i + 1}</option>)}<option value="daily">Daily</option></Select></Field>
        <Button type="submit" disabled={busy}>Create</Button>
        {error && <div className="sm:col-span-3"><Alert>{error}</Alert></div>}
      </form>
    </Card>
  );
}
