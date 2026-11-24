import type { PriceComponent } from '@meridian/types';
import { audit } from './audit.js';
import { copyLineItems, createNode, deleteNode, getNode, getOffer, moveNode, nodeUsage, sameValue, setStatus, toNode, updateNode, withoutPriceIds, type NodeInput, type NodePatch } from './catalog.js';
import type { Db, Queryable, Row } from './db.js';
import { conflict, DomainError, forbidden, invalid, notFound } from './errors.js';
import { raiseEvent } from './events.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';
import { withRollback } from './rollback.js';

/**
 * Catalog releases. A release is a named, ordered list of catalog changes that are NOT live until it is published. Each change is stored as the input the existing catalog
 * function takes, and publishing replays them through those functions (`createNode`, `updateNode`, `moveNode`, `setStatus`, `deleteNode`, `copyLineItems`), so every rule of the
 * catalog (a sold offer cannot be repriced, a SKU is reserved once, prerequisites must exist, the parent must fit) holds with no validation of its own here.
 *
 * - The preview and the diff run the changes in a transaction that is rolled back (the pattern of the CSV import's check), one savepoint per change, so each change reports its
 *   own refusal and what the diff shows is exactly what publishing would do.
 * - Publishing is one transaction: every change applies or none does.
 * - A node is claimed by at most one open release; a change to a node that changed live after it was staged is a conflict that blocks publishing until it is accepted or removed.
 * - Scheduled publishing is done by the same sweep that activates scheduled offers.
 */
