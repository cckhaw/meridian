'use client';
import { Alert, Badge, Button, Card, Field, LargeTitle, SectionTitle, Select, Spinner, Textarea } from '@meridian/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { d, dt, label, money } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { DOC_LABEL, FLAG_TEXT, ID_TYPE_LABEL, REASONS, SOURCE_LABEL } from '../flags';

export default function KycCase() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: c, error, loading, reload } = useApi(`/kyc/cases/${id}`);
  const { can, me } = useAuth();
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [fraud, setFraud] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const act = useAction(reload);
  if (loading && !c) return <Spinner />;
  if (error || !c) return <Alert>{error ?? 'Not found'}</Alert>;
  const decide = async (decision: 'APPROVE' | 'REJECT' | 'RETURN') => {
    const r = await act.run(() => post(`/kyc/cases/${id}/decision`, { decision, reason, reasonCode: code || undefined, reportFraud: decision === 'REJECT' && fraud ? true : undefined }), 'Decision recorded.');
    if (r) router.push('/kyc');
  };
  const app = c.application;
  const dup = c.flags.includes('DUPLICATE_IDENTITY') && app?.channel === 'SELF_SERVE';
  const p = app?.personal ?? { email: c.customer?.email, phone: c.customer?.phone };
  const open = c.status === 'PENDING' && (!app || ['KYC_REVIEW', 'ORDERED'].includes(app.status));
  const mine = !!me && (c.submittedBy === me.username || c.attestation?.by === me.username);
  return (
    <>
      <LargeTitle subtitle={<span className="flex flex-wrap items-center gap-2"><span>{SOURCE_LABEL[c.source] ?? (c.method === 'IN_PERSON' ? 'In store' : 'Online')}</span>{c.status === 'PENDING' && <Badge tone={c.overdue ? 'danger' : 'warning'}>{c.overdue ? 'Overdue' : 'Due'} {dt(c.dueAt)}</Badge>}{c.customer && <Link className="text-accent" href={`/customers/${c.customer.id}`}>Open the customer</Link>}</span>}>{c.fullName}</LargeTitle>
      <p className="mb-4"><Link href="/kyc" className="text-subhead text-accent">← Back to the queue</Link></p>
      {c.flags.length > 0 && <div className="mb-4"><Alert tone="info">{c.flags.map((f: string) => FLAG_TEXT[f] ?? label(f)).join(' · ')}</Alert></div>}
      {c.status !== 'PENDING' && <div className="mb-4"><Alert tone={c.status === 'APPROVED' ? 'success' : 'danger'}>{label(c.status)} by {c.decidedBy} on {dt(c.decidedAt)}{c.decisionReason ? `: ${c.decisionReason}` : ''}</Alert></div>}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <SectionTitle>What the applicant entered</SectionTitle>
          <dl className="grid gap-x-4 gap-y-2 text-subhead sm:grid-cols-[auto_1fr]">
            <dt className="text-label2">Full name</dt><dd>{c.fullName}</dd>
            <dt className="text-label2">Date of birth</dt><dd>{d(c.dateOfBirth)}</dd>
            <dt className="text-label2">ID type</dt><dd>{ID_TYPE_LABEL[c.idType] ?? c.idType}</dd>
            <dt className="text-label2">ID number</dt><dd className="font-mono tracking-wide">{c.idNumber}</dd>
            <dt className="text-label2">ID expiry</dt><dd>{c.idExpiry ? d(c.idExpiry) : '–'}</dd>
            <dt className="text-label2">Nationality</dt><dd>{c.nationality ?? '–'}</dd>
            <dt className="text-label2">Email</dt><dd>{p.email}</dd>
            <dt className="text-label2">Mobile</dt><dd>{p.phone}</dd>
            {(app?.address ?? c.customer?.address) && <><dt className="text-label2">Address</dt><dd>{[(app?.address ?? c.customer.address).line1, (app?.address ?? c.customer.address).city, (app?.address ?? c.customer.address).postcode].filter(Boolean).join(', ')}</dd></>}
          </dl>
          <p className="mt-3 text-footnote text-label2">Compare these with the photos. Viewing this case is recorded in the audit log.</p>
          {c.attestation && <p className="mt-3 rounded-control bg-surface2 p-3 text-subhead">Sighted in person by <strong>{c.attestation.by}</strong> ({c.attestation.storeId ?? 'store'}) on {dt(c.attestation.at)}{c.attestation.notes ? ` — ${c.attestation.notes}` : ''}</p>}
          {app && <p className="mt-3 text-footnote text-label2">Basket: {(app.lines ?? []).map((l: any) => `${l.offerId} × ${l.quantity}`).join(', ')}</p>}
          {c.submittedBy && <p className="mt-1 text-footnote text-label2">Submitted by {c.submittedBy}{c.submittedAt ? ` on ${dt(c.submittedAt)}` : ''}.</p>}
        </Card>

        <Card>
          <SectionTitle>Documents</SectionTitle>
          {c.documents.length === 0 ? <p className="text-subhead text-label2">No documents were uploaded{c.method === 'IN_PERSON' ? ' (original ID sighted in store)' : ''}.</p> : (
            <ul className="grid grid-cols-2 gap-3">
              {c.documents.map((doc: any) => (
                <li key={doc.id}>
                  <p className="mb-1 flex flex-wrap items-center gap-1 text-footnote font-medium">{(DOC_LABEL[doc.kind] ?? doc.kind)} <Badge tone={doc.live ? 'success' : 'warning'}>{doc.live ? 'Camera' : 'Not live'}</Badge></p>
                  {doc.contentType === 'application/pdf'
                    ? <a className="text-accent underline" href={`/api/kyc/documents/${doc.id}`} target="_blank" rel="noreferrer">Open PDF</a>
                    // eslint-disable-next-line @next/next/no-img-element
                    : <button onClick={() => setZoom(doc.id)} className="block w-full overflow-hidden rounded-control border border-separator focus-visible:ring-2 focus-visible:ring-accent"><img src={`/api/kyc/documents/${doc.id}`} alt={`${(DOC_LABEL[doc.kind] ?? doc.kind)} (click to enlarge)`} className="h-32 w-full object-cover" /></button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {c.waitingOrders.length > 0 && c.status === 'PENDING' && (
        <Card className="mt-5">
          <SectionTitle>Orders waiting for this decision</SectionTitle>
          <ul className="space-y-1 text-subhead">{c.waitingOrders.map((o: any) => <li key={o.id}><Link className="text-accent" href={`/orders/${o.id}`}>{o.number ?? o.id.slice(0, 8)}</Link> <span className="text-label2">· {money(o.totalMinor)} · {label(o.state)}</span></li>)}</ul>
          <p className="mt-2 text-footnote text-label2">Approving switches the service on. Rejecting cancels each order and refunds what was paid.</p>
        </Card>
      )}
      {open && (
        <Card className="mt-5">
          <SectionTitle>Decision</SectionTitle>
          {mine && <div className="mb-3"><Alert tone="info">You submitted this case, so someone else has to approve it. You can still reject it or send it back.</Alert></div>}
          {dup && <div className="mb-3"><Alert tone="info">This ID already belongs to a customer, so it cannot be approved online. Reject it (the customer can visit a store) or send it back.</Alert></div>}
          <Field label="Reason code" hint="Used in reports. Choose the closest."><Select value={code} onChange={(e) => setCode(e.target.value)}><option value="">Not stated</option>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <div className="mt-3" />
          <Field label="Reason" hint="Required to reject or send back. The applicant or store sees it."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
          {can('fraud:manage') && <label className="mt-3 flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={fraud} onChange={(e) => setFraud(e.target.checked)} /><span><span className="block">Report this ID to the fraud register</span><span className="text-footnote text-label2">Applies when you reject. The ID is then refused everywhere it is offered, and the customer cannot be submitted again.</span></span></label>}
          {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => decide('APPROVE')} disabled={act.busy || dup || mine}>Approve</Button>
            {c.canReturn && <Button variant="secondary" onClick={() => decide('RETURN')} disabled={act.busy || !reason.trim()}>Send back for corrections</Button>}
            <Button variant="destructive" onClick={() => decide('REJECT')} disabled={act.busy || !reason.trim()}>Reject</Button>
          </div>
        </Card>
      )}
      {zoom && (
        <div role="dialog" aria-modal="true" aria-label="Document" className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4" onClick={() => setZoom(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/kyc/documents/${zoom}`} alt="Document, enlarged" className="max-h-full max-w-full rounded-card" />
          <button className="absolute right-4 top-4 min-h-tap min-w-tap rounded-full bg-surface text-title3" aria-label="Close" onClick={() => setZoom(null)}>×</button>
        </div>
      )}
    </>
  );
}
