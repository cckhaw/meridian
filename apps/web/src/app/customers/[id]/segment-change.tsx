'use client';
import { Alert, Button, Field, Input, Modal, Select } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction } from '@/lib/api';
import { useSegments } from '@/lib/segments';

/** Moves a customer to another segment. It is a considered change, so the reason is required and kept with the move. */
export function SegmentChange({ customer, onDone }: { customer: { id: string; displayName: string; segment: string }; onDone: () => void | Promise<void> }) {
  const segs = useSegments();
  const [open, setOpen] = useState(false);
  const targets = segs.list.filter((s) => s.id !== customer.segment);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const { run, busy, error } = useAction();
  if (segs.list.length < 2) return null;
  const chosen = segs.list.find((s) => s.id === (to || targets[0]?.id));
  return (
    <>
      <Button variant="secondary" onClick={() => { setTo(''); setReason(''); setOpen(true); }}>Change segment</Button>
      {open && (
        <Modal title="Change segment" onClose={() => setOpen(false)}>
          <form className="space-y-4" onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => post(`/customers/${customer.id}/segment`, { segment: chosen?.id, reason }))) { setOpen(false); await onDone(); }
          }}>
            <p className="text-subhead text-label2">{customer.displayName} is now <strong className="text-label">{segs.name(customer.segment)}</strong>. Their accounts, services and orders stay as they are.</p>
            <Field label="Move to"><Select value={chosen?.id ?? ''} onChange={(e) => setTo(e.target.value)}>{targets.map((s) => <option key={s.id} value={s.id}>{s.name}{s.description ? ` · ${s.description}` : ''}</option>)}</Select></Field>
            {chosen?.individual && <p className="text-footnote text-label2">{chosen.name} customers are individuals: the ID document must be unique, and a customer with departments cannot move here.</p>}
            <Field label="Reason" hint="Kept with the change, with your name and the time."><Input required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Registered a business" /></Field>
            {error && <Alert>{error}</Alert>}
            <div className="flex gap-3"><Button type="submit" disabled={busy || !chosen}>{busy ? 'Moving…' : 'Move customer'}</Button><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button></div>
          </form>
        </Modal>
      )}
    </>
  );
}