export type ReleaseOp = 'CREATE' | 'UPDATE' | 'MOVE' | 'STATUS' | 'DELETE' | 'COPY_LINE_ITEMS';
export type ReleaseStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'PUBLISHED' | 'REJECTED' | 'CANCELLED';
export const RELEASE_MAX_CHANGES = 500;
/** What a release can be in while changes are still waiting to go live (its nodes are claimed). */
export const OPEN_RELEASE_STATES: ReleaseStatus[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED'];   // a rejected release still holds its nodes: it can be reopened, or thrown away
const EDITABLE: ReleaseStatus[] = ['DRAFT'];
const PUBLISHABLE: ReleaseStatus[] = ['APPROVED'];     // only a release someone other than its authors has approved goes live

export interface Release {
  id: string; number: string; name: string; description: string | null; status: ReleaseStatus; publishAt: string | null; publishError: string | null; reversesReleaseId: string | null;
  createdBy: string; createdAt: string; updatedAt: string; publishedBy: string | null; publishedAt: string | null; submittedBy: string | null; submittedAt: string | null; decidedBy: string | null; decidedAt: string | null;
  result: any | null; version: number; changeCount?: number;
}
export interface ReleaseChange { id: number; releaseId: string; seq: number; op: ReleaseOp; nodeId: string; payload: any; baseVersion: number | null; groupKey: string | null; note: string | null; createdBy: string; createdAt: string }

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const toRelease = (r: Row): Release => ({
  id: r.id, number: r.number, name: r.name, description: r.description ?? null, status: r.status, publishAt: iso(r.publishAt), publishError: r.publishError ?? null, reversesReleaseId: r.reversesReleaseId ?? null,
  createdBy: r.createdBy, createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!, publishedBy: r.publishedBy ?? null, publishedAt: iso(r.publishedAt), submittedBy: r.submittedBy ?? null, submittedAt: iso(r.submittedAt), decidedBy: r.decidedBy ?? null, decidedAt: iso(r.decidedAt), result: r.result ?? null, version: r.version,
  ...(r.changeCount !== undefined ? { changeCount: Number(r.changeCount) } : {}),
});
const toChange = (r: Row): ReleaseChange => ({ id: Number(r.id), releaseId: r.releaseId, seq: r.seq, op: r.op, nodeId: r.nodeId, payload: r.payload ?? {}, baseVersion: r.baseVersion ?? null, groupKey: r.groupKey ?? null, note: r.note ?? null, createdBy: r.createdBy, createdAt: iso(r.createdAt)! });
/** What went wrong, in the words the catalog used (it lists every rule an offer broke). */
export const failureText = (e: unknown): string => {
  const d = (e as { details?: unknown }).details;
  return Array.isArray(d) && d.length && d.every((x) => typeof x === 'string') ? `${(e as Error).message}: ${(d as string[]).join('; ')}` : (e as Error).message;
};

// ───────────────────────── releases ─────────────────────────
export async function createRelease(q: Queryable, actor: string, i: { name: string; description?: string; reversesReleaseId?: string }): Promise<Release> {
  const name = (i.name ?? '').trim();
  if (!name) throw invalid('Give the release a name.');
  if (name.length > 120) throw invalid('The name is up to 120 characters.');
  const r = (await q.query(`INSERT INTO catalog_releases (name, description, created_by, reverses_release_id) VALUES ($1, $2, $3, $4) RETURNING *`, [name, i.description?.trim() || null, actor, i.reversesReleaseId ?? null])).rows[0]!;
  await audit(q, actor, 'catalog_release', r.id, 'RELEASE_CREATED', { number: r.number, name });
  return toRelease(r);
}

export async function getRelease(q: Queryable, id: string, lock = false): Promise<Release> {
  const r = (await q.query(`SELECT r.*, (SELECT count(*) FROM catalog_release_changes c WHERE c.release_id = r.id) AS change_count FROM catalog_releases r WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`, [id])).rows[0];
  if (!r) throw notFound('release', id);
  return toRelease(r);
}

/** Releases, newest first, a page at a time; `status` may be a comma-separated list. */
export async function listReleases(q: Queryable, f: { status?: string; limit?: number; cursor?: string } = {}): Promise<Page<Release>> {
  const limit = pageSize(f.limit, 25, 100);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  const statuses = (f.status ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (statuses.length) where.push(`r.status = ANY(${p(statuses)}::text[])`);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(r.created_at, r.id) < (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(
    `SELECT r.*, r.created_at::text AS cursor_ts, (SELECT count(*) FROM catalog_release_changes c WHERE c.release_id = r.id) AS change_count FROM catalog_releases r
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC, r.id DESC LIMIT ${p(limit + 1)}`, params)).rows;
  const page = toPage(rows, limit, (r) => [r.cursorTs as string, r.id as string]);
  return { items: page.items.map(toRelease), nextCursor: page.nextCursor };
}

export async function updateRelease(q: Queryable, actor: string, id: string, p: { name?: string; description?: string }): Promise<Release> {
  const cur = await getRelease(q, id, true);
  if (!EDITABLE.includes(cur.status)) throw conflict(`${cur.number} is ${cur.status.toLowerCase().replace('_', ' ')}: only a draft release can be renamed.`);
  const name = p.name === undefined ? cur.name : p.name.trim();
  if (!name || name.length > 120) throw invalid('The name is 1 to 120 characters.');
  await q.query(`UPDATE catalog_releases SET name = $2, description = $3, updated_at = now(), version = version + 1 WHERE id = $1`, [id, name, p.description === undefined ? cur.description : p.description.trim() || null]);
  await audit(q, actor, 'catalog_release', id, 'RELEASE_UPDATED', { name });
  return getRelease(q, id);
}

/** Throws the release away (its changes stay for the record, but nothing is live and its nodes are free for other releases). */
export async function cancelRelease(q: Queryable, actor: string, id: string): Promise<Release> {
  const cur = await getRelease(q, id, true);
  if (!OPEN_RELEASE_STATES.includes(cur.status)) throw conflict(`${cur.number} is ${cur.status.toLowerCase().replace('_', ' ')} and cannot be cancelled.`);
  await q.query(`UPDATE catalog_releases SET status = 'CANCELLED', publish_at = NULL, publish_error = NULL, updated_at = now(), version = version + 1 WHERE id = $1`, [id]);
  await q.query('DELETE FROM catalog_release_nodes WHERE release_id = $1', [id]);
  await audit(q, actor, 'catalog_release', id, 'RELEASE_CANCELLED', { number: cur.number });
  return getRelease(q, id);
}

export async function listChanges(q: Queryable, releaseId: string): Promise<ReleaseChange[]> {
  return (await q.query('SELECT * FROM catalog_release_changes WHERE release_id = $1 ORDER BY seq', [releaseId])).rows.map(toChange);
}
/** The ids of the nodes a release touches (at most RELEASE_MAX_CHANGES), for badges on the catalog. */
export async function releaseNodeIds(q: Queryable, releaseId: string): Promise<string[]> {
  return (await q.query('SELECT node_id FROM catalog_release_nodes WHERE release_id = $1 ORDER BY node_id LIMIT $2', [releaseId, RELEASE_MAX_CHANGES])).rows.map((r) => r.nodeId as string);
}

// ───────────────────────── staging ─────────────────────────
export interface StageInput { op: ReleaseOp; nodeId: string; payload?: Record<string, any>; note?: string; groupKey?: string }
const STATUSES = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'RETIRED'];

function checkPayload(c: StageInput): Record<string, any> {
  const p = c.payload ?? {};
  switch (c.op) {
    case 'CREATE': if (!p.input || typeof p.input !== 'object' || p.input.id !== c.nodeId) throw invalid('A create needs the node to create, with the id of the change.'); return p;
    case 'UPDATE': if (!p.patch || typeof p.patch !== 'object' || !Object.keys(p.patch).length) throw invalid('An update needs at least one field to change.'); return p;
    case 'MOVE': if (!('parentId' in p) || (p.parentId !== null && typeof p.parentId !== 'string')) throw invalid('A move needs the new parent.'); return p;
    case 'STATUS':
      if (!STATUSES.includes(p.status)) throw invalid(`A status change needs one of ${STATUSES.join(', ')}.`);
      if (p.status === 'SCHEDULED' && !p.activeFrom) throw invalid('A scheduled status needs the go-live date.');
      return { status: p.status, ...(p.activeFrom ? { activeFrom: p.activeFrom } : {}) };
    case 'DELETE': return {};
    case 'COPY_LINE_ITEMS': if (typeof p.fromId !== 'string' || !p.fromId) throw invalid('Say which offer to copy the line items from.'); return { fromId: p.fromId };
    default: throw invalid(`unknown change ${String(c.op)}`);
  }
}

/** Adds one change to a draft release. The node is claimed for the release, and remembered at the version it has now so a later live edit shows up as a conflict. */
export async function stageChange(q: Queryable, actor: string, releaseId: string, c: StageInput): Promise<ReleaseChange> {
  const rel = await getRelease(q, releaseId, true);
  if (!EDITABLE.includes(rel.status)) throw conflict(`${rel.number} is ${rel.status.toLowerCase().replace('_', ' ')}: changes can only be added to a draft release.`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(c.nodeId ?? '')) throw invalid('node id must be lowercase letters, digits and dashes');
  const payload = checkPayload(c);
  const existing = (await q.query('SELECT op, base_version FROM catalog_release_changes WHERE release_id = $1 AND node_id = $2 ORDER BY seq', [releaseId, c.nodeId])).rows;
  const createdHere = existing.some((r) => r.op === 'CREATE');
  const live = (await q.query('SELECT version FROM catalog_nodes WHERE id = $1', [c.nodeId])).rows[0];
  if (c.op === 'CREATE') {
    if (live) throw conflict(`${c.nodeId} already exists in the catalog.`);
    if (createdHere) throw conflict(`${c.nodeId} is already created in this release.`);
  } else if (!live && !createdHere) throw notFound('catalog node', c.nodeId);
  if (c.op === 'COPY_LINE_ITEMS') {
    const src = (await q.query('SELECT 1 FROM catalog_nodes WHERE id = $1', [payload.fromId])).rows[0] ?? (await q.query(`SELECT 1 FROM catalog_release_changes WHERE release_id = $1 AND node_id = $2 AND op = 'CREATE'`, [releaseId, payload.fromId])).rows[0];
    if (!src) throw notFound('catalog node', payload.fromId);
  }
  const total = Number((await q.query('SELECT count(*) AS n FROM catalog_release_changes WHERE release_id = $1', [releaseId])).rows[0]!.n);
  if (total >= RELEASE_MAX_CHANGES) throw invalid(`A release holds at most ${RELEASE_MAX_CHANGES} changes. Publish this one and start another.`);
  const claimed = await q.query('INSERT INTO catalog_release_nodes (node_id, release_id) VALUES ($1, $2) ON CONFLICT (node_id) DO NOTHING RETURNING node_id', [c.nodeId, releaseId]);
  if (!claimed.rows.length) {
    const other = (await q.query('SELECT n.release_id, r.number FROM catalog_release_nodes n JOIN catalog_releases r ON r.id = n.release_id WHERE n.node_id = $1', [c.nodeId])).rows[0];
    if (other && other.releaseId !== releaseId) throw conflict(`${c.nodeId} is already in ${other.number}. A node can be in one open release at a time.`);
  }
  const base = c.op === 'CREATE' ? null : (existing.find((r) => r.baseVersion !== null)?.baseVersion ?? (live ? live.version : null));
  const seq = Number((await q.query('SELECT COALESCE(max(seq), 0) + 1 AS n FROM catalog_release_changes WHERE release_id = $1', [releaseId])).rows[0]!.n);
  const row = (await q.query(
    `INSERT INTO catalog_release_changes (release_id, seq, op, node_id, payload, base_version, group_key, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [releaseId, seq, c.op, c.nodeId, JSON.stringify(payload), base, c.groupKey ?? null, c.note?.slice(0, 300) ?? null, actor])).rows[0]!;
  await q.query('UPDATE catalog_releases SET updated_at = now(), version = version + 1 WHERE id = $1', [releaseId]);
  return toChange(row);
}

export async function removeChange(q: Queryable, actor: string, releaseId: string, changeId: number): Promise<void> {
  const rel = await getRelease(q, releaseId, true);
  if (!EDITABLE.includes(rel.status)) throw conflict(`${rel.number} is ${rel.status.toLowerCase().replace('_', ' ')}: only a draft release can be changed.`);
  const gone = (await q.query('DELETE FROM catalog_release_changes WHERE id = $1 AND release_id = $2 RETURNING node_id, op', [changeId, releaseId])).rows[0];
  if (!gone) throw notFound('change', String(changeId));
  const left = (await q.query('SELECT 1 FROM catalog_release_changes WHERE release_id = $1 AND node_id = $2 LIMIT 1', [releaseId, gone.nodeId])).rows[0];
  if (!left) await q.query('DELETE FROM catalog_release_nodes WHERE node_id = $1 AND release_id = $2', [gone.nodeId, releaseId]);
  await q.query('UPDATE catalog_releases SET updated_at = now(), version = version + 1 WHERE id = $1', [releaseId]);
  await audit(q, actor, 'catalog_release', releaseId, 'RELEASE_CHANGE_REMOVED', { node: gone.nodeId, op: gone.op });
}

// ───────────────────────── applying ─────────────────────────
/** One change, through the catalog function it stands for. The only place a release writes to the catalog. */
export async function applyChange(q: Queryable, c: Pick<ReleaseChange, 'op' | 'nodeId' | 'payload'>, actor: string): Promise<void> {
  const p = c.payload ?? {};
  switch (c.op) {
    case 'CREATE': await createNode(q, structuredClone(p.input) as NodeInput, actor); return;
    case 'UPDATE': await updateNode(q, c.nodeId, structuredClone(p.patch) as NodePatch, actor); return;
    case 'MOVE': await moveNode(q, c.nodeId, p.parentId ?? null, actor); return;
    case 'STATUS': await setStatus(q, c.nodeId, p.status, actor, p.activeFrom); return;
    case 'DELETE': await deleteNode(q, c.nodeId, actor); return;
    case 'COPY_LINE_ITEMS': await copyLineItems(q, p.fromId, c.nodeId, actor); return;
  }
}

// ───────────────────────── before and after ─────────────────────────
interface Snap { node: any; lineItems: any[] }
/** The state of a set of nodes (with the line items of the offers among them) as it is right now in this transaction; absent nodes are null. */
async function snapshot(q: Queryable, ids: string[]): Promise<Map<string, Snap | null>> {
  const out = new Map<string, Snap | null>(ids.map((i) => [i, null]));
  if (!ids.length) return out;
  const nodes = (await q.query('SELECT * FROM catalog_nodes WHERE id = ANY($1::text[])', [ids])).rows.map(toNode);
  const offers = nodes.filter((n) => n.level === 'OFFER').map((n) => n.id);
  const items = offers.length ? (await q.query(`SELECT * FROM catalog_nodes WHERE parent_id = ANY($1::text[]) AND level = 'LINE_ITEM' ORDER BY sort_order, name, id`, [offers])).rows.map(toNode) : [];
  for (const n of nodes) out.set(n.id, { node: n, lineItems: items.filter((i) => i.parentId === n.id) });
  return out;
}

/** The nodes a diff is about: the ones the changes name, with a line item stood for by its offer. */
async function subjectIds(q: Queryable, changes: Array<Pick<ReleaseChange, 'op' | 'nodeId' | 'payload'>>): Promise<string[]> {
  const ids = new Set<string>();
  const unknown: string[] = [];
  for (const c of changes) {
    if (c.op === 'CREATE' && c.payload?.input?.level === 'LINE_ITEM') { if (c.payload.input.parentId) ids.add(c.payload.input.parentId); continue; }
    ids.add(c.nodeId);
    if (c.op !== 'CREATE') unknown.push(c.nodeId);
  }
  const items = unknown.length ? (await q.query(`SELECT id, parent_id FROM catalog_nodes WHERE id = ANY($1::text[]) AND level = 'LINE_ITEM'`, [unknown])).rows : [];
  for (const r of items) { ids.delete(r.id as string); if (r.parentId) ids.add(r.parentId as string); }
  return [...ids];
}

export interface DiffField { field: string; before: unknown; after: unknown }
export interface DiffLineItem { id: string; name: string; summary: string }
export interface DiffNode {
  id: string; name: string; level: string; kind: 'ADDED' | 'CHANGED' | 'DELETED' | 'UNCHANGED'; groupKey: string | null;
  fields: DiffField[]; lineItems: { added: DiffLineItem[]; removed: DiffLineItem[]; changed: Array<DiffLineItem & { fields: DiffField[] }> };
  repriced: boolean; retired: boolean; madeLive: boolean; moved: boolean;
}
export interface ReleaseSummary { changes: number; added: number; changed: number; retired: number; repriced: number; moved: number; madeLive: number; deleted: number; lineItems: number; errors: number }

const FIELDS = ['name', 'description', 'status', 'activeFrom', 'parentId', 'kind', 'prices', 'contract', 'fulfilment', 'requires', 'excludes', 'salesChannels', 'markets', 'partnerCode', 'validityDays', 'characteristics', 'variants', 'deals', 'group', 'suspension', 'ocs'];
const ITEM_FIELDS = ['name', 'description', 'itemType', 'quantity', 'unit', 'unlimited', 'sku', 'status'];
const norm = (field: string, v: any) => (field === 'prices' ? withoutPriceIds(v) : v === undefined || v === '' ? null : Array.isArray(v) && !v.length ? null : v);
const fieldsOf = (before: any, after: any, names: string[]): DiffField[] => names.flatMap((f) => (sameValue(norm(f, before?.[f]), norm(f, after?.[f])) ? [] : [{ field: f, before: before?.[f] ?? null, after: after?.[f] ?? null }]));
const itemSummary = (i: any) => [i.name, i.unlimited ? 'unlimited' : i.quantity ? `${i.quantity}${i.unit ? ` ${i.unit}` : ''}` : '', i.status !== 'ACTIVE' ? String(i.status).toLowerCase() : ''].filter(Boolean).join(' · ');

function diffNodes(before: Map<string, Snap | null>, after: Map<string, Snap | null>, groupOf: Map<string, string>): DiffNode[] {
  const out: DiffNode[] = [];
  for (const [id, b] of before) {
    const a = after.get(id) ?? null;
    if (!a && !b) continue;                       // a node that was never created (its create was refused)
    const node = (a ?? b)!.node;
    const items = { added: [] as DiffLineItem[], removed: [] as DiffLineItem[], changed: [] as Array<DiffLineItem & { fields: DiffField[] }> };
    const bi = new Map((b?.lineItems ?? []).map((i) => [i.id, i])), ai = new Map((a?.lineItems ?? []).map((i) => [i.id, i]));
    for (const [iid, i] of ai) { if (!bi.has(iid)) items.added.push({ id: iid, name: i.name, summary: itemSummary(i) }); else { const f = fieldsOf(bi.get(iid), i, ITEM_FIELDS); if (f.length) items.changed.push({ id: iid, name: i.name, summary: itemSummary(i), fields: f }); } }
    for (const [iid, i] of bi) if (!ai.has(iid)) items.removed.push({ id: iid, name: i.name, summary: itemSummary(i) });
    const fields = !b ? fieldsOf({}, a!.node, FIELDS).filter((f) => f.after !== null) : !a ? fieldsOf(b.node, {}, FIELDS).filter((f) => f.before !== null) : fieldsOf(b.node, a.node, FIELDS);
    const itemChanges = items.added.length + items.removed.length + items.changed.length;
    const kind = !b ? 'ADDED' : !a ? 'DELETED' : fields.length || itemChanges ? 'CHANGED' : 'UNCHANGED';
    const has = (f: string) => fields.some((x) => x.field === f);
    out.push({
      id, name: node.name, level: node.level, kind, groupKey: groupOf.get(id) ?? null, fields, lineItems: items,
      repriced: !!b && !!a && has('prices'), retired: !!b && !!a && b.node.status !== 'RETIRED' && a.node.status === 'RETIRED',
      madeLive: !!a && a.node.status === 'ACTIVE' && (!b || b.node.status !== 'ACTIVE'), moved: !!b && !!a && has('parentId'),
    });
  }
  return out.filter((n) => n.kind !== 'UNCHANGED').sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind < y.kind ? -1 : 1));
}

function summarise(nodes: DiffNode[], changes: number, errors: number): ReleaseSummary {
  const reprice = (n: DiffNode) => !!n.groupKey?.startsWith('reprice:');
  const groups = new Set(nodes.filter(reprice).map((n) => n.groupKey));
  return {
    changes, errors,
    added: nodes.filter((n) => n.kind === 'ADDED' && !reprice(n)).length,
    deleted: nodes.filter((n) => n.kind === 'DELETED').length,
    retired: nodes.filter((n) => n.retired && !reprice(n)).length,
    repriced: nodes.filter((n) => n.repriced && !reprice(n)).length + groups.size,
    moved: nodes.filter((n) => n.moved).length,
    madeLive: nodes.filter((n) => n.madeLive && n.kind !== 'ADDED' && !reprice(n)).length,
    changed: nodes.filter((n) => n.kind === 'CHANGED' && n.fields.some((f) => !['prices', 'status', 'activeFrom', 'parentId'].includes(f.field))).length,
    lineItems: nodes.reduce((n, x) => n + x.lineItems.added.length + x.lineItems.removed.length + x.lineItems.changed.length, 0),
  };
}

// ───────────────────────── conflicts ─────────────────────────
export interface ReleaseConflict { nodeId: string; name: string | null; kind: 'CHANGED_LIVE' | 'DELETED_LIVE' | 'EXISTS_LIVE'; baseVersion: number | null; liveVersion: number | null; lastBy: string | null; lastAt: string | null }
/** Nodes that changed live after they were staged (their version moved), were deleted, or that a release means to create but now exist. These block publishing. */
export async function releaseConflicts(q: Queryable, releaseId: string, changes?: ReleaseChange[]): Promise<ReleaseConflict[]> {
  const list = changes ?? (await listChanges(q, releaseId));
  const base = new Map<string, number>();
  for (const c of list) if (c.op !== 'CREATE' && c.baseVersion !== null && !base.has(c.nodeId)) base.set(c.nodeId, c.baseVersion);
  const creates = [...new Set(list.filter((c) => c.op === 'CREATE').map((c) => c.nodeId))];
  const ids = [...base.keys(), ...creates];
  if (!ids.length) return [];
  const live = new Map((await q.query('SELECT id, name, version FROM catalog_nodes WHERE id = ANY($1::text[])', [ids])).rows.map((r) => [r.id as string, r]));
  const last = new Map((await q.query(`SELECT DISTINCT ON (entity_id) entity_id, actor, at FROM audit_log WHERE entity = 'catalog' AND entity_id = ANY($1::text[]) ORDER BY entity_id, id DESC`, [ids])).rows.map((r) => [r.entityId as string, r]));
  const out: ReleaseConflict[] = [];
  const mk = (nodeId: string, kind: ReleaseConflict['kind'], baseVersion: number | null) => ({ nodeId, kind, name: (live.get(nodeId)?.name as string) ?? null, baseVersion, liveVersion: live.get(nodeId)?.version ?? null, lastBy: (last.get(nodeId)?.actor as string) ?? null, lastAt: iso(last.get(nodeId)?.at) });
  for (const [nodeId, v] of base) { const l = live.get(nodeId); if (!l) out.push(mk(nodeId, 'DELETED_LIVE', v)); else if (l.version !== v) out.push(mk(nodeId, 'CHANGED_LIVE', v)); }
  for (const nodeId of creates) if (live.has(nodeId)) out.push(mk(nodeId, 'EXISTS_LIVE', null));
  return out;
}

/** Accepts the live version of a node: its changes in the release are now checked against what it is today. */
export async function rebaseNode(q: Queryable, actor: string, releaseId: string, nodeId: string): Promise<Release> {
  const rel = await getRelease(q, releaseId, true);
  if (!EDITABLE.includes(rel.status)) throw conflict(`${rel.number} is ${rel.status.toLowerCase().replace('_', ' ')}: only a draft release can be changed.`);
  const live = (await q.query('SELECT version FROM catalog_nodes WHERE id = $1', [nodeId])).rows[0];
  if (!live) throw conflict(`${nodeId} no longer exists in the catalog, so its changes cannot be accepted: remove them from the release.`);
  const r = await q.query(`UPDATE catalog_release_changes SET base_version = $3 WHERE release_id = $1 AND node_id = $2 AND op <> 'CREATE'`, [releaseId, nodeId, live.version]);
  if (!r.rowCount) throw notFound('change for node', nodeId);
  await audit(q, actor, 'catalog_release', releaseId, 'RELEASE_CONFLICT_ACCEPTED', { node: nodeId, version: live.version });
  return getRelease(q, releaseId);
}

// ───────────────────────── preview ─────────────────────────
export interface ChangeResult { id: number; seq: number; op: ReleaseOp; nodeId: string; ok: boolean; error?: string }
export interface ReleasePreview {
  release: Release; changes: ReleaseChange[]; results: ChangeResult[]; summary: ReleaseSummary; nodes: DiffNode[]; groups: Array<{ key: string; oldId: string; newId: string }>; conflicts: ReleaseConflict[];
  /** The release has changes, every change would be accepted and nothing moved underneath it: it can be sent for review. */
  ready: boolean;
  /** Ready, and approved: it can be published. */
  canPublish: boolean;
}

const groupsOf = (changes: ReleaseChange[]) => {
  const byNode = new Map<string, string>();
  const groups = new Map<string, { key: string; oldId: string; newId: string }>();
  for (const c of changes) {
    if (!c.groupKey) continue;
    byNode.set(c.nodeId, c.groupKey);
    if (c.groupKey.startsWith('reprice:')) { const g = groups.get(c.groupKey) ?? { key: c.groupKey, oldId: c.groupKey.slice(8), newId: '' }; if (c.op === 'CREATE' && c.payload?.input?.level === 'OFFER') g.newId = c.nodeId; groups.set(c.groupKey, g); }
  }
  return { byNode, groups: [...groups.values()] };
};

/**
 * What publishing would do, without doing it: every change is applied in order inside a transaction that is rolled back, one savepoint per change so a refusal is reported
 * on its own change (later changes that depended on it will report theirs). The diff compares the nodes before and after.
 */
export async function previewRelease(db: Db, releaseId: string): Promise<ReleasePreview> {
  const release = await getRelease(db, releaseId);
  const changes = await listChanges(db, releaseId);
  const conflicts = OPEN_RELEASE_STATES.includes(release.status) ? await releaseConflicts(db, releaseId, changes) : [];
  const { byNode, groups } = groupsOf(changes);
  if (release.status === 'PUBLISHED' && release.result?.diff) {
    return { release, changes, results: changes.map((c) => ({ id: c.id, seq: c.seq, op: c.op, nodeId: c.nodeId, ok: true })), summary: release.result.summary, nodes: release.result.diff, groups, conflicts: [], ready: false, canPublish: false };
  }
  const ran = await withRollback(db, async (q) => {
    const ids = await subjectIds(q, changes);
    const before = await snapshot(q, ids);
    const results: ChangeResult[] = [];
    for (const [i, c] of changes.entries()) {
      const sp = `rel${i}`;
      await q.query(`SAVEPOINT ${sp}`);
      try { await applyChange(q, c, 'release-preview'); await q.query(`RELEASE SAVEPOINT ${sp}`); results.push({ id: c.id, seq: c.seq, op: c.op, nodeId: c.nodeId, ok: true }); }
      catch (e) { await q.query(`ROLLBACK TO SAVEPOINT ${sp}`); results.push({ id: c.id, seq: c.seq, op: c.op, nodeId: c.nodeId, ok: false, error: failureText(e) }); }
    }
    return { before, after: await snapshot(q, ids), results };
  });
  const nodes = diffNodes(ran.before, ran.after, byNode);
  const errors = ran.results.filter((r) => !r.ok).length;
  const ready = OPEN_RELEASE_STATES.includes(release.status) && changes.length > 0 && !errors && !conflicts.length;
  return { release, changes, results: ran.results, summary: summarise(nodes, changes.length, errors), nodes, groups, conflicts, ready, canPublish: ready && PUBLISHABLE.includes(release.status) };
}

/**
 * Reads something as the release would leave the catalog: its changes are applied in a transaction that is rolled back (a change that fails is skipped), and `read` runs in it.
 * The offer form uses this to start from the staged state of an offer, the catalog screen to show what a release does to a group.
 */
export async function inReleaseState<T>(db: Db, releaseId: string, read: (q: Queryable) => Promise<T>): Promise<T> {
  const changes = await listChanges(db, releaseId);
  return withRollback(db, async (q) => {
    for (const [i, c] of changes.entries()) {
      await q.query(`SAVEPOINT s${i}`);
      try { await applyChange(q, c, 'release-preview'); await q.query(`RELEASE SAVEPOINT s${i}`); } catch { await q.query(`ROLLBACK TO SAVEPOINT s${i}`); }
    }
    return read(q);
  });
}

/** A node as the release would leave it (for the offer form to start from). Null when the release deletes it or it does not exist. */
export async function nodeInRelease(db: Db, releaseId: string, nodeId: string): Promise<{ node: any; lineItems: any[] } | null> {
  return inReleaseState(db, releaseId, async (q) => (await snapshot(q, [nodeId])).get(nodeId) ?? null);
}

// ───────────────────────── publishing ─────────────────────────
/**
 * Publishes a release: all its changes, in order, in one transaction. A change the catalog refuses, or a conflict, stops everything and nothing is applied. One audit entry for the
 * release is written besides the per-node entries the catalog functions write; the state of every touched node before publishing is kept in `result` for a reverse release.
 */
export async function publishRelease(db: Db, id: string, actor: string, o: { scheduled?: boolean } = {}): Promise<Release> {
  return db.tx(async (q) => {
    const rel = await getRelease(q, id, true);
    if (!PUBLISHABLE.includes(rel.status)) throw conflict(`${rel.number} is ${rel.status.toLowerCase().replace('_', ' ')} and cannot be published.`);
    const changes = await listChanges(q, id);
    if (!changes.length) throw invalid('The release has no changes.');
    const conflicts = await releaseConflicts(q, id, changes);
    if (conflicts.length) throw conflict(`${conflicts.length} node${conflicts.length === 1 ? '' : 's'} changed in the live catalog since being staged (${conflicts.slice(0, 5).map((c) => c.nodeId).join(', ')}). Review ${conflicts.length === 1 ? 'it' : 'them'} in the release and accept or remove the change.`);
    const ids = await subjectIds(q, changes);
    const before = await snapshot(q, ids);
    for (const c of changes) {
      try { await applyChange(q, c, actor); }
      catch (e) { throw new DomainError('REJECTED', `Change ${c.seq} (${c.op} ${c.nodeId}) was refused, so nothing was published: ${failureText(e)}`, { seq: c.seq, op: c.op, nodeId: c.nodeId }); }
    }
    const after = await snapshot(q, ids);
    const nodes = diffNodes(before, after, groupsOf(changes).byNode);
    const summary = summarise(nodes, changes.length, 0);
    const beforeJson: Record<string, unknown> = {}; const itemsBefore: Record<string, string[]> = {};
    for (const [nid, s] of before) { beforeJson[nid] = s ? s.node : null; if (s?.node.level === 'OFFER') itemsBefore[nid] = s.lineItems.map((i) => i.id); }
    await q.query(`UPDATE catalog_releases SET status = 'PUBLISHED', published_by = $2, published_at = now(), publish_error = NULL, updated_at = now(), version = version + 1, result = $3 WHERE id = $1`,
      [id, actor, JSON.stringify({ summary, diff: nodes, before: beforeJson, lineItemsBefore: itemsBefore, scheduled: !!o.scheduled })]);
    await q.query('DELETE FROM catalog_release_nodes WHERE release_id = $1', [id]);
    await audit(q, actor, 'catalog_release', id, 'RELEASE_PUBLISHED', { number: rel.number, name: rel.name, changes: changes.length, summary, scheduled: !!o.scheduled });
    await note(q, id, actor, 'PUBLISH', o.scheduled ? 'Published at its scheduled time.' : '');
    await releaseEvent(q, 'RELEASE_PUBLISHED', await getRelease(q, id), actor, { summary });
    return getRelease(q, id);
  });
}

/** Sets (or, with null, clears) the time a release is published by the sweep. */
export async function scheduleRelease(q: Queryable, actor: string, id: string, publishAt: string | null): Promise<Release> {
  const rel = await getRelease(q, id, true);
  if (!PUBLISHABLE.includes(rel.status)) throw conflict(`${rel.number} is ${rel.status.toLowerCase().replace('_', ' ')} and cannot be scheduled.`);
  let when: Date | null = null;
  if (publishAt !== null) {
    when = new Date(publishAt);
    if (Number.isNaN(when.getTime())) throw invalid('publishAt is a date and time (ISO 8601).');
    if (when.getTime() <= Date.now()) throw invalid('Choose a time in the future, or publish now.');
  }
  await q.query('UPDATE catalog_releases SET publish_at = $2, publish_error = NULL, updated_at = now(), version = version + 1 WHERE id = $1', [id, when]);
  await audit(q, actor, 'catalog_release', id, when ? 'RELEASE_SCHEDULED' : 'RELEASE_UNSCHEDULED', { number: rel.number, publishAt: when?.toISOString() ?? null });
  return getRelease(q, id);
}

/** Publishes the releases whose time has come. Called by the sweep that also activates scheduled offers; safe on several servers at once (the release row is locked and its state checked). */
export async function publishDueReleases(db: Db, o: { limit?: number } = {}): Promise<{ published: number; failed: number }> {
  const due = (await db.query(`SELECT id FROM catalog_releases WHERE status = 'APPROVED' AND publish_at <= now() AND publish_error IS NULL ORDER BY publish_at, id LIMIT $1`, [o.limit ?? 5])).rows;
  let published = 0, failed = 0;
  for (const r of due) {
    try { await publishRelease(db, r.id as string, 'scheduler', { scheduled: true }); published++; }
    catch (e) {
      const msg = failureText(e).slice(0, 500);
      const upd = await db.query(`UPDATE catalog_releases SET publish_error = $2, updated_at = now() WHERE id = $1 AND status = 'APPROVED' AND publish_error IS NULL`, [r.id, msg]);
      if (upd.rowCount) { failed++; await audit(db, 'scheduler', 'catalog_release', r.id as string, 'RELEASE_SCHEDULE_FAILED', { error: msg }); }
    }
  }
  return { published, failed };
}

// ───────────────────────── review: submit, approve, reject, reopen, comment ─────────────────────────
// A release moves DRAFT -> IN_REVIEW -> APPROVED -> PUBLISHED. Someone with release:submit sends a draft for review; someone with release:approve approves it or asks for changes (REJECTED),
// and that someone can never be the person who started the release or made a change in it; someone with release:publish publishes an approved release (now or scheduled). An approved,
// rejected or in-review release is not editable: to change it, it goes back to DRAFT (and has to be approved again). Every step is in the audit log and in the release's comments.
export type CommentKind = 'COMMENT' | 'SUBMIT' | 'APPROVE' | 'REJECT' | 'REOPEN' | 'PUBLISH';
export interface ReleaseComment { id: number; releaseId: string; author: string; kind: CommentKind; body: string; createdAt: string }
const toComment = (r: Row): ReleaseComment => ({ id: Number(r.id), releaseId: r.releaseId, author: r.author, kind: r.kind, body: r.body ?? '', createdAt: iso(r.createdAt)! });
const note = (q: Queryable, id: string, author: string, kind: CommentKind, body = '') => q.query('INSERT INTO catalog_release_comments (release_id, author, kind, body) VALUES ($1, $2, $3, $4)', [id, author, kind, body.slice(0, 2000)]);
const words = (s: string) => s.toLowerCase().replace('_', ' ');

export async function listReleaseComments(q: Queryable, releaseId: string): Promise<ReleaseComment[]> {
  return (await q.query('SELECT * FROM catalog_release_comments WHERE release_id = $1 ORDER BY id LIMIT 500', [releaseId])).rows.map(toComment);
}
export async function addReleaseComment(q: Queryable, actor: string, releaseId: string, body: string): Promise<ReleaseComment> {
  const text = (body ?? '').trim();
  if (!text) throw invalid('Write the comment.');
  if (text.length > 2000) throw invalid('A comment is up to 2000 characters.');
  await getRelease(q, releaseId);
  const r = (await q.query(`INSERT INTO catalog_release_comments (release_id, author, kind, body) VALUES ($1, $2, 'COMMENT', $3) RETURNING *`, [releaseId, actor, text])).rows[0]!;
  await audit(q, actor, 'catalog_release', releaseId, 'RELEASE_COMMENTED', {});
  return toComment(r);
}

/** Why this person may not approve or reject the release (they started it or made a change in it), or null when they may. The rule that makes the review a second pair of eyes. */
export function approverBlocker(release: Pick<Release, 'createdBy'>, changes: Array<Pick<ReleaseChange, 'createdBy'>>, actor: string): string | null {
  if (actor === release.createdBy) return 'You started this release, so someone else has to review it.';
  if (changes.some((c) => c.createdBy === actor)) return 'You made changes in this release, so someone else has to review it.';
  return null;
}

async function releaseEvent(q: Queryable, type: 'RELEASE_SUBMITTED' | 'RELEASE_APPROVED' | 'RELEASE_REJECTED' | 'RELEASE_PUBLISHED', rel: Release, by: string, extra: Record<string, unknown> = {}) {
  await raiseEvent(q, type, { resourceId: rel.id, payload: { number: rel.number, name: rel.name, lifecycleStatus: rel.status, changeCount: rel.changeCount ?? 0, by, ...extra } }, { onlyIfWanted: true });
}
const problems = (p: ReleasePreview) => [p.summary.errors ? `${p.summary.errors} change${p.summary.errors === 1 ? '' : 's'} would be refused` : '', p.conflicts.length ? `${p.conflicts.length} node${p.conflicts.length === 1 ? '' : 's'} changed in the live catalog since being staged` : ''].filter(Boolean).join(' and ');

/** Sends a draft for review. It must have changes that would all be accepted and nothing that moved underneath it, so a reviewer is never asked to look at something that cannot be published. */
export async function submitRelease(db: Db, actor: string, id: string, noteText = ''): Promise<Release> {
  const pv = await previewRelease(db, id);
  if (pv.release.status !== 'DRAFT') throw conflict(`${pv.release.number} is ${words(pv.release.status)}: only a draft can be sent for review.`);
  if (!pv.changes.length) throw invalid('The release has no changes.');
  if (!pv.ready) throw invalid(`The release cannot be sent for review yet: ${problems(pv)}. Fix it on the review page first.`);
  return db.tx(async (q) => {
    const rel = await getRelease(q, id, true);
    if (rel.status !== 'DRAFT') throw conflict(`${rel.number} is ${words(rel.status)}: only a draft can be sent for review.`);
    await q.query(`UPDATE catalog_releases SET status = 'IN_REVIEW', submitted_by = $2, submitted_at = now(), decided_by = NULL, decided_at = NULL, publish_at = NULL, publish_error = NULL, updated_at = now(), version = version + 1 WHERE id = $1`, [id, actor]);
    await note(q, id, actor, 'SUBMIT', noteText);
    await audit(q, actor, 'catalog_release', id, 'RELEASE_SUBMITTED', { number: rel.number, changes: pv.changes.length, summary: pv.summary });
    const out = await getRelease(q, id);
    await releaseEvent(q, 'RELEASE_SUBMITTED', out, actor, { summary: pv.summary });
    return out;
  });
}

/** Approves a release in review. Not by anyone who started it or changed anything in it; and only if it still would apply cleanly. */
export async function approveRelease(db: Db, actor: string, id: string, noteText = ''): Promise<Release> {
  const pv = await previewRelease(db, id);
  if (pv.release.status !== 'IN_REVIEW') throw conflict(`${pv.release.number} is ${words(pv.release.status)}: only a release in review can be approved.`);
  const blocked = approverBlocker(pv.release, pv.changes, actor);
  if (blocked) throw forbidden(blocked);
  if (!pv.ready) throw invalid(`The release cannot be approved as it stands: ${problems(pv)}. Ask for changes.`);
  return db.tx(async (q) => {
    const rel = await getRelease(q, id, true);
    if (rel.status !== 'IN_REVIEW') throw conflict(`${rel.number} is ${words(rel.status)}: only a release in review can be approved.`);
    await q.query(`UPDATE catalog_releases SET status = 'APPROVED', decided_by = $2, decided_at = now(), updated_at = now(), version = version + 1 WHERE id = $1`, [id, actor]);
    await note(q, id, actor, 'APPROVE', noteText);
    await audit(q, actor, 'catalog_release', id, 'RELEASE_APPROVED', { number: rel.number, submittedBy: rel.submittedBy });
    const out = await getRelease(q, id);
    await releaseEvent(q, 'RELEASE_APPROVED', out, actor);
    return out;
  });
}

/** Sends a release in review back with the reason. It becomes REJECTED, the author can reopen it, change it and send it again. */
export async function rejectRelease(db: Db, actor: string, id: string, reason: string): Promise<Release> {
  const why = (reason ?? '').trim();
  if (!why) throw invalid('Say what needs to change.');
  const rel0 = await getRelease(db, id);
  if (rel0.status !== 'IN_REVIEW') throw conflict(`${rel0.number} is ${words(rel0.status)}: only a release in review can be sent back.`);
  const blocked = approverBlocker(rel0, await listChanges(db, id), actor);
  if (blocked) throw forbidden(blocked);
  return db.tx(async (q) => {
    const rel = await getRelease(q, id, true);
    if (rel.status !== 'IN_REVIEW') throw conflict(`${rel.number} is ${words(rel.status)}: only a release in review can be sent back.`);
    await q.query(`UPDATE catalog_releases SET status = 'REJECTED', decided_by = $2, decided_at = now(), publish_at = NULL, publish_error = NULL, updated_at = now(), version = version + 1 WHERE id = $1`, [id, actor]);
    await note(q, id, actor, 'REJECT', why);
    await audit(q, actor, 'catalog_release', id, 'RELEASE_REJECTED', { number: rel.number, reason: why.slice(0, 300) });
    const out = await getRelease(q, id);
    await releaseEvent(q, 'RELEASE_REJECTED', out, actor, { reason: why.slice(0, 300) });
    return out;
  });
}

/** Takes a release back to a draft so it can be changed: the author withdrawing it from review, changing a rejected one, or anyone taking approval back (for example to resolve a conflict). It has to be approved again. */
export async function reopenRelease(q: Queryable, actor: string, id: string, noteText = ''): Promise<Release> {
  const rel = await getRelease(q, id, true);
  if (!['IN_REVIEW', 'APPROVED', 'REJECTED'].includes(rel.status)) throw conflict(`${rel.number} is ${words(rel.status)} and cannot be reopened.`);
  await q.query(`UPDATE catalog_releases SET status = 'DRAFT', submitted_by = NULL, submitted_at = NULL, decided_by = NULL, decided_at = NULL, publish_at = NULL, publish_error = NULL, updated_at = now(), version = version + 1 WHERE id = $1`, [id]);
  await note(q, id, actor, 'REOPEN', noteText);
  await audit(q, actor, 'catalog_release', id, 'RELEASE_REOPENED', { number: rel.number, was: rel.status });
  return getRelease(q, id);
}

// ───────────────────────── a new version instead of repricing a sold offer ─────────────────────────
const FIRST_FREE = async (q: Queryable, releaseId: string, base: string): Promise<string> => {
  for (let n = 2; n < 100; n++) {
    const id = `${base}-v${n}`.slice(0, 60);
    const taken = (await q.query('SELECT 1 FROM catalog_nodes WHERE id = $1', [id])).rows[0] ?? (await q.query('SELECT 1 FROM catalog_release_changes WHERE node_id = $1 AND op = $2', [id, 'CREATE'])).rows[0];
    if (!taken) return id;
  }
  throw invalid('Too many versions of this offer already exist.');
};
const swap = (list: string[] | undefined, from: string, to: string) => (list ?? []).map((x) => (x === from ? to : x));

/**
 * A sold offer cannot be repriced in place (existing subscribers would be repriced). This stages the way it is done instead, as one idea (group `reprice:<offer>`): a new offer
 * with the same terms and the new prices, the old offer's line items copied to it, the new one made live and the old one retired together when the release publishes, and
 * (unless told not to) the offers that required, excluded or listed the old one as a group-plan member pointed at the new one. Subscribers on the old offer stay on it.
 */
export async function stageReprice(q: Queryable, actor: string, releaseId: string, i: { offerId: string; prices: PriceComponent[]; newId?: string; name?: string; repointDependents?: boolean }): Promise<{ newId: string; dependents: string[]; changes: ReleaseChange[] }> {
  const old = await getOffer(q, i.offerId);
  if (old.level !== 'OFFER') throw invalid(`${i.offerId} is not an offer.`);
  const u = await nodeUsage(q, i.offerId);
  if (u.services + u.orders === 0) throw invalid(`${old.name} has never been sold, so its prices can be changed directly: stage an update instead.`);
  if (!Array.isArray(i.prices) || !i.prices.length) throw invalid('Give the new prices.');
  const newId = i.newId ?? await FIRST_FREE(q, releaseId, old.id);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(newId) || newId.length > 60) throw invalid('The new offer id is lowercase letters, digits and dashes, up to 60 characters.');
  const gk = `reprice:${old.id}`;
  const stage = (c: StageInput) => stageChange(q, actor, releaseId, { ...c, groupKey: gk });
  const out: ReleaseChange[] = [];
  const input = {
    level: 'OFFER', id: newId, code: newId, name: i.name?.trim() || old.name, path: '', parentId: old.parentId, status: 'DRAFT', markets: old.markets, kind: old.kind, description: old.description, prices: i.prices.map(({ id: _id, ...p }) => p),
    contract: old.contract, fulfilment: old.fulfilment, partnerCode: old.partnerCode, validityDays: old.validityDays, ocs: old.ocs, characteristics: old.characteristics, requires: old.requires, excludes: old.excludes,
    salesChannels: old.salesChannels, variants: old.variants, deals: old.deals, suspension: old.suspension, group: old.group,
  };
  out.push(await stage({ op: 'CREATE', nodeId: newId, payload: { input }, note: `New version of ${old.name}` }));
  const hasItems = (await q.query(`SELECT 1 FROM catalog_nodes WHERE parent_id = $1 AND level = 'LINE_ITEM' LIMIT 1`, [old.id])).rows[0];
  if (hasItems) out.push(await stage({ op: 'COPY_LINE_ITEMS', nodeId: newId, payload: { fromId: old.id } }));
  if (old.status === 'ACTIVE') {
    out.push(await stage({ op: 'STATUS', nodeId: newId, payload: { status: 'ACTIVE' } }));
    out.push(await stage({ op: 'STATUS', nodeId: old.id, payload: { status: 'RETIRED' }, note: `Replaced by ${newId}` }));
  }
  const dependents: string[] = [];
  if (i.repointDependents !== false) {
    const deps = (await q.query(
      `SELECT id, data FROM catalog_nodes WHERE level = 'OFFER' AND id <> $1 AND (data->'requires' ? $1 OR data->'excludes' ? $1 OR data->'group'->'allowedMemberOfferIds' ? $1) ORDER BY id LIMIT 51`, [old.id])).rows;
    if (deps.length > 50) throw invalid(`More than 50 offers refer to ${old.name}. Point them at the new version in a separate release, or stage the changes yourself.`);
    for (const d of deps) {
      const patch: Record<string, unknown> = {};
      if ((d.data?.requires ?? []).includes(old.id)) patch.requires = swap(d.data.requires, old.id, newId);
      if ((d.data?.excludes ?? []).includes(old.id)) patch.excludes = swap(d.data.excludes, old.id, newId);
      if ((d.data?.group?.allowedMemberOfferIds ?? []).includes(old.id)) patch.group = { ...d.data.group, allowedMemberOfferIds: swap(d.data.group.allowedMemberOfferIds, old.id, newId) };
      out.push(await stage({ op: 'UPDATE', nodeId: d.id as string, payload: { patch }, note: `Now refers to ${newId}` }));
      dependents.push(d.id as string);
    }
  }
  await audit(q, actor, 'catalog_release', releaseId, 'RELEASE_REPRICE_STAGED', { offer: old.id, newId, dependents });
  return { newId, dependents, changes: out };
}

// ───────────────────────── undoing a published release ─────────────────────────
const LEVEL_ORDER = ['LINE_ITEM', 'OFFER', 'GROUP', 'CATEGORY', 'NETWORK_TYPE'];
const RESTORE = ['name', 'description', 'prices', 'contract', 'fulfilment', 'requires', 'excludes', 'salesChannels', 'markets', 'kind', 'partnerCode', 'validityDays', 'ocs', 'characteristics', 'variants', 'deals', 'suspension', 'group', 'itemType', 'quantity', 'unit', 'unlimited', 'sku', 'networkType'];

/**
 * A new draft release that puts back what a published one changed, built from the state of every node before it was published: edits are reversed, moves and status changes put
 * back, and nodes it created are deleted (or retired when they have since been sold, or hold something that stays). It is an ordinary release: it is previewed, reviewed and
 * published like any other, and the catalog's rules apply to it, so a price that cannot go back in place (a sold offer) is refused in its preview.
 */
export async function createReverseRelease(q: Queryable, actor: string, releaseId: string): Promise<Release> {
  const src = await getRelease(q, releaseId);
  if (src.status !== 'PUBLISHED' || !src.result?.before) throw conflict(`${src.number} is not published, so there is nothing to reverse.`);
  const before = src.result.before as Record<string, any>;
  const itemsBefore = (src.result.lineItemsBefore ?? {}) as Record<string, string[]>;
  const rel = await createRelease(q, actor, { name: `Reverse of ${src.number}: ${src.name}`.slice(0, 120), description: `Undoes ${src.number}.`, reversesReleaseId: releaseId });
  const ids = Object.keys(before);
  const now = await snapshot(q, ids);
  const stage = (c: StageInput) => stageChange(q, actor, rel.id, c);
  const created = ids.filter((id) => before[id] === null && now.get(id)).sort((a, b) => LEVEL_ORDER.indexOf(now.get(a)!.node.level) - LEVEL_ORDER.indexOf(now.get(b)!.node.level));
  // what stays: restore the nodes that existed before
  for (const id of ids) {
    const b = before[id], cur = now.get(id);
    if (!b || !cur) continue;
    const patch: Record<string, unknown> = {};
    for (const f of RESTORE) {
      if (sameValue(norm(f, b[f]), norm(f, cur.node[f]))) continue;
      // the catalog reads a missing field as "leave it", so a value that did not exist before is cleared the way its field allows: null, or an empty text
      if (b[f] === undefined) { if (f === 'group' || f === 'ocs' || f === 'quantity') patch[f] = null; else if (['description', 'partnerCode', 'unit', 'sku'].includes(f)) patch[f] = ''; continue; }
      patch[f] = b[f];
    }
    if (Object.keys(patch).length) await stage({ op: 'UPDATE', nodeId: id, payload: { patch } });
    if ((b.parentId ?? null) !== (cur.node.parentId ?? null)) await stage({ op: 'MOVE', nodeId: id, payload: { parentId: b.parentId ?? null } });
    if (b.status !== cur.node.status && !(b.status === 'SCHEDULED' && (!b.activeFrom || new Date(b.activeFrom) <= new Date()))) await stage({ op: 'STATUS', nodeId: id, payload: { status: b.status, ...(b.status === 'SCHEDULED' ? { activeFrom: b.activeFrom } : {}) } });
    // line items the release added to an offer that existed
    if (itemsBefore[id]) for (const li of cur.lineItems) if (!itemsBefore[id]!.includes(li.id) && before[li.id] === undefined) await stage({ op: 'DELETE', nodeId: li.id });
  }
  // what the release created: delete it, children first; retire it instead when it has been sold or holds something that stays
  const gone = new Set<string>();
  for (const id of created) {
    const node = now.get(id)!.node;
    const sold = node.level === 'OFFER' ? await nodeUsage(q, id) : { services: 0, orders: 0 };
    const kids = (await q.query(`SELECT id FROM catalog_nodes WHERE parent_id = $1 AND level <> 'LINE_ITEM'`, [id])).rows.map((r) => r.id as string);
    const keeps = kids.some((k) => !gone.has(k));
    if (sold.services + sold.orders > 0 || keeps) { if (node.status !== 'RETIRED') await stage({ op: 'STATUS', nodeId: id, payload: { status: 'RETIRED' } }); }
    else { await stage({ op: 'DELETE', nodeId: id }); gone.add(id); }
  }
  const n = Number((await q.query('SELECT count(*) AS n FROM catalog_release_changes WHERE release_id = $1', [rel.id])).rows[0]!.n);
  if (!n) throw invalid(`${src.number} left nothing that differs from before, so there is nothing to reverse.`);
  await audit(q, actor, 'catalog_release', rel.id, 'RELEASE_REVERSE_CREATED', { reverses: src.number, changes: n });
  return getRelease(q, rel.id);
}
