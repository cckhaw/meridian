'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LargeTitle, LoadMore, Modal, SearchField, Segmented, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { post, useAction, useApi, useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { d, dt, label } from '@/lib/format';
import { Viewer } from './viewer';

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = { PENDING_VERIFICATION: 'warning', VERIFIED_AUTO: 'success', VERIFIED_MANUAL: 'success', REJECTED: 'danger', EXPIRED: 'danger', PURGED_RETENTION: 'neutral', ACTIVE: 'success', SUPERSEDED: 'neutral' };
const STATUS_TEXT: Record<string, string> = { PENDING_VERIFICATION: 'Waiting for verification', VERIFIED_AUTO: 'Verified (automatic)', VERIFIED_MANUAL: 'Verified', REJECTED: 'Rejected', EXPIRED: 'Expired', PURGED_RETENTION: 'Removed (retention)', ACTIVE: 'Signed', SUPERSEDED: 'No longer in force' };
const CATEGORY_TEXT: Record<string, string> = { NATIONAL_ID_FRONT: 'ID card, front', NATIONAL_ID_BACK: 'ID card, back', PASSPORT: 'Passport', UTILITY_BILL: 'Utility bill', CORPORATE_REGISTRATION_SSM: 'Company registration (SSM)', PROOF_OF_ADDRESS: 'Proof of address', SELFIE: 'Selfie', CUSTOMER_SIGNATURE: 'Signature picture', SUBSCRIBER_AGREEMENT: 'Subscriber agreement', FAIR_USAGE: 'Fair usage policy', DEVICE_INSTALMENT: 'Device instalment terms', PLAN_CHANGE: 'Plan change agreement', OTHER: 'Other' };
const categoryText = (c: string) => CATEGORY_TEXT[c] ?? label(c);
const KB = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

/** Documents: signed agreements and the identity vault, for back-office and compliance. Every view is written to the access log shown with the document. */
export default function Documents() {
  return <Suspense fallback={<Spinner />}><Explorer /></Suspense>;
}

