'use client';
import { Alert, Button, Field, Input, Modal, Select } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction } from '@/lib/api';
import type { CNode as TreeNode } from './catalog-ui';
import { NodePicker } from './node-picker';

export type { TreeNode };

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
          <Field label="Network" hint="Describes this branch only. What an offer sets up and how it is charged comes from its offer type.">
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

export function EditNodeModal({ node, parentName, onClose, onDone }: { node: TreeNode; parentName?: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(node.name);
  const [networkType, setNetworkType] = useState(node.networkType ?? 'mobile');
  const [status, setStatus] = useState(node.status);
  const [parentId, setParentId] = useState(node.parentId ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const act = useAction();
  const parentLevel = PARENT_LEVEL[node.level];
  const [newParentName, setNewParentName] = useState<string | null>(null);
  const [changingParent, setChangingParent] = useState(false);

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
            {changingParent
              ? <NodePicker levels={[parentLevel]} placeholder={`Search ${NOUN[parentLevel]}s…`} onPick={(n) => { setParentId(n.id); setNewParentName(n.name); setChangingParent(false); }} />
              : <div className="flex min-h-tap items-center justify-between gap-3 rounded-control bg-surface2 px-3"><span className="truncate">{newParentName ?? parentName ?? node.parentId}</span><button type="button" className="shrink-0 text-subhead text-accent" onClick={() => setChangingParent(true)}>Change</button></div>}
          </Field>
        )}
        <Field label="Status" hint="Only active nodes are visible to sales channels. Retiring hides everything beneath it.">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="DRAFT">Draft</option><option value="ACTIVE">Active</option><option value="RETIRED">Retired</option>
          </Select>
        </Field>
        <p className="text-footnote text-label2">{node.level === 'OFFER' ? '' : `Contains ${node.offerCount} offer${node.offerCount === 1 ? '' : 's'} · `}id <code>{node.id}</code></p>
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
