'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LargeTitle, Select, SectionTitle, Spinner, Stat, TableWrap, Td, Textarea, Th } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { d, dt, label, money, tone } from '@/lib/format';

const CHANNEL_PERMS = ['SELF_SERVE', 'RETAIL_ASSISTED', 'QUICK_SALE', 'TELESALES', 'DEALER', 'CALL_CENTER'].map((c) => `order:create:${c}`);
const SERVICE_PERMS = ['service:manage', 'service:suspend', 'service:terminate', 'service:transfer', 'mnp:manage'];

/** One customer's 360 view. Staff reach it from Customers; a portal customer sees only their own through /account. Sections follow the user's permissions. */
export function CustomerView({ id }: { id: string }) {
  const { can } = useAuth();
  const { data: c, error, loading, reload } = useApi(`/customers/${id}`);
  if (error) return <Alert>{error}</Alert>;
  if (loading && !c) return <Spinner />;
  if (!c) return null;
  const cust = c.customer;
  return (
    <>
      <LargeTitle subtitle={<span className="flex flex-wrap items-center gap-2"><Badge>{label(cust.segment)}</Badge><Badge tone={tone(cust.status)}>{label(cust.status)}</Badge><span>{cust.email ?? 'no email'} · {cust.phone ?? 'no phone'} · ID {cust.idDocumentRef}</span></span>}>{cust.displayName}</LargeTitle>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {can('billing:read') && <Stat label="Outstanding" value={money(c.outstandingMinor)} />}
        {can('billing:read') && <Stat label="Overdue" value={money(c.overdueMinor)} tone={c.overdueMinor > 0 ? 'danger' : undefined} />}
        <Stat label="Accounts" value={c.accounts.length} />
        <Stat label="Services" value={c.serviceSummary.filter((s: any) => s.status !== 'TERMINATED').reduce((n: number, s: any) => n + s.n, 0).toLocaleString()} sub={c.serviceSummary.map((s: any) => `${s.n.toLocaleString()} ${s.type.toLowerCase()} ${s.status.toLowerCase()}`).join(' · ')} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {can(...CHANNEL_PERMS) && <Link href={`/orders/new?customerId=${id}`}><Button>New order</Button></Link>}
        {can('billing:read') && <Link href={`/billing?customerId=${id}`}><Button variant="secondary">Invoices</Button></Link>}
      </div>

      {c.recommendations.length > 0 && (
        <>
          <SectionTitle>Next best actions</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
      <TableWrap>
        <thead><tr><Th>Account</Th><Th>Bill cycle</Th><Th>Status</Th><Th right>Services</Th><Th right>Balance</Th></tr></thead>
        <tbody>
          {c.accounts.map((a: any) => (
            <tr key={a.id}><Td className="font-medium">{a.name}<div className="font-mono text-caption text-label2">{a.id.slice(0, 8)}</div></Td>
              <Td>{a.billCycleDay ? `Day ${a.billCycleDay}` : 'Daily'}</Td>
              <Td><Badge tone={tone(a.status)}>{label(a.status)}</Badge>{a.dunningStage > 0 && <Badge tone="danger">Dunning {a.dunningStage}</Badge>}</Td>
              <Td right>{a.serviceCount.toLocaleString()}</Td><Td right>{money(a.balanceMinor, a.currency)}</Td></tr>
          ))}
        </tbody>
      </TableWrap>
      {can('customer:write') && <AddAccount customerId={id} onDone={reload} />}

      {can('service:read') && <Services customerId={id} accounts={c.accounts} onChange={reload} />}

      {(c.childCount > 0 || c.groupMembers.length > 0 || c.memberOf.length > 0) && (
        <>
          <SectionTitle>Hierarchy and group</SectionTitle>
          <div className="grid gap-4 md:grid-cols-2">
            {c.childCount > 0 && <Card><h3 className="mb-2 font-semibold">Departments / sub-accounts ({c.childCount})</h3><ul className="space-y-1">{c.children.map((k: any) => <li key={k.id}><Link className="text-accent" href={`/customers/${k.id}`}>{k.displayName}</Link></li>)}</ul></Card>}
            {c.groupMembers.length > 0 && <Card><h3 className="mb-2 font-semibold">Group members</h3><ul className="space-y-1">{c.groupMembers.map((k: any) => <li key={k.id}><Link className="text-accent" href={`/customers/${k.id}`}>{k.displayName}</Link> <span className="text-footnote text-label2">{label(k.role)}</span></li>)}</ul></Card>}
            {c.memberOf.length > 0 && <Card><h3 className="mb-2 font-semibold">Member of</h3><ul className="space-y-1">{c.memberOf.map((k: any) => <li key={k.id}><Link className="text-accent" href={`/customers/${k.id}`}>{k.displayName}</Link></li>)}</ul></Card>}
          </div>
        </>
      )}

      {can('order:read') && <><SectionTitle>Recent orders</SectionTitle>
      {c.recentOrders.length === 0 ? <Empty>No orders yet.</Empty> : (
        <TableWrap><thead><tr><Th>Order</Th><Th>Items</Th><Th>State</Th><Th right>Total</Th><Th>Placed</Th></tr></thead><tbody>
          {c.recentOrders.map((o: any) => <tr key={o.id}><Td><Link className="font-mono text-accent" href={`/orders/${o.id}`}>{o.id.slice(0, 8)}</Link></Td><Td>{o.summary}</Td><Td><Badge tone={tone(o.state)}>{label(o.state)}</Badge></Td><Td right>{money(o.totalMinor, o.currency)}</Td><Td>{dt(o.createdAt)}</Td></tr>)}
        </tbody></TableWrap>
      )}

      </>}

      {can('billing:read') && <><SectionTitle>Recent invoices</SectionTitle>
      {c.recentInvoices.length === 0 ? <Empty>No invoices yet. They appear after the first bill run.</Empty> : (
        <TableWrap><thead><tr><Th>Invoice</Th><Th>Issued</Th><Th>Due</Th><Th>Status</Th><Th right>Total</Th><Th right>Balance</Th></tr></thead><tbody>
          {c.recentInvoices.map((i: any) => <tr key={i.id}><Td><Link className="font-medium text-accent" href={`/billing/${i.id}`}>{i.number}</Link></Td><Td>{d(i.issueDate)}</Td><Td>{d(i.dueDate)}</Td><Td><Badge tone={tone(i.status)}>{label(i.status)}</Badge></Td><Td right>{money(i.totalMinor, i.currency)}</Td><Td right>{money(i.balanceMinor, i.currency)}</Td></tr>)}
        </tbody></TableWrap>
      )}

      </>}

      {can('case:read') && <CasesPanel customerId={id} cases={c.cases} onChange={reload} />}
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

const ACTIONS = [
  { value: 'suspend', label: 'Suspend' }, { value: 'resume', label: 'Resume' }, { value: 'change-sim', label: 'Change SIM' }, { value: 'change-msisdn', label: 'Change number' },
  { value: 'transfer', label: 'Transfer ownership' }, { value: 'terminate', label: 'Terminate' }, { value: 'port-out', label: 'Port out (MNP)' },
];

function Services({ customerId, accounts, onChange }: { customerId: string; accounts: any[]; onChange: () => void }) {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [sel, setSel] = useState<any>(null);
  const { data, loading, reload } = useApi(`/services?customerId=${customerId}&limit=20&offset=${offset}&q=${encodeURIComponent(q)}`);
  const done = () => { setSel(null); void reload(); onChange(); };
  return (
    <>
      <SectionTitle action={<Input type="search" aria-label="Find service" placeholder="Find number…" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} className="!min-h-[36px] !w-44" />}>Services {data && <span className="text-subhead font-normal text-label2">({data.total.toLocaleString()})</span>}</SectionTitle>
      {loading && !data && <Spinner />}
      {data && (data.items.length === 0 ? <Empty>No services.</Empty> : (
        <>
          <TableWrap><thead><tr><Th>Number / ID</Th><Th>Offer</Th><Th>Status</Th><Th>Contract</Th><Th /></tr></thead><tbody>
            {data.items.map((s: any) => (
              <tr key={s.id}><Td className="font-mono">{s.identifier}</Td><Td>{s.offerName}</Td>
                <Td><Badge tone={tone(s.status)}>{label(s.status)}</Badge>{s.suspendedReason && <div className="text-caption text-label2">{label(s.suspendedReason)}</div>}</Td>
                <Td>{s.contractTermMonths ? `${s.contractTermMonths} mo from ${d(s.contractStart)}` : 'None'}</Td>
                <Td right>{s.status !== 'TERMINATED' && can(...SERVICE_PERMS) && <Button variant="plain" className="!min-h-[36px] !px-3" onClick={() => setSel(s)}>Manage</Button>}</Td></tr>
            ))}
          </tbody></TableWrap>
          {data.total > 20 && <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</Button><Button variant="secondary" disabled={offset + 20 >= data.total} onClick={() => setOffset(offset + 20)}>Next</Button></div>}
        </>
      ))}
      {sel && <ServicePanel service={sel} accounts={accounts} onClose={() => setSel(null)} onDone={done} />}
    </>
  );
}

const ACTION_PERM: Record<string, string> = { suspend: 'service:suspend', resume: 'service:manage', 'change-sim': 'service:manage', 'change-msisdn': 'service:manage', transfer: 'service:transfer', terminate: 'service:terminate', 'port-out': 'mnp:manage', 'complete-port-out': 'mnp:manage', 'cancel-port-out': 'mnp:manage' };

function ServicePanel({ service, onClose, onDone }: { service: any; accounts: any[]; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const avail = ACTIONS.filter((a) => can(ACTION_PERM[a.value]!)).filter((a) => (service.status === 'ACTIVE' ? a.value !== 'resume' : service.status === 'SUSPENDED' ? ['resume', 'terminate'].includes(a.value) : false)
    && (service.type === 'MOBILE' || !['change-sim', 'change-msisdn', 'port-out'].includes(a.value)));
  const [action, setAction] = useState<string>(service.status === 'PORTING_OUT' ? 'complete-port-out' : avail[0]?.value ?? '');
  const [v, setV] = useState({ iccid: '', msisdn: '', toCustomerId: '', operator: '', code: '', reason: '' });
  const etc = useApi(action === 'terminate' || action === 'complete-port-out' ? `/services/${service.id}/etc` : null);
  const { run, busy, error, ok } = useAction(onDone);
  const set = (k: string) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const body: Record<string, unknown> = { action };
  if (action === 'change-sim') body.iccid = v.iccid;
  if (action === 'change-msisdn' && v.msisdn) body.msisdn = v.msisdn;
  if (action === 'transfer') body.toCustomerId = v.toCustomerId;
  if (action === 'terminate') body.reason = v.reason || undefined;
  if (action === 'suspend') body.reason = v.reason || undefined;
  if (action === 'port-out') { body.recipientOperator = v.operator; body.portingCode = v.code || undefined; }
  const portingOut = service.status === 'PORTING_OUT';
  return (
    <Card className="mt-3 border border-accent/30">
      <div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">Manage <span className="font-mono">{service.identifier}</span></h3><Button variant="plain" className="!min-h-[36px]" onClick={onClose}>Close</Button></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Action"><Select value={action} onChange={(e) => setAction(e.target.value)}>
          {portingOut ? <><option value="complete-port-out">Complete port-out</option><option value="cancel-port-out">Cancel port-out</option></> : avail.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </Select></Field>
        {action === 'change-sim' && <Field label="New ICCID" hint="19-20 digits starting 89"><Input value={v.iccid} onChange={set('iccid')} inputMode="numeric" /></Field>}
        {action === 'change-msisdn' && <Field label="New number (optional)" hint="Leave blank to allocate the next free number"><Input value={v.msisdn} onChange={set('msisdn')} placeholder="+65…" /></Field>}
        {action === 'transfer' && <Field label="Receiving customer ID" hint="Paste the customer id from their 360 page"><Input value={v.toCustomerId} onChange={set('toCustomerId')} /></Field>}
        {action === 'port-out' && <><Field label="Recipient operator"><Input value={v.operator} onChange={set('operator')} /></Field><Field label="Porting code"><Input value={v.code} onChange={set('code')} /></Field></>}
        {(action === 'terminate' || action === 'suspend') && <Field label="Reason"><Input value={v.reason} onChange={set('reason')} /></Field>}
      </div>
      {(action === 'terminate' || action === 'complete-port-out') && etc.data && (
        <p className="mt-3 rounded-control bg-surface2 p-3 text-subhead">
          {etc.data.chargeMinor > 0 ? <>Early termination charge: <strong>{money(etc.data.chargeMinor)}</strong> ({etc.data.monthsRemaining} months remaining). It will be invoiced now.</> : etc.data.waived ? 'ETC waived (final month of contract).' : 'No early termination charge.'}
        </p>
      )}
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      {ok && <div className="mt-3"><Alert tone="success">{ok}</Alert></div>}
      <Button className="mt-4" variant={action === 'terminate' ? 'destructive' : 'primary'} disabled={busy || !action} onClick={() => run(() => post(`/services/${service.id}/actions`, body), 'Done')}>{busy ? 'Working…' : 'Confirm'}</Button>
    </Card>
  );
}

function CasesPanel({ customerId, cases, onChange }: { customerId: string; cases: any[]; onChange: () => void }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ type: 'GENERAL', subject: '', note: '', priority: 'NORMAL' });
  const { run, busy, error } = useAction(onChange);
  return (
    <>
      <SectionTitle action={can('case:create') ? <Button variant="plain" className="!min-h-[36px]" onClick={() => setOpen(!open)}>{open ? 'Close' : 'New case'}</Button> : undefined}>Cases</SectionTitle>
      {open && (
        <Card className="mb-4"><form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await run(() => post('/cases', { customerId, ...f }))) { setOpen(false); setF({ ...f, subject: '', note: '' }); } }}>
          <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['GENERAL', 'FIBER_ASSURANCE', 'BILLING_REFUND'].map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
          <Field label="Priority"><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
          <div className="sm:col-span-2"><Field label="Subject"><Input required value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field></div>
          <div className="sm:col-span-2"><Field label="Notes"><Textarea rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field></div>
          {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
          <div className="sm:col-span-2"><Button type="submit" disabled={busy}>Create case</Button></div>
        </form></Card>
      )}
      {cases.length === 0 ? <Empty>No cases.</Empty> : (
        <TableWrap><thead><tr><Th>Case</Th><Th>Type</Th><Th>Subject</Th><Th>Status</Th><Th>Opened</Th></tr></thead><tbody>
          {cases.map((k: any) => <tr key={k.id}><Td><Link className="font-mono text-accent" href={`/cases/${k.id}`}>{k.number}</Link></Td><Td>{label(k.type)}</Td><Td>{k.subject}</Td><Td><Badge tone={tone(k.status)}>{label(k.status)}</Badge></Td><Td>{dt(k.createdAt)}</Td></tr>)}
        </tbody></TableWrap>
      )}
    </>
  );
}
