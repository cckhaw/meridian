'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LoadMore, SearchField, Select, Spinner, DataList } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi, useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { d, label, money, tone } from '@/lib/format';

const SERVICE_PERMS = ['service:manage', 'service:suspend', 'service:terminate', 'service:transfer', 'mnp:manage'];

const ACTIONS = [
  { value: 'suspend', label: 'Suspend' }, { value: 'resume', label: 'Resume' }, { value: 'change-sim', label: 'Change SIM' }, { value: 'change-msisdn', label: 'Change number' },
  { value: 'move-to-group', label: 'Move to a group plan' }, { value: 'transfer', label: 'Transfer ownership' }, { value: 'terminate', label: 'Terminate' }, { value: 'port-out', label: 'Port out (MNP)' },
];

/** Services of one customer or one account: searchable by number, a page at a time. */
export function ServicesTable({ customerId, accountId, onChange, title = true }: { customerId?: string; accountId?: string; onChange: () => void; title?: boolean }) {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const [sel, setSel] = useState<any>(null);
  const scope = accountId ? `accountId=${accountId}` : `customerId=${customerId}`;
  const list = usePaged(`/services?${scope}&limit=20&q=${encodeURIComponent(term)}`);
  const done = () => { setSel(null); void list.reload(); onChange(); };
  return (
    <section aria-label="Services">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        {title ? <h3 className="px-1 text-footnote font-semibold uppercase tracking-wide text-label2">Services</h3> : <span />}
        <SearchField label="Find service" placeholder="Number starts with…" value={q} onChange={setQ} className="w-full max-w-56" />
      </div>
      {list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && <Empty>{term ? 'No services match.' : 'No services.'}</Empty>}
      {list.items.length > 0 && (
        <>
          <DataList label="Services" rows={list.items} rowKey={(s: any) => s.id}
            columns={[
              { key: 'id', label: 'Number / ID', primary: true, render: (s: any) => <span className="font-mono">{s.identifier}</span> },
              { key: 'offer', label: 'Offer', render: (s: any) => s.offerName },
              { key: 'st', label: 'Status', render: (s: any) => <><Badge tone={tone(s.status)}>{label(s.status)}</Badge>{s.suspendedReason && <div className="text-caption text-label2">{label(s.suspendedReason)}</div>}</> },
              { key: 'contract', label: 'Contract', render: (s: any) => (s.contractTermMonths ? `${s.contractTermMonths} mo from ${d(s.contractStart)}` : 'None') },
            ]}
            actions={(s: any) => (s.status !== 'TERMINATED' && can(...SERVICE_PERMS) ? <Button variant="secondary" onClick={() => setSel(s)}>Manage</Button> : null)} />
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="services" />
        </>
      )}
      {sel && <ServicePanel service={sel} accounts={[]} onClose={() => setSel(null)} onDone={done} />}
    </section>
  );
}

const ACTION_PERM: Record<string, string> = { suspend: 'service:suspend', resume: 'service:manage', 'change-sim': 'service:manage', 'change-msisdn': 'service:manage', 'move-to-group': 'service:manage', transfer: 'service:transfer', terminate: 'service:terminate', 'port-out': 'mnp:manage', 'complete-port-out': 'mnp:manage', 'cancel-port-out': 'mnp:manage' };

export function ServicePanel({ service, onClose, onDone }: { service: any; accounts: any[]; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const avail = ACTIONS.filter((a) => can(ACTION_PERM[a.value]!)).filter((a) => (service.status === 'ACTIVE' ? a.value !== 'resume' : service.status === 'SUSPENDED' ? ['resume', 'terminate'].includes(a.value) : false)
    && (service.type === 'MOBILE' || !['change-sim', 'change-msisdn', 'port-out', 'move-to-group'].includes(a.value)) && (a.value !== 'move-to-group' || service.status === 'ACTIVE'));
  const [action, setAction] = useState<string>(service.status === 'PORTING_OUT' ? 'complete-port-out' : avail[0]?.value ?? '');
  const [v, setV] = useState({ iccid: '', msisdn: '', toCustomerId: '', operator: '', code: '', reason: '', groupOffer: '' });
  const plans = useApi<{ items: any[] }>(action === 'move-to-group' ? '/catalog?limit=50&status=ACTIVE&kind=SIM_ONLY' : null);
  const groupPlans = (plans.data?.items ?? []).filter((o) => o.group?.isGroupOffer && o.id !== service.offerId);
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
        {action === 'move-to-group' && <Field label="Group plan" hint="The line keeps its number and SIM and becomes the family head; the plan’s other places stay open for members."><Select value={v.groupOffer} onChange={set('groupOffer')}><option value="">Choose a plan…</option>{groupPlans.map((o) => <option key={o.id} value={o.id}>{o.name} · up to {o.group.maxGroupMembers} members</option>)}</Select></Field>}
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
      <Button className="mt-4" variant={action === 'terminate' ? 'destructive' : 'primary'} disabled={busy || !action || (action === 'move-to-group' && !v.groupOffer)} onClick={() => run(() => (action === 'move-to-group' ? post(`/services/${service.id}/upgrade-to-group`, { offerId: v.groupOffer }) : post(`/services/${service.id}/actions`, body)), 'Done')}>{busy ? 'Working…' : 'Confirm'}</Button>
    </Card>
  );
}

