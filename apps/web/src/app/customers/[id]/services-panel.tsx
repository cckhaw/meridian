'use client';
import { AgreementSigner, Alert, Badge, Button, Empty, Field, Input, LoadMore, Modal, SearchField, Select, Spinner, DataList, type AgreementView, type SignedPayload } from '@meridian/ui';
import { useEffect, useState } from 'react';
import { post, useAction, useApi, useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { d, label, money, tone } from '@/lib/format';

const SERVICE_PERMS = ['service:manage', 'service:suspend', 'service:terminate', 'service:transfer', 'mnp:manage'];

const ACTIONS = [
  { value: 'suspend', label: 'Suspend' }, { value: 'resume', label: 'Resume' }, { value: 'change-sim', label: 'Change SIM' }, { value: 'change-msisdn', label: 'Change number' },
  { value: 'change-plan', label: 'Change plan' }, { value: 'move-to-group', label: 'Move to a group plan' }, { value: 'transfer', label: 'Transfer ownership' }, { value: 'terminate', label: 'Terminate' }, { value: 'port-out', label: 'Port out (MNP)' },
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

const ACTION_PERM: Record<string, string> = { suspend: 'service:suspend', resume: 'service:manage', 'change-sim': 'service:manage', 'change-msisdn': 'service:manage', 'change-plan': 'service:manage', 'move-to-group': 'service:manage', transfer: 'service:transfer', terminate: 'service:terminate', 'port-out': 'mnp:manage', 'complete-port-out': 'mnp:manage', 'cancel-port-out': 'mnp:manage' };

export function ServicePanel({ service, onClose, onDone }: { service: any; accounts: any[]; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const avail = ACTIONS.filter((a) => can(ACTION_PERM[a.value]!)).filter((a) => (service.status === 'ACTIVE' ? a.value !== 'resume' : service.status === 'SUSPENDED' ? ['resume', 'terminate'].includes(a.value) : false)
    && (service.type === 'MOBILE' || !['change-sim', 'change-msisdn', 'port-out', 'move-to-group'].includes(a.value)) && (a.value !== 'move-to-group' || service.status === 'ACTIVE') && (a.value !== 'change-plan' || (service.status === 'ACTIVE' && service.type !== 'SUBSCRIPTION')));
  const [action, setAction] = useState<string>(service.status === 'PORTING_OUT' ? 'complete-port-out' : avail[0]?.value ?? '');
  const [v, setV] = useState({ iccid: '', msisdn: '', toCustomerId: '', operator: '', code: '', reason: '', groupOffer: '' });
  const plans = useApi<{ items: any[] }>(action === 'move-to-group' ? '/catalog?limit=50&status=ACTIVE&forSale=1&kind=SIM_ONLY' : null);
  const groupPlans = (plans.data?.items ?? []).filter((o) => o.group?.isGroupOffer && o.id !== service.offerId);
  // Changing plan: pick the new plan and when, read and sign the plan change agreement, then it is made.
  const [cp, setCp] = useState({ offer: '', effective: 'NEXT_BILL_CYCLE', acceptContract: false });
  const [agr, setAgr] = useState<{ required: boolean; agreements: AgreementView[] } | null>(null);
  const [signed, setSigned] = useState<SignedPayload | null>(null);
  const KIND_OF: Record<string, string> = { MOBILE: 'SIM_ONLY', FIBER: 'FIBER', IOT: 'IOT_CONNECTIVITY' };
  const planList = useApi<{ items: any[] }>(action === 'change-plan' ? `/catalog?limit=50&status=ACTIVE&forSale=1${KIND_OF[service.type] ? `&kind=${KIND_OF[service.type]}` : '&step=PLAN'}` : null);
  const newPlans = (planList.data?.items ?? []).filter((o) => o.id !== service.offerId);
  useEffect(() => {
    setAgr(null); setSigned(null);
    if (action !== 'change-plan' || !cp.offer) return;
    let live = true;
    post(`/services/${service.id}/change-plan/agreements`, { targetOfferId: cp.offer, effective: cp.effective }).then((r) => { if (live) setAgr(r); }).catch(() => { if (live) setAgr(null); });
    return () => { live = false; };
  }, [action, cp.offer, cp.effective, service.id]);
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
    // A dialog drawn on the page: opening it from a row, it is always in view (it used to open below a long list, out of sight).
    <Modal title={`Manage ${service.identifier}`} onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Action"><Select value={action} onChange={(e) => setAction(e.target.value)}>
          {portingOut ? <><option value="complete-port-out">Complete port-out</option><option value="cancel-port-out">Cancel port-out</option></> : avail.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </Select></Field>
        {action === 'change-sim' && <Field label="New ICCID" hint="19-20 digits starting 89"><Input value={v.iccid} onChange={set('iccid')} inputMode="numeric" /></Field>}
        {action === 'change-msisdn' && <Field label="New number (optional)" hint="Leave blank to allocate the next free number"><Input value={v.msisdn} onChange={set('msisdn')} placeholder="+65…" /></Field>}
        {action === 'move-to-group' && <Field label="Group plan" hint="The line keeps its number and SIM and becomes the family head; the plan’s other places stay open for members."><Select value={v.groupOffer} onChange={set('groupOffer')}><option value="">Choose a plan…</option>{groupPlans.map((o) => <option key={o.id} value={o.id}>{o.name} · up to {o.group.maxGroupMembers} members</option>)}</Select></Field>}
        {action === 'change-plan' && (
          <>
            <Field label="New plan"><Select value={cp.offer} onChange={(e) => setCp({ ...cp, offer: e.target.value })}><option value="">Choose a plan…</option>{newPlans.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
            <Field label="Takes effect"><Select value={cp.effective} onChange={(e) => setCp({ ...cp, effective: e.target.value })}><option value="NEXT_BILL_CYCLE">From the next bill</option><option value="IMMEDIATE">Now, pro-rated</option></Select></Field>
            {service.contractTermMonths > 0 && <label className="flex min-h-tap items-center gap-3 sm:col-span-2"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={cp.acceptContract} onChange={(e) => setCp({ ...cp, acceptContract: e.target.checked })} /><span className="text-subhead">The customer knows the contract terms still apply if the new plan is cheaper.</span></label>}
            {agr && agr.agreements.length > 0 && <div className="sm:col-span-2"><AgreementSigner agreements={agr.agreements} required={agr.required} onChange={setSigned} /></div>}
          </>
        )}
        {action === 'transfer' && <Field label="Receiving customer ID" hint="Paste the customer id from their 360 page"><Input value={v.toCustomerId} onChange={set('toCustomerId')} /></Field>}
        {action === 'port-out' && <><Field label="Recipient operator"><Input value={v.operator} onChange={set('operator')} /></Field><Field label="Porting code"><Input value={v.code} onChange={set('code')} /></Field></>}
        {(action === 'terminate' || action === 'suspend') && <Field label="Reason"><Input value={v.reason} onChange={set('reason')} /></Field>}
      </div>
      {(action === 'terminate' || action === 'complete-port-out') && etc.data && (
        <p className="mt-3 rounded-control bg-surface2 p-3 text-subhead">
          {etc.data.chargeMinor > 0 ? <>Early termination charge: <strong>{money(etc.data.chargeMinor)}</strong> ({etc.data.monthsRemaining} months remaining). It will be invoiced now.</> : etc.data.waived ? 'ETC waived (close to the end of the contract).' : 'No early termination charge.'}
        </p>
      )}
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      {ok && <div className="mt-3"><Alert tone="success">{ok}</Alert></div>}
      <Button className="mt-4" variant={action === 'terminate' ? 'destructive' : 'primary'} disabled={busy || !action || (action === 'move-to-group' && !v.groupOffer) || (action === 'change-plan' && (!cp.offer || (!!agr?.required && !signed)))} onClick={() => run(() => (action === 'change-plan' ? post(`/services/${service.id}/change-plan`, { targetOfferId: cp.offer, effective: cp.effective, acceptContractTerms: cp.acceptContract || undefined, agreement: signed ? { image: signed.image, versionIds: signed.versionIds, geo: signed.geo ?? undefined } : undefined }) : action === 'move-to-group' ? post(`/services/${service.id}/upgrade-to-group`, { offerId: v.groupOffer }) : post(`/services/${service.id}/actions`, body)), 'Done')}>{busy ? 'Working…' : 'Confirm'}</Button>
    </Modal>
  );
}

