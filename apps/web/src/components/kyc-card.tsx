'use client';
import { Alert, Badge, Card, SectionTitle, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useEffect } from 'react';
import { useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label, money } from '@/lib/format';
import { VerifyIdentity, type ShotKind } from './identity-capture';

const TONE = { VERIFIED: 'success', PENDING_REVIEW: 'warning', REJECTED: 'danger', NOT_VERIFIED: 'neutral' } as const;
const TEXT: Record<string, string> = { VERIFIED: 'Identity verified', PENDING_REVIEW: 'Identity check in review', REJECTED: 'Identity not approved', NOT_VERIFIED: 'Identity not verified' };
const SOURCE: Record<string, string> = { CRM_ORDER: 'taken with an order', CRM_CUSTOMER: 'taken from the customer record', STOREFRONT: 'sent from the online shop', ASSISTED: 'taken at a store counter' };
const SHOT: Record<string, string> = { ID_FRONT: 'ID front', ID_BACK: 'ID back', SELFIE: 'Selfie', COMPANY_REGISTRATION: 'Registration certificate', PROOF_OF_ADDRESS: 'Proof of address' };

/**
 * A customer's identity check at a glance, and the way to start (or redo) it. Shown on the customer record and inside the order wizard, so the answer to "why is this
 * customer unverified?" is always on the screen, with the action that fixes it next to it.
 */
export function KycCard({ customerId, context, onStatus, embedded }: { customerId: string; context: 'order' | 'customer'; onStatus?: (status: string) => void; embedded?: boolean }) {
  const { can } = useAuth();
  const k = useApi<any>(`/customers/${customerId}/kyc`);
  const status: string | undefined = k.data?.status;
  useEffect(() => { if (status) onStatus?.(status); }, [status]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (k.loading && !k.data) return <Spinner />;
  if (k.error || !k.data) return <Alert>{k.error ?? 'Could not load the identity check.'}</Alert>;
  const v = k.data, c = v.case;
  const canAct = can('customer:write');
  const startable = canAct && (v.status === 'NOT_VERIFIED' || (v.status === 'REJECTED' && c?.canResubmit)) && (!c || c.canResubmit || c.status === 'APPROVED' || c.status === 'RETURNED');
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={TONE[v.status as keyof typeof TONE] ?? 'neutral'}>{TEXT[v.status] ?? label(v.status)}</Badge>
        {c && v.status !== 'VERIFIED' && <span className="text-footnote text-label2">{label(c.status)} · {SOURCE[c.source] ?? c.source}{c.method === 'MYDIGITAL_ID' ? ' · MyDigital ID' : ''}{c.submittedAt ? ` · ${dt(c.submittedAt)}` : ''}</span>}
        {v.status === 'VERIFIED' && v.verifiedAt && <span className="text-footnote text-label2">on {dt(v.verifiedAt)}</span>}
        {can('kyc:review') && c && <Link className="text-footnote text-accent" href={`/kyc/${c.id}`}>Open the review</Link>}
      </div>
      {v.status === 'NOT_VERIFIED' && !c && <p className="mt-2 text-subhead text-label2">No identity check has been started for this customer. Take the ID photographs below to start one{v.gate === 'BEFORE_ORDER' ? '; nothing can be sold until it is approved' : '; the service is switched on once it is approved'}.</p>}
      {v.status === 'PENDING_REVIEW' && <p className="mt-2 text-subhead text-label2">{v.gate === 'BEFORE_ORDER' ? 'Services can be sold once a compliance officer approves it.' : 'An order can be taken now. The service is switched on when a compliance officer approves the check; if it is not approved the order is cancelled and refunded.'}</p>}
      {c?.status === 'RETURNED' && <div className="mt-3"><Alert tone="info">Sent back by the reviewer{c.reason ? `: ${c.reason}` : ''}. Take the photographs again below.</Alert></div>}
      {v.status === 'REJECTED' && <div className="mt-3"><Alert>{c?.reason ? `Not approved: ${c.reason}.` : 'Not approved.'} {c?.canResubmit ? 'Fresh photographs can be sent for another review.' : 'Services cannot be sold to this customer. Speak to compliance.'}</Alert></div>}
      {c && c.documents.length > 0 && <ul className="mt-3 flex flex-wrap gap-2">{c.documents.map((d: any) => <li key={d.id}><Badge tone={d.status === 'REJECTED' ? 'danger' : d.status.startsWith('VERIFIED') ? 'success' : 'neutral'}>{SHOT[d.kind] ?? label(d.kind)}{d.live ? ' · camera' : ''}</Badge></li>)}</ul>}
      {v.waitingOrders.length > 0 && (
        <div className="mt-3 rounded-control bg-surface2 p-3 text-subhead">
          <p className="font-medium">Waiting for this check</p>
          <ul className="mt-1 space-y-1">{v.waitingOrders.map((o: any) => <li key={o.id}><Link className="text-accent" href={`/orders/${o.id}`}>{o.number ?? o.id.slice(0, 8)}</Link> <span className="text-label2">· {money(o.totalMinor)} · service activation on hold</span></li>)}</ul>
        </div>
      )}
      {startable && (
        <div className="mt-4 border-t border-separator pt-4">
          <VerifyIdentity customerId={customerId} individual={v.individual} dobKnown={v.dateOfBirthKnown} context={context} previous={c?.status === 'RETURNED' ? c.reason : null}
            onFile={Object.fromEntries((c?.documents ?? []).map((d: any) => [d.kind, false])) as Partial<Record<ShotKind, boolean>>}
            onSubmitted={() => { void k.reload(); onStatus?.('PENDING_REVIEW'); }} />
        </div>
      )}
    </>
  );
  return embedded ? <div className="rounded-card bg-surface p-4 shadow-card">{body}</div> : <><SectionTitle>Identity check</SectionTitle><Card>{body}</Card></>;
}
