'use client';
import { Alert, Badge, Button, Field, Input, MenuButton, Modal, Select, Textarea } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction } from '@/lib/api';
import { itemAmount, itemMeta, ITEM_TYPES, STATUS_TEXT } from './catalog-ui';
import type { CNode as TreeNode } from './catalog-ui';
import { slug } from './node-modals';

/** "What's included": the line items of one offer, listed like Settings rows with one tidy menu each. */
export function LineItemsSection({ offer, items, editable, onChanged }: { offer: TreeNode; items: TreeNode[]; editable: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<TreeNode | 'new' | null>(null);
  const act = useAction(onChanged);
  const move = (id: string, direction: 'up' | 'down') => act.run(() => post(`/catalog/${id}/reorder`, { direction }));
  return (
    <section aria-labelledby="li-h">
      <div className="mb-2 flex items-end justify-between px-1">
        <div>
          <h3 id="li-h" className="text-footnote font-semibold uppercase tracking-wide text-label2">What’s included</h3>
          <p className="text-footnote text-label2">The parts of this offer, shown to customers. They don’t change the price.</p>
        </div>
        {editable && <Button variant="secondary" className="!min-h-[36px] shrink-0 whitespace-nowrap !px-3 !text-subhead" onClick={() => setEditing('new')}>＋ Add line item</Button>}
      </div>
      {act.error && <div className="mb-2"><Alert>{act.error}</Alert></div>}
      {items.length === 0 ? (
        <p className="rounded-card bg-surface px-4 py-6 text-center text-subhead text-label2 shadow-card">
          Nothing listed yet.{editable && <> <button className="text-accent underline" onClick={() => setEditing('new')}>Add the first line item</button> — for example “100 GB data” or “Unlimited calls”.</>}
        </p>
      ) : (
        <ul className="divide-y divide-separator overflow-visible rounded-card bg-surface shadow-card">
          {items.map((it, i) => {
            const meta = itemMeta(it.itemType);
            const amount = itemAmount(it);
            return (
              <li key={it.id} className="flex items-center gap-3 px-4 py-3">
                <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent/10 text-subhead text-accent">{meta.glyph}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{it.name}{amount && <span className="ml-2 font-normal text-label2">{amount}</span>}</p>
                  <p className="truncate text-footnote text-label2">{meta.label}{it.description ? ` · ${it.description}` : ''}{it.sku ? ` · stock ${it.sku}` : ''}</p>
                </div>
                {it.status !== 'ACTIVE' && <Badge tone={it.status === 'DRAFT' ? 'warning' : 'neutral'}>{STATUS_TEXT[it.status]}</Badge>}
                {editable && (
                  <MenuButton label={`Actions for ${it.name}`} items={[
                    { label: 'Edit…', onSelect: () => setEditing(it) },
                    { label: 'Move up', onSelect: () => move(it.id, 'up'), disabled: i === 0, divider: true },
                    { label: 'Move down', onSelect: () => move(it.id, 'down'), disabled: i === items.length - 1 },
                  ]} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editing && <LineItemModal offer={offer} item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); onChanged(); }} />}
    </section>
  );
}

function LineItemModal({ offer, item, onClose, onDone }: { offer: TreeNode; item: TreeNode | null; onClose: () => void; onDone: () => void }) {
  const [itemType, setItemType] = useState(item?.itemType ?? 'DATA');
  const [name, setName] = useState(item?.name ?? '');
  const [unlimited, setUnlimited] = useState(!!item?.unlimited);
  const [quantity, setQuantity] = useState(item?.quantity ? String(item.quantity) : '');
  const [unit, setUnit] = useState(item?.unit ?? itemMeta('DATA').unit ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [sku, setSku] = useState(item?.sku ?? '');
  const [status, setStatus] = useState(item?.status ?? 'ACTIVE');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const act = useAction();
  const meta = itemMeta(itemType);
  const pickType = (t: string) => { setItemType(t); if (!item) setUnit(itemMeta(t).unit ?? ''); if (t === 'SERVICE' || t === 'CONTENT' || t === 'OTHER') { setQuantity(''); } };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const qty = !unlimited && quantity.trim() ? Number(quantity) : undefined;
    const fields = { itemType, description: description.trim() || undefined, unlimited, quantity: qty, unit: unit.trim() || undefined, sku: sku.trim() || undefined };
    const r = await act.run(async () => {
      if (item) {
        await patch(`/catalog/${item.id}`, { name: name.trim(), ...fields, quantity: qty ?? null, sku: sku.trim(), status: status !== item.status ? status : undefined });
      } else {
        const base = `${offer.id}-${slug(name) || 'item'}`.slice(0, 66);
        await post('/catalog', { level: 'LINE_ITEM', id: base, name: name.trim(), parentId: offer.id, status, ...fields });
      }
      return true;
    });
    if (r) onDone();
  };
  const remove = async () => { if (item && (await act.run(() => del(`/catalog/${item.id}`)))) onDone(); };

  return (
    <Modal title={item ? 'Edit line item' : `Add a line item to ${offer.name}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        {act.error && <Alert>{act.error}</Alert>}
        <Field label="Type"><Select value={itemType} onChange={(e) => pickType(e.target.value)}>{ITEM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></Field>
        <Field label="Name" hint="What the customer reads, e.g. “5G data” or “Phone X1 128GB”."><Input required value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount"><Input type="number" min={1} step={1} inputMode="numeric" value={quantity} disabled={unlimited} onChange={(e) => setQuantity(e.target.value)} placeholder={unlimited ? 'Unlimited' : ''} /></Field>
          <Field label="Unit"><Input value={unit} disabled={unlimited} onChange={(e) => setUnit(e.target.value)} maxLength={20} placeholder="GB, min, unit…" /></Field>
        </div>
        {(itemType === 'DATA' || itemType === 'VOICE' || itemType === 'SMS') && (
          <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={unlimited} onChange={(e) => { setUnlimited(e.target.checked); if (e.target.checked) setSku(''); }} />Unlimited</label>
        )}
        <Field label="Description (optional)"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></Field>
        {(meta.value === 'DEVICE' || meta.value === 'ACCESSORY' || meta.value === 'SIM') && !unlimited && (
          <Field label="Inventory SKU (optional)" hint="Reserve stock for this item when the offer is sold: amount × offers ordered. Leave blank if the offer’s own fulfilment already lists the SKU.">
            <Input value={sku} onChange={(e) => setSku(e.target.value)} maxLength={50} placeholder="e.g. PHONE-X1-128" />
          </Field>
        )}
        <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="ACTIVE">Shown to customers</option><option value="DRAFT">Draft (hidden)</option>{item && <option value="RETIRED">Retired (hidden)</option>}</Select></Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {item ? (confirmDelete
            ? <span className="flex gap-2"><Button type="button" variant="destructive" onClick={remove} disabled={act.busy}>Confirm delete</Button><Button type="button" variant="secondary" onClick={() => setConfirmDelete(false)}>Keep</Button></span>
            : <Button type="button" variant="secondary" onClick={() => setConfirmDelete(true)}>Delete…</Button>) : <span />}
          <span className="flex gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={act.busy || !name.trim()}>{act.busy ? 'Saving…' : item ? 'Save' : 'Add'}</Button></span>
        </div>
      </form>
    </Modal>
  );
}