function Explorer() {
  const { can } = useAuth();
  const params = useSearchParams();
  const [kind, setKind] = useState(params.get('kind') ?? '');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState(params.get('q') ?? '');
  const customerId = params.get('customerId') ?? '';
  const term = useDebounced(q.trim());
  const summary = useApi<any>('/documents/summary');
  const list = usePaged(`/documents?limit=25${kind ? `&kind=${kind}` : ''}${status ? `&status=${status}` : ''}${customerId ? `&customerId=${customerId}` : ''}&q=${encodeURIComponent(term)}`);
  const [open, setOpen] = useState<string | null>(null);
  const [upload, setUpload] = useState(false);
  const kinds = [...(can('document:read') ? [{ value: 'CONTRACT', label: 'Agreements' }] : []), ...(can('document:kyc') ? [{ value: 'KYC', label: 'Identity' }] : [])];
  const s = summary.data;
  return (
    <>
      <LargeTitle subtitle="Signed agreements and identity documents. Opening a document is recorded: who, when and from where.">Documents</LargeTitle>
      {s && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[['Waiting for verification', s.pending, s.pending > 0], ['Identity documents', s.kyc, false], ['Signed agreements', s.contracts, false], ['Expired', s.expired, s.expired > 0], ['Removed (retention)', s.purged, false]].map(([k, v, hot]) => (
            <Card key={k as string} className="!p-4"><p className="text-footnote text-label2">{k as string}</p><p className={`text-title2 font-bold tabular-nums ${hot ? 'text-warning' : ''}`}>{(v as number).toLocaleString()}</p></Card>
          ))}
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <SearchField label="Search" placeholder="Customer name, order or customer id" value={q} onChange={setQ} className="w-full max-w-sm" />
        {kinds.length > 1 && <Segmented label="Kind" value={kind} options={[{ value: '', label: 'All' }, ...kinds]} onChange={setKind} />}
        <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any</option>{Object.entries(STATUS_TEXT).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</Select></Field>
        {can('document:kyc') && <Button variant="secondary" onClick={() => setUpload(true)}>Add identity document</Button>}
      </div>
      {customerId && <p className="mb-3 text-subhead text-label2">Showing one customer's documents. <Link className="text-accent" href="/documents">Show all</Link></p>}
      {list.error && <Alert>{list.error}</Alert>}
      {list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>No documents match.</Empty>}
      {list.items.length > 0 && (
        <>
          <TableWrap>
            <thead><tr><Th>Document</Th><Th>Customer</Th><Th>Status</Th><Th>Added</Th><Th>Size</Th></tr></thead>
            <tbody>
              {list.items.map((x: any) => (
                <tr key={x.id} className="cursor-pointer hover:bg-surface2" onClick={() => setOpen(x.id)}>
                  <Td><button type="button" className="text-left font-medium text-accent" onClick={(e) => { e.stopPropagation(); setOpen(x.id); }}>{categoryText(x.category)}</button><div className="text-caption text-label2">{x.kind === 'CONTRACT' ? (x.meta?.version ? `${x.meta.version} · ${x.meta.reference ?? ''}` : x.name) : x.kind === 'SIGNATURE' ? 'Signature' : x.encrypted ? 'Encrypted' : ''}</div></Td>
                  <Td>{x.customerId ? <Link className="text-accent" href={`/customers/${x.customerId}`} onClick={(e) => e.stopPropagation()}>{x.customerName ?? 'Customer'}</Link> : <span className="text-label2">Not linked</span>}</Td>
                  <Td><Badge tone={STATUS_TONE[x.status] ?? 'neutral'}>{STATUS_TEXT[x.status] ?? label(x.status)}</Badge></Td>
                  <Td className="text-label2">{dt(x.createdAt)}</Td>
                  <Td className="text-label2">{x.purgedAt ? '—' : KB(x.sizeBytes)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="documents" />
        </>
      )}
      {can('document:manage') && <Retention onSwept={() => { void summary.reload(); void list.reload(); }} />}
      {open && <Detail id={open} onClose={() => setOpen(null)} onChanged={() => { void list.reload(); void summary.reload(); }} />}
      {upload && <Upload initialCustomer={customerId} onClose={() => setUpload(false)} onDone={() => { setUpload(false); void list.reload(); void summary.reload(); }} />}
    </>
  );
}

function Retention({ onSwept }: { onSwept: () => void }) {
  const settings = useApi<any>('/settings/documents');
  const { run, busy, error, ok } = useAction(onSwept);
  const s = settings.data;
  return (
    <Card className="mt-8">
      <h2 className="text-headline font-semibold">Retention</h2>
      {s && <p className="mt-1 text-subhead text-label2">Unclaimed uploads are removed after {s.tempUploadHours} hours. Identity documents are kept {s.kycRetentionYears} years and agreements {s.contractRetentionYears} years after a customer's last service ends. Change this in Settings → Documents. Files are kept {s.storage === 'S3' ? 'in the object storage bucket' : 'in the database'}.</p>}
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}{ok && <div className="mt-2"><Alert tone="success">{ok}</Alert></div>}
      <Button className="mt-3" variant="secondary" disabled={busy} onClick={() => void run(async () => { const r = await post('/documents/sweep'); return `${r.expired} expired, ${r.unclaimedPurged} unclaimed uploads removed, ${r.retentionPurged} removed by retention`; })}>{busy ? 'Running…' : 'Run the retention sweep now'}</Button>
    </Card>
  );
}

function Upload({ initialCustomer, onClose, onDone }: { initialCustomer: string; onClose: () => void; onDone: () => void }) {
  const [customerId, setCustomerId] = useState(initialCustomer);
  const [category, setCategory] = useState('PASSPORT');
  const [expiresAt, setExpires] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const { run, busy, error } = useAction(onDone);
  const submit = async () => {
    if (!file) return;
    const content = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => no(new Error('The file could not be read.')); r.readAsDataURL(file); });
    await run(() => post('/documents/kyc', { customerId: customerId.trim(), category, name: file.name.slice(0, 100), expiresAt: expiresAt || undefined, content }), 'Added');
  };
  return (
    <Modal title="Add an identity document" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Customer id" hint="Copy it from the customer's page"><Input value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="00000000-0000-…" /></Field>
        <Field label="Document"><Select value={category} onChange={(e) => setCategory(e.target.value)}>{['NATIONAL_ID_FRONT', 'NATIONAL_ID_BACK', 'PASSPORT', 'UTILITY_BILL', 'CORPORATE_REGISTRATION_SSM', 'PROOF_OF_ADDRESS'].map((c) => <option key={c} value={c}>{categoryText(c)}</option>)}</Select></Field>
        <Field label="Valid until (optional)"><Input type="date" value={expiresAt} onChange={(e) => setExpires(e.target.value)} /></Field>
        <Field label="File" hint="A JPEG, PNG, WebP or PDF, up to 3 MB. It is encrypted before it is stored."><Input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={busy || !file || !customerId.trim()} onClick={() => void submit()}>{busy ? 'Adding…' : 'Add'}</Button></div>
      </div>
    </Modal>
  );
}

function Detail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can, me } = useAuth();
  const doc = useApi<any>(`/documents/${id}`);
  const log = useApi<{ items: any[] }>(can('document:kyc') || can('audit:read') ? `/documents/log?documentId=${id}&limit=50` : null);
  const [viewing, setViewing] = useState(false);
  const [reason, setReason] = useState('');
  const [seal, setSeal] = useState<any>(null);
  const [purge, setPurge] = useState(false);
  const act = useAction(async () => { await doc.reload(); await log.reload(); onChanged(); });
  const x = doc.data;
  return (
    <Modal title={x ? categoryText(x.category) : 'Document'} wide onClose={onClose}>
      {doc.error && <Alert>{doc.error}</Alert>}
      {!x && !doc.error && <Spinner />}
      {x && (
        <div className="space-y-4">
          <dl className="grid gap-x-6 gap-y-1 text-subhead sm:grid-cols-[auto_1fr]">
            <dt className="text-label2">Customer</dt><dd>{x.customerId ? <Link className="text-accent" href={`/customers/${x.customerId}`}>{x.customerName ?? x.customerId}</Link> : 'Not linked yet'}</dd>
            <dt className="text-label2">Status</dt><dd><Badge tone={STATUS_TONE[x.status] ?? 'neutral'}>{STATUS_TEXT[x.status] ?? label(x.status)}</Badge>{x.statusReason ? ` · ${x.statusReason}` : ''}{x.verifiedBy ? ` · by ${x.verifiedBy}, ${dt(x.verifiedAt)}` : ''}</dd>
            <dt className="text-label2">Added</dt><dd>{dt(x.createdAt)} by {x.createdBy}</dd>
            {x.expiresAt && <><dt className="text-label2">Valid until</dt><dd>{d(x.expiresAt)}</dd></>}
            <dt className="text-label2">Kept until</dt><dd>{x.retentionUntil ? d(x.retentionUntil) : 'While the customer has a live service, then per the retention policy'}</dd>
            <dt className="text-label2">File</dt><dd>{x.purgedAt ? 'Removed' : `${x.contentType} · ${KB(x.sizeBytes)} · ${x.encrypted ? 'encrypted at rest' : 'stored as is'} · ${x.storage === 'S3' ? 'object storage' : 'database'}`}</dd>
            {x.orderId && <><dt className="text-label2">Order</dt><dd><Link className="text-accent" href={`/orders/${x.orderId}`}>Open the order</Link></dd></>}
            {x.signature && <>
              <dt className="text-label2">Signed by</dt><dd>{x.signature.signerName}, {dt(x.signature.signedAt)} · {x.signature.method === 'ASSISTED' ? 'at the counter' : x.signature.method === 'PLAN_CHANGE' ? 'plan change' : 'online'}{x.signature.agent ? ` · ${x.signature.agent}` : ''}</dd>
              <dt className="text-label2">From</dt><dd>{x.signature.ip ?? 'address not recorded'}{x.signature.geo ? ` · location ${x.signature.geo.lat.toFixed(4)}, ${x.signature.geo.lon.toFixed(4)}` : ''}</dd>
              <dt className="text-label2">Seal</dt><dd className="break-all font-mono text-caption">{x.signature.contentSeal}</dd>
            </>}
          </dl>
          {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
          {seal && <Alert tone={seal.intact ? 'success' : 'danger'}>{seal.intact ? 'The file is exactly as it was signed: its fingerprint and the seal inside it both match.' : `This file does NOT match what was signed (${!seal.fileIntact ? 'the stored file changed' : 'the seal inside it is different'}).`}</Alert>}
          {!x.purgedAt && (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => setViewing(true)}>View</Button>
              <DownloadLink id={id} />
              {x.kind === 'CONTRACT' && can('document:read') && <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(async () => setSeal(await post(`/documents/${id}/verify-seal`)))}>Check it is untouched</Button>}
              {can('document:manage') && <Button variant="plain" onClick={() => setPurge(true)}>Remove…</Button>}
            </div>
          )}
          {x.kind === 'KYC' && x.status === 'PENDING_VERIFICATION' && can('document:kyc') && (
            <div className="flex flex-wrap items-end gap-2 rounded-control border border-separator p-3">
              <Button disabled={act.busy} onClick={() => void act.run(() => post(`/documents/${id}/decision`, { decision: 'VERIFY' }), 'Verified')}>Verify</Button>
              <Field label="Reason, if rejecting"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
              <Button variant="destructive" disabled={act.busy || !reason.trim()} onClick={() => void act.run(() => post(`/documents/${id}/decision`, { decision: 'REJECT', reason }), 'Rejected')}>Reject</Button>
            </div>
          )}
          {log.data && (
            <section>
              <h3 className="mb-2 text-headline font-semibold">Who has been here</h3>
              <TableWrap>
                <thead><tr><Th>When</Th><Th>Who</Th><Th>What</Th><Th>From</Th></tr></thead>
                <tbody>{log.data.items.map((l) => <tr key={l.id}><Td className="text-label2">{dt(l.at)}</Td><Td>{l.actor}</Td><Td>{label(l.action)}{l.detail?.reason ? ` · ${l.detail.reason}` : ''}</Td><Td className="font-mono text-caption text-label2">{l.ip ?? ''}</Td></tr>)}</tbody>
              </TableWrap>
            </section>
          )}
        </div>
      )}
      {viewing && x && <Viewer id={id} contentType={x.contentType} watermark={`${me?.displayName ?? me?.username ?? 'staff'} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`} onClose={() => { setViewing(false); void log.reload(); }} />}
      {purge && <Purge id={id} onClose={() => setPurge(false)} onDone={() => { setPurge(false); void act.run(async () => undefined); }} />}
    </Modal>
  );
}

/** A 15-minute link, requested only when the button is pressed (so every link is in the log). */
function DownloadLink({ id }: { id: string }) {
  const { run, busy, error } = useAction();
  return (
    <>
      <Button variant="secondary" disabled={busy} onClick={() => void run(async () => { const l = await (await fetch(`/api/documents/${id}/link?mode=download`, { credentials: 'same-origin' })).json(); if (!l.url) throw new Error(l.error?.message ?? 'Could not make a link.'); window.open(l.url, '_blank', 'noopener'); })}>{busy ? 'Making a link…' : 'Download'}</Button>
      {error && <span className="text-footnote text-danger">{error}</span>}
    </>
  );
}

function Purge({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { run, busy, error } = useAction(onDone);
  return (
    <Modal title="Remove this document" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-subhead text-label2">The file is deleted for good. The record, who removed it and why stay in the log.</p>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="destructive" disabled={busy || reason.trim().length < 3} onClick={() => void run(() => post(`/documents/${id}/purge`, { reason }))}>Remove for good</Button></div>
      </div>
    </Modal>
  );
}
