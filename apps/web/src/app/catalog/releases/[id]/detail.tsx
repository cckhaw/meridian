'use client';
import { Alert, Badge, Button, Empty, Field, Input, LargeTitle, Modal, Spinner, Textarea } from '@meridian/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { del, post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label, money, toInput, toMinor } from '@/lib/format';
import { NodePicker, type Picked } from '../../node-picker';
import { ImpactPanel, WhatIfPanel } from './impact';
import { setActiveRelease, useActiveReleaseId } from '../../release';
import { STATUS_TONE, type Release } from '../list';

interface Change { id: number; seq: number; op: string; nodeId: string; note: string | null; groupKey: string | null; createdBy: string }
interface Conflict { nodeId: string; name: string | null; kind: 'CHANGED_LIVE' | 'DELETED_LIVE' | 'EXISTS_LIVE'; baseVersion: number | null; liveVersion: number | null; lastBy: string | null; lastAt: string | null }
interface DiffField { field: string; before: unknown; after: unknown }
interface DiffItem { id: string; name: string; summary: string }
interface DiffNode { id: string; name: string; level: string; kind: 'ADDED' | 'CHANGED' | 'DELETED'; groupKey: string | null; fields: DiffField[]; lineItems: { added: DiffItem[]; removed: DiffItem[]; changed: Array<DiffItem & { fields: DiffField[] }> } }
interface Comment { id: number; author: string; kind: 'COMMENT' | 'SUBMIT' | 'APPROVE' | 'REJECT' | 'REOPEN' | 'PUBLISH'; body: string; createdAt: string }
interface Preview {
  release: Release; changes: Change[]; results: Array<{ id: number; ok: boolean; error?: string }>; conflicts: Conflict[]; ready: boolean; canPublish: boolean;
  summary: { changes: number; added: number; changed: number; retired: number; repriced: number; moved: number; madeLive: number; deleted: number; lineItems: number; errors: number };
  nodes: DiffNode[]; groups: Array<{ key: string; oldId: string; newId: string }>;
}

const OP: Record<string, string> = { CREATE: 'Create', UPDATE: 'Change', MOVE: 'Move', STATUS: 'Status', DELETE: 'Delete', COPY_LINE_ITEMS: 'Copy line items' };
const FIELD: Record<string, string> = { parentId: 'Group', kind: 'Type', salesChannels: 'Channels', activeFrom: 'Goes live', partnerCode: 'Partner code', validityDays: 'Valid for (days)', ocs: 'Charging plan', group: 'Group plan terms', requires: 'Customer must first have', excludes: 'Cannot be bought with', prices: 'Prices' };
const STEP: Record<Comment['kind'], string> = { COMMENT: 'commented', SUBMIT: 'sent it for review', APPROVE: 'approved it', REJECT: 'asked for changes', REOPEN: 'took it back to a draft', PUBLISH: 'published it' };
const WHERE: Record<string, string> = {
  DRAFT: 'A draft: changes can still be added. Send it for review when it is ready.', IN_REVIEW: 'In review: it is frozen until it is approved or sent back.', APPROVED: 'Approved: it can be published now or at a chosen time.',
  REJECTED: 'Sent back: reopen it to change it and send it again.', PUBLISHED: 'Published: these changes are live.', CANCELLED: 'Thrown away: nothing in it went live.',
};
const CONFLICT: Record<string, string> = { CHANGED_LIVE: 'changed in the live catalog after it was added here', DELETED_LIVE: 'was deleted from the live catalog', EXISTS_LIVE: 'now exists in the live catalog, and this release creates it' };

