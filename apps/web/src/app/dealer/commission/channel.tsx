'use client';
import { Alert, Badge, Button, DataList, Empty, Field, Input, Modal, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { patch, useAction, useApi } from '@/lib/api';
import { label } from '@/lib/format';

/** The dealer channel: tier, parent, and how each dealer is paid. Override commission follows the parent chain. */
export function Channel() {
  const tree = useApi<{ items: any[] }>('/commission/hierarchy');
  const meta = useApi<any>('/commission/meta');
  const [edit, setEdit] = useState<any | null>(null);
  const act = useAction(tree.reload);
  if (tree.error) return <Alert>{tree.error}</Alert>;
  if (!tree.data || !meta.data) return <Spinner />;
  const set = (k: string, v: string) => setEdit((x: any) => ({ ...x, [k]: v }));
  return (
    <div className="space-y-5">
      <p className="text-subhead text-label2">Direct channels (stores, telesales, self-serve) earn through plans assigned to the store, the salesperson or the channel. Indirect partners sit in this tree: a plan assigned to a master distributor covers the dealers beneath it unless they have their own.</p>
      {tree.data.items.length === 0 ? <Empty>No dealers yet. Add them under Dealers.</Empty> : (
        <DataList label="Dealer channel" rows={tree.data.items} rowKey={(r) => r.id}
          columns={[
            { key: 'name', label: 'Dealer', primary: true, render: (r) => <span style={{ paddingLeft: `${r.depth * 1.25}rem` }} className="font-medium">{r.depth ? '↳ ' : ''}{r.name} <span className="font-mono text-footnote text-label2">{r.id}</span></span> },
            { key: 'tier', label: 'Tier', render: (r) => label(r.tier) },
            { key: 'parent', label: 'Reports to', render: (r) => r.parentDealerId ?? '—' },
            { key: 'bank', label: 'Payout', render: (r) => <Badge tone={r.hasBank ? 'success' : 'warning'}>{r.hasBank ? 'Bank on file' : 'No bank account'}</Badge> },
            { key: 'sap', label: 'SAP vendor', render: (r) => r.sapVendorNo ?? '—' },
          ]}
          actions={(r) => <Button variant="secondary" onClick={() => setEdit({ id: r.id, name: r.name, tier: r.tier, parentDealerId: r.parentDealerId ?? '', bankAccountName: '', bankAccountNo: '', bankCode: '', sapVendorNo: r.sapVendorNo ?? '' })}>Edit</Button>} />
      )}
      {edit && (
        <Modal title={`${edit.name}`} onClose={() => setEdit(null)}>
          <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); const body: Record<string, unknown> = { tier: edit.tier, parentDealerId: edit.parentDealerId || null, sapVendorNo: edit.sapVendorNo || null }; if (edit.bankAccountNo) { body.bankAccountNo = edit.bankAccountNo; body.bankCode = edit.bankCode; body.bankAccountName = edit.bankAccountName; } if (await act.run(() => patch(`/commission/dealers/${edit.id}/channel`, body))) setEdit(null); }}>
            <Field label="Tier"><Select value={edit.tier} onChange={(e) => set('tier', e.target.value)}>{meta.data.tiers.map((t: string) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
            <Field label="Reports to" hint="The dealer above this one. Blank for a top-level dealer."><Select value={edit.parentDealerId} onChange={(e) => set('parentDealerId', e.target.value)}><option value="">(none)</option>{tree.data.items.filter((r) => r.id !== edit.id).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.id})</option>)}</Select></Field>
            <Field label="SAP vendor number" hint="The dealer's account in SAP accounts payable"><Input className="font-mono" value={edit.sapVendorNo} onChange={(e) => set('sapVendorNo', e.target.value)} /></Field>
            <p className="text-footnote text-label2">Bank details are kept private. Enter them to set or replace them; leave blank to keep what is on file.</p>
            <Field label="Account name"><Input value={edit.bankAccountName} onChange={(e) => set('bankAccountName', e.target.value)} /></Field>
            <Field label="Account number"><Input className="font-mono" inputMode="numeric" value={edit.bankAccountNo} onChange={(e) => set('bankAccountNo', e.target.value)} /></Field>
            <Field label="Bank code"><Input className="font-mono" value={edit.bankCode} onChange={(e) => set('bankCode', e.target.value)} /></Field>
            {act.error && <Alert>{act.error}</Alert>}
            <div className="flex justify-end gap-2"><Button type="button" variant="plain" onClick={() => setEdit(null)}>Cancel</Button><Button type="submit" disabled={act.busy}>{act.busy ? 'Saving…' : 'Save'}</Button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}
