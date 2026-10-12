'use client';
import { Alert, Button, Field, Input, Modal, Select } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction } from '@/lib/api';

/** A node as returned by GET /catalog/tree. Offer-only fields are optional on the other levels. */
export interface TreeNode {
  id: string; name: string; level: 'NETWORK_TYPE' | 'CATEGORY' | 'GROUP' | 'OFFER' | 'LINE_ITEM'; status: string; path: string; parentId?: string | null;
  networkType?: string; kind?: string; description?: string; prices?: any[]; contract?: any; fulfilment?: any; requires?: string[]; excludes?: string[]; salesChannels?: string[]; markets?: string[];
  itemType?: string; quantity?: number; unit?: string; unlimited?: boolean; sku?: string; sortOrder?: number;
  children: TreeNode[]; offerCount: number; activeOfferCount: number; usage?: { services: number; orders: number };
  [k: string]: any;
}

const NOUN: Record<string, string> = { NETWORK_TYPE: 'network type', CATEGORY: 'category', GROUP: 'group', OFFER: 'offer', LINE_ITEM: 'line item' };
const PARENT_LEVEL: Record<string, TreeNode['level'] | undefined> = { CATEGORY: 'NETWORK_TYPE', GROUP: 'CATEGORY', OFFER: 'GROUP' };
const NETWORK_TYPES = [['mobile', 'Mobile'], ['fiber', 'Fibre / broadband'], ['iot', 'IoT'], ['none', 'Other / non-network']] as const;

export const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const idFor = (level: TreeNode['level'], name: string, parent: TreeNode | null) => {
  const s = slug(name);
  if (level === 'NETWORK_TYPE') return s;
  if (level === 'CATEGORY') return `${parent?.id}-${s}`.slice(0, 60);
  if (level === 'GROUP') return `grp-${s}`;
  return s;
};

export function AddNodeModal({ level, parent, onClose, onDone }: { level: TreeNode['level']; parent: TreeNode | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [networkType, setNetworkType] = useState('mobile');
  const act = useAction();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = idFor(level, name, parent);
    if (!id) return;
    const body = level === 'NETWORK_TYPE' ? { level, id, name: name.trim(), networkType, status: 'ACTIVE' } : { level, id, name: name.trim(), parentId: parent!.id, status: 'ACTIVE' };
    const r = await act.run(() => post('/catalog', body));
    if (r) onDone();
  };
  return (
    <Modal title={`New ${NOUN[level]}${parent ? ` in ${parent.name}` : ''}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {act.error && <Alert>{act.error}</Alert>}
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} /></Field>
        {level === 'NETWORK_TYPE' && (
          <Field label="Network" hint="Decides which provisioning and rating systems apply.">
            <Select value={networkType} onChange={(e) => setNetworkType(e.target.value)}>{NETWORK_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={act.busy || !slug(name)}>{act.busy ? 'Adding…' : 'Add'}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function EditNodeModal({ node, all, onClose, onDone }: { node: TreeNode; all: TreeNode[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(node.name);
  const [networkType, setNetworkType] = useState(node.networkType ?? 'mobile');
  const [status, setStatus] = useState(node.status);
  const [parentId, setParentId] = useState(node.parentId ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const act = useAction();
  const parentLevel = PARENT_LEVEL[node.level];
  const parents = parentLevel ? all.filter((n) => n.level === parentLevel) : [];

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await act.run(async () => {
      const changes: Record<string, unknown> = {};
      if (name.trim() !== node.name) changes.name = name.trim();
      if (node.level === 'NETWORK_TYPE' && networkType !== node.networkType) changes.networkType = networkType;
      if (status !== node.status) changes.status = status;
      if (Object.keys(changes).length) await patch(`/catalog/${node.id}`, changes);
      if (parentLevel && parentId && parentId !== node.parentId) await post(`/catalog/${node.id}/move`, { parentId });
      return true;
    });
    if (r) onDone();
  };
  const remove = async () => {
    const r = await act.run(() => del(`/catalog/${node.id}`));
    if (r) onDone();
  };

  return (
    <Modal title={`Edit ${NOUN[node.level]}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        {act.error && <Alert>{act.error}</Alert>}
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} /></Field>
        {node.level === 'NETWORK_TYPE' && (
          <Field label="Network"><Select value={networkType} onChange={(e) => setNetworkType(e.target.value)}>{NETWORK_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        )}
        {parentLevel && (
          <Field label={`Belongs to (${NOUN[parentLevel]})`} hint="Moving re-parents everything beneath it; sold offers keep their history.">
            <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
              {parents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Status" hint="Only active nodes are visible to sales channels. Retiring hides everything beneath it.">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="DRAFT">Draft</option><option value="ACTIVE">Active</option><option value="RETIRED">Retired</option>
          </Select>
        </Field>
        <p className="text-footnote text-label2">Contains {node.offerCount} offer{node.offerCount === 1 ? '' : 's'} · id <code>{node.id}</code></p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {confirmDelete ? (
            <span className="flex items-center gap-2">
              <Button type="button" variant="destructive" onClick={remove} disabled={act.busy}>Confirm delete</Button>
              <Button type="button" variant="secondary" onClick={() => setConfirmDelete(false)}>Keep</Button>
            </span>
          ) : <Button type="button" variant="secondary" onClick={() => setConfirmDelete(true)}>Delete…</Button>}
          <span className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={act.busy || !name.trim()}>{act.busy ? 'Saving…' : 'Save'}</Button>
          </span>
        </div>
      </form>
    </Modal>
  );
}
