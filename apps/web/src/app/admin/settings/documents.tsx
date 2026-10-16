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
        {sw('requireAtOrder', 'A new order must be signed', 'When an agreement applies to what is being ordered, the order cannot be placed until the customer has read and signed it (in the CRM, the shop and the partner API).')}
        {sw('requireAtPlanChange', 'A plan change must be signed', 'The same for moving a service to another plan.')}
        {sw('deliverContracts', 'Send the signed copy to the customer', 'Queued for WhatsApp or SMS when the order is paid, or at once for a plan change, with a secure 15-minute link.')}
        <Field label="Remove unclaimed uploads after (hours)" hint="Identity uploads that never reached a customer."><Input type="number" min={1} value={cur.tempUploadHours} onChange={num('tempUploadHours')} /></Field>
        <Field label="Keep identity documents for (years after the last service ends)"><Input type="number" min={0} value={cur.kycRetentionYears} onChange={num('kycRetentionYears')} /></Field>
        <Field label="Keep signed agreements for (years after the last service ends)"><Input type="number" min={0} value={cur.contractRetentionYears} onChange={num('contractRetentionYears')} /></Field>
      </div>
      {saveError && <div className="mt-3"><Alert>{saveError}</Alert></div>}{ok && <div className="mt-3"><Alert tone="success">{ok}</Alert></div>}
      <div className="mt-4 flex flex-wrap gap-2"><Button disabled={busy || !Object.keys(v).length} onClick={() => void run(() => post('/settings/documents', v), 'Saved')}>Save</Button><Link href="/settings/document-templates" className="inline-flex min-h-tap items-center rounded-control border border-separator bg-surface2 px-5 font-medium">Open document templates</Link></div>
    </Card>
  );
}