/** A stored value as a person reads it. */
function show(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'prices' && Array.isArray(v)) return v.map((p: any) => `${label(p.type)} ${money(p.amount?.amountMinor, p.amount?.currency)}${p.periodMonths && p.periodMonths !== 1 ? ` per ${p.periodMonths} months` : ''}${p.taxInclusive === false ? ' + tax' : ''}`).join(' · ');
  if (field === 'fulfilment' && typeof v === 'object') {
    const f = v as any;
    const how = [...(f.options ?? []), ...(!(f.options ?? []).length ? [f.requiresShipping && 'delivered', f.requiresCollection && 'collect in store', f.requiresInstallation && 'installation', f.requiresSimActivation && 'SIM activation'].filter(Boolean) : [])];
    return `${how.length ? how.join(', ') : 'nothing to fulfil'}${(f.inventorySkus ?? []).length ? ` · stock: ${f.inventorySkus.join(', ')}` : ''}`;
  }
  if (field === 'contract' && typeof v === 'object') return (v as any).termMonths ? `${(v as any).termMonths}-month contract` : 'No contract';
  if (field === 'status' && typeof v === 'string') return v === 'ACTIVE' ? 'Live' : label(v);
  if (field === 'activeFrom' && typeof v === 'string') return dt(v);
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
const fieldLabel = (f: string) => FIELD[f] ?? label(f.replace(/([A-Z])/g, '_$1'));

