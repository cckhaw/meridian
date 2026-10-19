'use client';
import { Alert, Button, Card, Field, Input, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';

/** Settings → Documents: when a signature is required, and how long documents are kept. The agreement texts themselves are written in Document templates. */
export function DocumentSettings() {
  const { data, error, reload } = useApi<any>('/settings/documents');
  const [v, setV] = useState<Record<string, any>>({});
  const { run, busy, error: saveError, ok } = useAction(async () => { setV({}); await reload(); });
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const cur = { ...data, ...v };
  const num = (k: string) => (e: { target: { value: string } }) => setV({ ...v, [k]: Number(e.target.value) });
  const sw = (k: string, text: string, hint: string) => (
    <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={!!cur[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} /><span>{text}<span className="block text-footnote text-label2">{hint}</span></span></label>
  );
  return (
    <Card>
      <p className="mb-4 text-subhead text-label2">The terms customers sign are written under <Link className="text-accent" href="/settings/document-templates">Document templates</Link>. Signed agreements and identity documents are kept in the vault, in {data.storage === 'S3' ? 'your object storage bucket' : 'the database'}.</p>
      <div className="grid max-w-xl gap-4">
        {sw('requireAtOrder', 'A new order must be signed', 'When an agreement applies to what is being ordered, the order cannot be placed until the customer has read and signed it (in the CRM, the shop and the partner API). Quick sales at a counter are not asked.')}
        {sw('requireAtPlanChange', 'A plan change must be signed', 'The same for moving a service to another plan.')}
        {sw('deliverContracts', 'Send the signed copy to the customer', 'When the order is paid (or at once for a plan change) the customer gets one message per signed copy with a secure link that works for 15 minutes: a text message through the SMS / WhatsApp gateway to their mobile number, an e-mail through the e-mail sender to their address, or both in turn (the order is set in Settings → Security policy → E-mail codes). Nothing is attached. With neither set up in the Integration hub the copies stay queued and nothing is sent; see the status below.')}
        <Field label="Remove unclaimed uploads after (hours)" hint="Identity uploads that never reached a customer."><Input type="number" min={1} value={cur.tempUploadHours} onChange={num('tempUploadHours')} /></Field>
        <Field label="Keep identity documents for (years after the last service ends)"><Input type="number" min={0} value={cur.kycRetentionYears} onChange={num('kycRetentionYears')} /></Field>
        <Field label="Keep signed agreements for (years after the last service ends)"><Input type="number" min={0} value={cur.contractRetentionYears} onChange={num('contractRetentionYears')} /></Field>
      </div>
      <DeliveryStatus />
      {saveError && <div className="mt-3"><Alert>{saveError}</Alert></div>}{ok && <div className="mt-3"><Alert tone="success">{ok}</Alert></div>}
      <div className="mt-4 flex flex-wrap gap-2"><Button disabled={busy || !Object.keys(v).length} onClick={() => void run(() => post('/settings/documents', v), 'Saved')}>Save</Button><Link href="/settings/document-templates" className="inline-flex min-h-tap items-center rounded-control border border-separator bg-surface2 px-5 font-medium">Open document templates</Link></div>
    </Card>
  );
}

/** Where signed copies stand: sent, waiting (and why) or failed (and why). */
function DeliveryStatus() {
  const { data, error, reload } = useApi<any>('/documents/delivery');
  const act = useAction(async () => { await reload(); });
  if (error) return <div className="mt-4"><Alert>{error}</Alert></div>;
  if (!data) return null;
  return (
    <section aria-labelledby="delivery-h" className="mt-6 max-w-xl border-t border-separator pt-4">
      <h3 id="delivery-h" className="text-headline font-semibold">Sending signed copies</h3>
      {data.blocked
        ? <div className="mt-2"><Alert tone="info">{data.blocked} {!data.canSend && <>Add one in <Link className="text-accent" href="/admin/integrations?item=otp-gateway">Integrations</Link> (Messaging: SMS / WhatsApp gateway or E-mail sender).</>}</Alert></div>
        : <p className="mt-1 text-footnote text-label2">Copies go out {[data.gateway.configured && `as text messages through the ${data.gateway.via === 'WHATSAPP' ? 'WhatsApp' : 'SMS'} gateway, to the mobile number on the customer record`, data.email.configured && `as e-mails through the e-mail sender (${data.email.mode === 'SMTP' ? 'SMTP' : data.email.mode === 'SIMULATOR' ? 'simulator: nothing is delivered' : 'HTTPS API'}), to the address on the customer record`].filter(Boolean).join(' and ')}.{data.gateway.configured && data.email.configured ? ` When a customer has both, ${data.firstChannel === 'EMAIL' ? 'e-mail' : 'the text message'} goes first and the other is the fall-back.` : ''} A failed send is tried again after {data.backoffMinutes.join(', ')} minutes, then marked failed. <Link className="text-accent" href="/admin/settings?section=security-policy">Change the order ›</Link></p>}
      <p className="mt-2 text-subhead" aria-live="polite">{data.sent} sent · {data.queued} waiting{data.retrying ? ` (${data.retrying} being retried)` : ''} · {data.failed} failed</p>
      {data.recentFailures.length > 0 && <ul className="mt-2 text-footnote text-label2">{data.recentFailures.map((f: any) => <li key={f.id}>{f.reference}: {f.reason}</li>)}</ul>}
      {act.error && <div className="mt-2"><Alert>{act.error}</Alert></div>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={act.busy || !data.canSend || !data.queued} onClick={() => void act.run(() => post('/documents/delivery/run'), 'Sent what was due')}>Send what is due now</Button>
        <Button variant="secondary" disabled={act.busy || !data.failed} onClick={() => void act.run(() => post('/documents/delivery/retry'), 'Failed copies queued again')}>Try failed copies again</Button>
      </div>
      {act.ok && <p className="mt-2 text-footnote text-label2" role="status">{act.ok}</p>}
    </section>
  );
}