function FieldRows({ fields, added }: { fields: DiffField[]; added?: boolean }) {
  return (
    <dl className="divide-y divide-separator text-subhead">
      {fields.map((f) => (
        <div key={f.field} className="grid gap-1 py-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-label2">{fieldLabel(f.field)}</dt>
          <dd className="min-w-0 break-words">{added ? show(f.field, f.after) : <><span className="text-label2 line-through decoration-label2/50">{show(f.field, f.before)}</span> <span aria-hidden>→</span> <span className="font-medium">{show(f.field, f.after)}</span></>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A sold offer cannot be repriced in place: pick it, set the new prices, and the release gets a new version, the old one's retirement, and the dependents pointed at the new one. */
function RepriceModal({ releaseId, onClose, onDone }: { releaseId: string; onClose: () => void; onDone: () => void }) {
  const [offer, setOffer] = useState<Picked | null>(null);
  const live = useApi<any>(offer ? `/catalog/${encodeURIComponent(offer.id)}` : null);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [repoint, setRepoint] = useState(true);
  const act = useAction();
  const prices: any[] = live.data?.prices ?? [];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!offer) return;
    const next = prices.map((p, i) => ({ type: p.type, amount: { amountMinor: amounts[i] !== undefined && amounts[i] !== '' ? toMinor(amounts[i]!) : p.amount.amountMinor, currency: p.amount.currency }, taxInclusive: p.taxInclusive, ...(p.periodMonths ? { periodMonths: p.periodMonths } : {}) }));
    const r = await act.run(() => post(`/catalog/releases/${releaseId}/reprice`, { offerId: offer.id, prices: next, repointDependents: repoint }));
    if (r) onDone();
  };
  return (
    <Modal title="New version of a sold offer" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-subhead text-label2">An offer that has been sold cannot be repriced in place: its subscribers would be repriced. This adds a new offer with the new prices and retires the old one when the release is published. Subscribers stay on the old offer.</p>
        {act.error && <Alert>{act.error}</Alert>}
        {!offer ? <NodePicker levels={['OFFER']} placeholder="Find the offer…" onPick={setOffer} /> : (
          <>
            <p className="flex items-center justify-between gap-3 text-body"><span className="font-medium">{offer.name}</span><button type="button" className="text-subhead text-accent" onClick={() => { setOffer(null); setAmounts({}); }}>Choose another</button></p>
            {live.loading && <Spinner />}
            {live.error && <Alert>{live.error}</Alert>}
            {prices.map((p, i) => (
              <Field key={i} label={`${label(p.type)}: now ${money(p.amount.amountMinor, p.amount.currency)}${p.periodMonths && p.periodMonths !== 1 ? ` per ${p.periodMonths} months` : ''}`}>
                <Input inputMode="decimal" placeholder={toInput(p.amount.amountMinor)} value={amounts[i] ?? ''} onChange={(e) => setAmounts({ ...amounts, [i]: e.target.value.replace(/[^\d.]/g, '') })} />
              </Field>
            ))}
            <label className="flex items-start gap-2 text-subhead"><input type="checkbox" className="mt-1" checked={repoint} onChange={(e) => setRepoint(e.target.checked)} /><span>Point offers that require, exclude or list the old one at the new one</span></label>
          </>
        )}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={act.busy || !offer || !prices.length}>{act.busy ? 'Adding…' : 'Add to release'}</Button></div>
      </form>
    </Modal>
  );
}

/** One release: what it changes, whether it would apply, what has moved underneath it, who reviewed it, and the actions for each stage (send for review, approve or send back, publish, schedule, throw away, reverse). */
export function ReleaseDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useAuth();
  const active = useActiveReleaseId();
  const involved = can('catalog:write', 'release:submit', 'release:approve', 'release:publish');
  const rel = useApi<{ release: Release; changes: Change[]; conflicts: Conflict[]; nodeIds: string[]; comments: Comment[]; review: { blocker: string | null; reviewers: { count: number; names: string[] } } }>(involved ? `/catalog/releases/${id}` : null);
  const pv = useApi<Preview>(involved ? `/catalog/releases/${id}/preview` : null);
  const reload = async () => { await Promise.all([rel.reload(), pv.reload()]); };
  const act = useAction(reload);
  const [when, setWhen] = useState('');
  const [text, setText] = useState('');
  const [reprice, setReprice] = useState(false);
  if (!involved) return <Alert tone="info">Releases are for people who maintain or review the catalog.</Alert>;
  if (rel.error) return <Alert>{rel.error}</Alert>;
  if (!rel.data) return <Spinner />;
  const r = rel.data.release;
  const status = r.status;
  const p = pv.data;
  const resultOf = (cid: number) => p?.results.find((x) => x.id === cid);
  const editable = status === 'DRAFT' && can('catalog:write');
  const blocker = rel.data.review.blocker;
  const reviewers = rel.data.review.reviewers;
  const send = (path: string, body: unknown = {}) => act.run(async () => { await post(`/catalog/releases/${id}/${path}`, body); setText(''); });
  const publish = () => { if (confirm(`Publish ${r.number}? All ${rel.data!.changes.length} changes go live together, now.`)) void act.run(async () => { await post(`/catalog/releases/${id}/publish`); setActiveRelease(null); }); };
  const schedule = () => act.run(() => post(`/catalog/releases/${id}/schedule`, { publishAt: new Date(when).toISOString() }));
  const unschedule = () => act.run(() => post(`/catalog/releases/${id}/schedule`, { publishAt: null }));
  const cancel = () => { if (confirm(`Throw away ${r.number}? Nothing in it goes live.`)) void act.run(async () => { await post(`/catalog/releases/${id}/cancel`); if (active === id) setActiveRelease(null); }); };
  const reverse = async () => { const rv = await act.run(() => post<Release>(`/catalog/releases/${id}/reverse`)); if (rv) router.push(`/catalog/releases/${rv.id}`); };
  const S = p?.summary;
  const chips: Array<[string, number | undefined]> = [['Added', S?.added], ['Changed', S?.changed], ['Repriced', S?.repriced], ['Made live', S?.madeLive], ['Retired', S?.retired], ['Moved', S?.moved], ['Deleted', S?.deleted], ['Line items', S?.lineItems]];
  const note = (placeholder: string) => <Field label="Note" optional><Textarea rows={2} value={text} maxLength={2000} placeholder={placeholder} onChange={(e) => setText(e.target.value)} /></Field>;
  return (
    <>
      <LargeTitle subtitle={r.description ?? 'A batch of catalog changes that go live together.'}>{r.number} · {r.name}</LargeTitle>
      <p className="mb-4"><Link href="/catalog/releases" className="text-subhead text-accent">← All releases</Link></p>
      <p className="mb-2 flex flex-wrap items-center gap-2 text-subhead text-label2">
        <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{label(status)}</Badge>
        {r.publishAt && !r.publishedAt && <Badge tone={r.publishError ? 'danger' : 'neutral'}>{`Publishes ${dt(r.publishAt)}`}</Badge>}
        <span>Started by {r.createdBy}, {dt(r.createdAt)}</span>
        {r.submittedBy && status !== 'DRAFT' && <span>· sent for review by {r.submittedBy}</span>}
        {r.decidedBy && (status === 'APPROVED' || status === 'PUBLISHED') && <span>· approved by {r.decidedBy}</span>}
        {r.decidedBy && status === 'REJECTED' && <span>· sent back by {r.decidedBy}</span>}
        {r.publishedAt && <span>· published by {r.publishedBy ?? ''} {dt(r.publishedAt)}</span>}
        {r.reversesReleaseId && <Link href={`/catalog/releases/${r.reversesReleaseId}`} className="text-accent">· reverses another release</Link>}
      </p>
      <p className="mb-4 text-subhead text-label2">{WHERE[status]}</p>
      {(act.error || pv.error) && <div className="mb-4"><Alert>{act.error ?? pv.error}</Alert></div>}
      {r.publishError && <div className="mb-4"><Alert>The scheduled publish did not happen: {r.publishError} Take approval back, fix it and approve it again, or publish now.</Alert></div>}

      <div className="mb-6 space-y-4 rounded-card bg-surface p-4 shadow-card">
        <div className="flex flex-wrap items-end gap-3">
          {editable && (active === id ? <Button variant="secondary" onClick={() => setActiveRelease(null)}>Stop working in it</Button> : <Button variant="secondary" onClick={() => setActiveRelease(id)}>Work in this release</Button>)}
          {editable && <Button variant="secondary" onClick={() => setReprice(true)}>New version of a sold offer…</Button>}
          {status === 'DRAFT' && can('release:submit') && <Button onClick={() => void send('submit', { note: text.trim() || undefined })} disabled={act.busy || !p?.ready} title={p && !p.ready ? 'Resolve the problems below first' : undefined}>Send for review</Button>}
          {status === 'IN_REVIEW' && can('release:approve') && !blocker && <>
            <Button onClick={() => void send('approve', { note: text.trim() || undefined })} disabled={act.busy || !p?.ready}>Approve</Button>
            <Button variant="secondary" onClick={() => void send('reject', { reason: text.trim() })} disabled={act.busy || !text.trim()} title={!text.trim() ? 'Say what needs to change' : undefined}>Ask for changes</Button>
          </>}
          {(status === 'IN_REVIEW' || status === 'APPROVED' || status === 'REJECTED') && can('catalog:write', 'release:approve', 'release:publish') && <Button variant="secondary" onClick={() => void send('reopen', { note: text.trim() || undefined })} disabled={act.busy}>{status === 'IN_REVIEW' ? 'Take it back to a draft' : status === 'APPROVED' ? 'Take approval back' : 'Reopen to change it'}</Button>}
          {status === 'APPROVED' && can('release:publish') && <>
            <Button onClick={publish} disabled={act.busy || !p?.canPublish} title={p && !p.canPublish ? 'Resolve the problems below first' : undefined}>Publish now</Button>
            <span className="flex flex-wrap items-end gap-2">
              <Field label="Publish at"><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
              <Button variant="secondary" onClick={() => void schedule()} disabled={act.busy || !when || !p?.canPublish}>Schedule</Button>
              {r.publishAt && <Button variant="secondary" onClick={() => void unschedule()} disabled={act.busy}>Clear schedule</Button>}
            </span>
          </>}
          {['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED'].includes(status) && can('catalog:write') && <Button variant="destructive" onClick={cancel} disabled={act.busy}>Throw away…</Button>}
          {status === 'PUBLISHED' && can('catalog:write') && <Button variant="secondary" onClick={() => void reverse()} disabled={act.busy}>Create a reverse release</Button>}
        </div>
        {status === 'IN_REVIEW' && can('release:approve') && blocker && <Alert tone="info">{blocker}</Alert>}
        {['DRAFT', 'IN_REVIEW'].includes(status) && reviewers.count === 0 && <Alert tone="info">Nobody else can review this release. Someone who holds “approve releases” (a second administrator, say) has to be added in Settings → Users before it can go live.</Alert>}
        {status === 'IN_REVIEW' && !can('release:approve') && <p className="text-subhead text-label2">Waiting for someone who can approve releases{reviewers.count ? `: ${reviewers.names.join(', ')}${reviewers.count > reviewers.names.length ? ` and ${reviewers.count - reviewers.names.length} more` : ''}` : ''}.</p>}
        {(['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED'].includes(status)) && (status === 'DRAFT' ? can('release:submit') : status === 'IN_REVIEW' ? can('release:approve') && !blocker : false) && note(status === 'DRAFT' ? 'For the reviewer: what this release is for, what to look at' : 'Why you approve it, or what needs to change (required to ask for changes)')}
        {status === 'APPROVED' && !can('release:publish') && <p className="text-subhead text-label2">Waiting for someone who can publish releases.</p>}
      </div>

      {pv.loading && !p && <Spinner label="Working out what publishing would do" />}
      {p && (
        <>
          <ul className="mb-6 flex flex-wrap gap-2" aria-label="What this release does">
            {chips.filter(([, n]) => n).map(([l, n]) => <li key={l}><Badge tone="neutral">{n} {l.toLowerCase()}</Badge></li>)}
            {!!S?.errors && <li><Badge tone="danger">{S.errors} {S.errors === 1 ? 'change refused' : 'changes refused'}</Badge></li>}
            {p.groups.map((g) => <li key={g.key}><Badge tone="neutral">{g.oldId} → {g.newId}</Badge></li>)}
          </ul>

          {p.conflicts.length > 0 && (
            <section className="mb-6" aria-label="Conflicts">
              <h2 className="mb-2 px-1 text-footnote font-semibold uppercase tracking-wide text-label2">Changed underneath this release</h2>
              <ul className="divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
                {p.conflicts.map((c) => (
                  <li key={c.nodeId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <p className="min-w-0 flex-1 text-subhead"><Link href={`/catalog?node=${encodeURIComponent(c.nodeId)}`} className="font-medium text-accent">{c.name ?? c.nodeId}</Link> {CONFLICT[c.kind]}{c.lastBy ? ` (by ${c.lastBy}${c.lastAt ? `, ${dt(c.lastAt)}` : ''})` : ''}.</p>
                    {editable && c.kind === 'CHANGED_LIVE' && <Button variant="secondary" disabled={act.busy} onClick={() => act.run(() => post(`/catalog/releases/${id}/rebase`, { nodeId: c.nodeId }))}>Keep the live change and apply mine on top</Button>}
                  </li>
                ))}
              </ul>
              <p className="mt-2 px-1 text-footnote text-label2">{status === 'DRAFT' ? 'It cannot be sent for review until each of these is accepted or its changes are removed.' : 'Take the release back to a draft to resolve these, then send it for review again.'}</p>
            </section>
          )}

          <section className="mb-6" aria-label="Changes">
            <h2 className="mb-2 px-1 text-footnote font-semibold uppercase tracking-wide text-label2">Changes, in the order they are applied</h2>
            {!p.changes.length ? <Empty>No changes yet. Choose “Work in this release”, then add or edit offers on the Catalog screen.</Empty> : (
              <ul className="divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
                {p.changes.map((c) => {
                  const res = resultOf(c.id);
                  return (
                    <li key={c.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                      <span className="w-6 shrink-0 text-footnote text-label2">{c.seq}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-subhead"><Badge tone="neutral">{OP[c.op] ?? c.op}</Badge> <span className="font-medium">{c.nodeId}</span>{c.note ? <span className="text-label2"> · {c.note}</span> : null} <span className="text-footnote text-label2">· {c.createdBy}</span></p>
                        {res && !res.ok && <p className="mt-1 text-footnote text-danger">Would be refused: {res.error}</p>}
                      </div>
                      {editable && <Button variant="secondary" className="!min-h-[36px] max-lg:!min-h-tap !px-3 !text-subhead" disabled={act.busy} onClick={() => act.run(() => del(`/catalog/releases/${id}/changes/${c.id}`))}>Remove</Button>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {p.nodes.length > 0 && !['PUBLISHED', 'CANCELLED'].includes(status) && <><ImpactPanel releaseId={id} /><WhatIfPanel releaseId={id} /></>}

          {p.nodes.length > 0 && (
            <section className="mb-6" aria-label="What changes">
              <h2 className="mb-2 px-1 text-footnote font-semibold uppercase tracking-wide text-label2">{status === 'PUBLISHED' ? 'What publishing changed' : 'What publishing would change'}</h2>
              <ul className="space-y-3">
                {p.nodes.map((n) => (
                  <li key={n.id} className="rounded-card bg-surface p-4 shadow-card">
                    <p className="mb-1 flex flex-wrap items-center gap-2"><Link href={`/catalog?node=${encodeURIComponent(n.id)}`} className="font-medium text-accent">{n.name}</Link>
                      <Badge tone={n.kind === 'ADDED' ? 'success' : n.kind === 'DELETED' ? 'danger' : 'neutral'}>{n.kind === 'ADDED' ? 'New' : n.kind === 'DELETED' ? 'Deleted' : 'Changed'}</Badge>
                      <span className="text-footnote text-label2">{label(n.level)}</span></p>
                    {n.fields.length > 0 && <FieldRows fields={n.fields} added={n.kind === 'ADDED'} />}
                    {(n.lineItems.added.length + n.lineItems.removed.length + n.lineItems.changed.length) > 0 && (
                      <div className="mt-2 text-subhead">
                        <p className="text-label2">Line items</p>
                        <ul className="mt-1 space-y-1">
                          {n.lineItems.added.map((i) => <li key={i.id}><span className="text-success">+ {i.name}</span> <span className="text-label2">{i.summary}</span></li>)}
                          {n.lineItems.removed.map((i) => <li key={i.id}><span className="text-danger">− {i.name}</span> <span className="text-label2">{i.summary}</span></li>)}
                          {n.lineItems.changed.map((i) => <li key={i.id}>{i.name}: {i.fields.map((f) => `${fieldLabel(f.field)} ${show(f.field, f.before)} → ${show(f.field, f.after)}`).join('; ')}</li>)}
                        </ul>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <section aria-label="Review conversation" className="mb-6">
        <h2 className="mb-2 px-1 text-footnote font-semibold uppercase tracking-wide text-label2">Review</h2>
        {!rel.data.comments.length ? <Empty>Nothing yet. Comments and review decisions appear here.</Empty> : (
          <ul className="divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {rel.data.comments.map((c) => (
              <li key={c.id} className="px-4 py-3">
                <p className="text-subhead"><span className="font-medium">{c.author}</span> <span className="text-label2">{STEP[c.kind]} · {dt(c.createdAt)}</span></p>
                {c.body && <p className="mt-1 whitespace-pre-wrap break-words text-subhead">{c.body}</p>}
              </li>
            ))}
          </ul>
        )}
        <CommentBox releaseId={id} onDone={reload} />
      </section>
      {reprice && <RepriceModal releaseId={id} onClose={() => setReprice(false)} onDone={() => { setReprice(false); void reload(); }} />}
    </>
  );
}

function CommentBox({ releaseId, onDone }: { releaseId: string; onDone: () => Promise<void> }) {
  const [body, setBody] = useState('');
  const act = useAction(onDone);
  const add = async (e: React.FormEvent) => { e.preventDefault(); if (await act.run(() => post(`/catalog/releases/${releaseId}/comments`, { body: body.trim() }))) setBody(''); };
  return (
    <form onSubmit={add} className="mt-3 space-y-2">
      {act.error && <Alert>{act.error}</Alert>}
      <Field label="Add a comment"><Textarea rows={2} value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} /></Field>
      <Button type="submit" variant="secondary" disabled={act.busy || !body.trim()}>{act.busy ? 'Adding…' : 'Comment'}</Button>
    </form>
  );
}
