import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { invalid, notFound, rejected } from './errors.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';

/**
 * A Group ties together services under ONE account so they can share benefits (an allowance for data, voice and SMS, and a discount on the
 * supplementary lines). Exactly one member is the Principal service; the others are Supplementary and cannot exist without it.
 * A service is in at most one group. Groups are not tied to households: a company can group its staff lines the same way.
 */
export type GroupRole = 'PRINCIPAL' | 'SUPPLEMENTARY';
export interface GroupBenefits {
  /** Shared pools (informational: usage rating is not part of this release). Absent = not part of the group. */
  allowances?: { dataGb?: number; voiceMinutes?: number; smsCount?: number };
  /** Percentage off the recurring fee of every supplementary service, in basis points (1000 = 10%). Applied on each bill. */
  discountBps?: number;
}

const OK_STATUS = ['PENDING', 'ACTIVE', 'SUSPENDED'];
const BENEFIT_LIMIT = 1_000_000;

export function cleanBenefits(b: GroupBenefits | undefined | null): GroupBenefits {
  const out: GroupBenefits = {};
  const al = b?.allowances ?? {};
  const pick = (v: unknown, what: string): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > BENEFIT_LIMIT) throw invalid(`${what} must be a number from 0 to ${BENEFIT_LIMIT.toLocaleString('en')}`);
    return Math.round(v * 100) / 100;
  };
  const allowances: NonNullable<GroupBenefits['allowances']> = {};
  const d = pick(al.dataGb, 'shared data'), v = pick(al.voiceMinutes, 'shared voice minutes'), s = pick(al.smsCount, 'shared SMS');
  if (d !== undefined) allowances.dataGb = d;
  if (v !== undefined) allowances.voiceMinutes = v;
  if (s !== undefined) allowances.smsCount = s;
  if (Object.keys(allowances).length) out.allowances = allowances;
  if (b?.discountBps !== undefined && b.discountBps !== null) {
    if (!Number.isInteger(b.discountBps) || b.discountBps < 0 || b.discountBps > 10_000) throw invalid('the discount must be between 0% and 100%');
    if (b.discountBps > 0) out.discountBps = b.discountBps;
  }
  return out;
}

const name = (v: string | undefined) => {
  const t = v?.trim();
  if (!t) throw invalid('a group needs a name');
  if (t.length > 80) throw invalid('the group name is limited to 80 characters');
  return t;
};

async function groupRow(q: Queryable, id: string, lock = false): Promise<Row> {
  const g = (await q.query(`SELECT * FROM service_groups WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!g) throw notFound('group', id);
  return g;
}
const activeGroup = async (q: Queryable, id: string) => {
  const g = await groupRow(q, id, true);
  if (g.status !== 'ACTIVE') throw rejected('this group has been dissolved');
  return g;
};

/** Services that can be put in a group: on the group's account, still alive, and not already in a group. */
async function eligibleServices(q: Queryable, accountId: string, ids: string[]): Promise<Row[]> {
  if (!ids.length) return [];
  const rows = (await q.query(
    `SELECT s.id, s.identifier, s.type, s.status, s.account_id, m.group_id FROM services s LEFT JOIN service_group_members m ON m.service_id = s.id WHERE s.id = ANY($1::uuid[])`, [ids])).rows;
  for (const id of ids) {
    const s = rows.find((r) => r.id === id);
    if (!s) throw notFound('service', id);
    if (s.accountId !== accountId) throw rejected(`${s.identifier} is on a different account: a group holds services of one account only`);
    if (!OK_STATUS.includes(s.status)) throw rejected(`${s.identifier} is ${String(s.status).toLowerCase()} and cannot join a group`);
    if (s.groupId) throw rejected(`${s.identifier} is already in a group`);
  }
  return rows;
}

/** The terms of the group plan a group was made for (how many supplementary lines, which offers they may take), or null for a group made by hand. */
export async function groupPlanTerms(q: Queryable, offerId: string | null | undefined): Promise<{ max: number; allowed: string[] } | null> {
  if (!offerId) return null;
  const g = (await q.query(`SELECT data->'group' AS g FROM catalog_nodes WHERE id=$1`, [offerId])).rows[0]?.g;
  return g?.isGroupOffer ? { max: g.maxGroupMembers as number, allowed: (g.allowedMemberOfferIds ?? []) as string[] } : null;
}

/** Whether a service may join a plan-based group as a supplementary line: a slot is free and its offer is one the group plan allows. */
async function assertCanJoin(q: Queryable, g: Row, services: Row[]): Promise<void> {
  const terms = await groupPlanTerms(q, g.offerId);
  const used = Number((await q.query(`SELECT count(*) AS n FROM service_group_members WHERE group_id=$1 AND role='SUPPLEMENTARY'`, [g.id])).rows[0]!.n);
  if (g.maxSupplementary != null && used + services.length > g.maxSupplementary) {
    const left = Math.max(0, g.maxSupplementary - used);
    throw rejected(`This group holds ${g.maxSupplementary} supplementary line${g.maxSupplementary === 1 ? '' : 's'} besides the family head, and ${left === 0 ? 'every slot is taken' : `${left} slot${left === 1 ? ' is' : 's are'} left`}.`);
  }
  if (terms?.allowed.length) {
    const offers = (await q.query('SELECT s.identifier, s.offer_id FROM services s WHERE s.id = ANY($1::uuid[])', [services.map((x) => x.id)])).rows;
    for (const o of offers) if (!terms.allowed.includes(o.offerId as string)) throw rejected(`${o.identifier} is on a plan this group does not allow as a member line.`);
  }
}

export async function createGroup(q: Queryable, actor: string, i: { accountId: string; name: string; principalServiceId: string; supplementaryServiceIds?: string[]; benefits?: GroupBenefits; offerId?: string; maxSupplementary?: number | null; origin?: 'MANUAL' | 'CHECKOUT' | 'PLAN_CHANGE' }): Promise<Row> {
  const acct = (await q.query('SELECT id, customer_id, shard_id FROM accounts WHERE id=$1', [i.accountId])).rows[0];
  if (!acct) throw notFound('account', i.accountId);
  const sup = [...new Set(i.supplementaryServiceIds ?? [])];
  if (sup.includes(i.principalServiceId)) throw invalid('the principal service cannot also be supplementary');
  const benefits = cleanBenefits(i.benefits);
  const found = await eligibleServices(q, i.accountId, [i.principalServiceId, ...sup]);
  const terms = await groupPlanTerms(q, i.offerId);
  const max = i.maxSupplementary ?? terms?.max ?? null;
  if (max != null && sup.length > max) throw rejected(`This group holds ${max} supplementary line${max === 1 ? '' : 's'} besides the family head; ${sup.length} were given.`);
  if (terms?.allowed.length) {
    for (const id of sup) { const row = found.find((r) => r.id === id); const off = (await q.query('SELECT offer_id FROM services WHERE id=$1', [id])).rows[0]?.offerId; if (!terms.allowed.includes(off as string)) throw rejected(`${row?.identifier ?? id} is on a plan this group does not allow as a member line.`); }
  }
  const id = randomUUID();
  await q.query(`INSERT INTO service_groups (id, shard_id, customer_id, account_id, name, benefits, created_by, offer_id, max_supplementary, origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, acct.shardId, acct.customerId, i.accountId, name(i.name), JSON.stringify(benefits), actor, i.offerId ?? null, max, i.origin ?? 'MANUAL']);
  await q.query(`INSERT INTO service_group_members (group_id, service_id, role, added_by) VALUES ($1,$2,'PRINCIPAL',$3)`, [id, i.principalServiceId, actor]);
  for (const s of sup) await q.query(`INSERT INTO service_group_members (group_id, service_id, role, added_by) VALUES ($1,$2,'SUPPLEMENTARY',$3)`, [id, s, actor]);
  await audit(q, actor, 'service_group', id, 'create', { accountId: i.accountId, principal: i.principalServiceId, supplementary: sup.length });
  return getGroup(q, id);
}

export async function getGroup(q: Queryable, id: string): Promise<Row> {
  const g = await groupRow(q, id);
  const members = (await q.query(
    `SELECT m.service_id, m.role, m.added_at, s.identifier, s.type, s.status, s.offer_id, n.name AS offer_name
       FROM service_group_members m JOIN services s ON s.id = m.service_id LEFT JOIN catalog_nodes n ON n.id = s.offer_id
      WHERE m.group_id=$1 ORDER BY (m.role = 'PRINCIPAL') DESC, s.identifier LIMIT 500`, [id])).rows;
  const used = members.filter((m) => m.role === 'SUPPLEMENTARY').length;
  const slots = g.maxSupplementary == null ? null : { max: g.maxSupplementary as number, used, remaining: Math.max(0, (g.maxSupplementary as number) - used) };
  return { ...g, members, slots };
}

/** The groups of an account (or a customer), newest last, a page at a time, each with its principal and size. */
export async function listGroups(q: Queryable, f: { accountId?: string; customerId?: string; limit?: number; cursor?: string }): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 20, 100);
  const { params, p } = sqlBuilder();
  const where = [`g.status = 'ACTIVE'`];
  if (f.accountId) where.push(`g.account_id = ${p(f.accountId)}`);
  if (f.customerId) where.push(`g.customer_id = ${p(f.customerId)}`);
  if (!f.accountId && !f.customerId) throw invalid('say which account or customer');
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(g.created_at::text, g.id) > (${p(cur[0])}::text, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(
    `SELECT g.id, g.account_id, g.customer_id, g.name, g.benefits, g.created_at, g.created_at::text AS cursor_ts,
            (SELECT count(*) FROM service_group_members m WHERE m.group_id = g.id) AS member_count,
            (SELECT s.identifier FROM service_group_members m JOIN services s ON s.id = m.service_id WHERE m.group_id = g.id AND m.role = 'PRINCIPAL') AS principal_identifier
       FROM service_groups g WHERE ${where.join(' AND ')} ORDER BY g.created_at::text, g.id LIMIT ${p(limit + 1)}`, params)).rows;
  return toPage(rows, limit, (r) => [r.cursorTs as string, r.id as string]) as Page<Row>;
}

export async function updateGroup(q: Queryable, actor: string, id: string, p: { name?: string; benefits?: GroupBenefits }): Promise<Row> {
  const g = await activeGroup(q, id);
  await q.query(`UPDATE service_groups SET name=$2, benefits=$3, updated_at=now() WHERE id=$1`,
    [id, p.name === undefined ? g.name : name(p.name), JSON.stringify(p.benefits === undefined ? g.benefits : cleanBenefits(p.benefits))]);
  await audit(q, actor, 'service_group', id, 'update', { ...p });
  return getGroup(q, id);
}

export async function addGroupMember(q: Queryable, actor: string, groupId: string, serviceId: string): Promise<Row> {
  const g = await activeGroup(q, groupId);
  await eligibleServices(q, g.accountId, [serviceId]);
  await assertCanJoin(q, g, [{ id: serviceId }]);
  await q.query(`INSERT INTO service_group_members (group_id, service_id, role, added_by) VALUES ($1,$2,'SUPPLEMENTARY',$3)`, [groupId, serviceId, actor]);
  await audit(q, actor, 'service_group', groupId, 'add_member', { serviceId });
  return getGroup(q, groupId);
}

/** Makes another member the principal; the old principal becomes supplementary. The group always has exactly one principal. */
export async function changePrincipal(q: Queryable, actor: string, groupId: string, serviceId: string): Promise<Row> {
  await activeGroup(q, groupId);
  const m = (await q.query('SELECT role FROM service_group_members WHERE group_id=$1 AND service_id=$2', [groupId, serviceId])).rows[0];
  if (!m) throw rejected('that service is not in this group');
  if (m.role === 'PRINCIPAL') return getGroup(q, groupId);
  const s = (await q.query('SELECT identifier, status FROM services WHERE id=$1', [serviceId])).rows[0]!;
  if (!OK_STATUS.includes(s.status)) throw rejected(`${s.identifier} is ${String(s.status).toLowerCase()} and cannot be the principal`);
  await q.query(`UPDATE service_group_members SET role='SUPPLEMENTARY' WHERE group_id=$1 AND role='PRINCIPAL'`, [groupId]);
  await q.query(`UPDATE service_group_members SET role='PRINCIPAL' WHERE group_id=$1 AND service_id=$2`, [groupId, serviceId]);
  await audit(q, actor, 'service_group', groupId, 'change_principal', { serviceId });
  return getGroup(q, groupId);
}

/**
 * Takes a service out of its group. A supplementary service simply leaves. The principal cannot leave while others depend on it:
 * make another service the principal first, or dissolve the group. A principal that is alone closes the group.
 */
export async function removeGroupMember(q: Queryable, actor: string, groupId: string, serviceId: string): Promise<Row | null> {
  await activeGroup(q, groupId);
  const m = (await q.query('SELECT role FROM service_group_members WHERE group_id=$1 AND service_id=$2', [groupId, serviceId])).rows[0];
  if (!m) throw rejected('that service is not in this group');
  const others = Number((await q.query('SELECT count(*) AS n FROM service_group_members WHERE group_id=$1 AND service_id<>$2', [groupId, serviceId])).rows[0]!.n);
  if (m.role === 'PRINCIPAL' && others > 0) throw rejected('this is the principal service and the group still has supplementary services. Make another service the principal first, or dissolve the group.');
  await q.query('DELETE FROM service_group_members WHERE group_id=$1 AND service_id=$2', [groupId, serviceId]);
  await audit(q, actor, 'service_group', groupId, 'remove_member', { serviceId });
  if (others === 0) { await q.query(`UPDATE service_groups SET status='CLOSED', closed_at=now(), updated_at=now() WHERE id=$1`, [groupId]); return null; }
  return getGroup(q, groupId);
}

export async function dissolveGroup(q: Queryable, actor: string, groupId: string): Promise<void> {
  await activeGroup(q, groupId);
  await q.query('DELETE FROM service_group_members WHERE group_id=$1', [groupId]);
  await q.query(`UPDATE service_groups SET status='CLOSED', closed_at=now(), updated_at=now() WHERE id=$1`, [groupId]);
  await audit(q, actor, 'service_group', groupId, 'dissolve', {});
}

export async function groupOfService(q: Queryable, serviceId: string): Promise<Row | null> {
  const r = (await q.query(
    `SELECT g.id, g.name, m.role, (SELECT count(*) FROM service_group_members x WHERE x.group_id = g.id) AS member_count
       FROM service_group_members m JOIN service_groups g ON g.id = m.group_id WHERE m.service_id=$1`, [serviceId])).rows[0];
  return r ?? null;
}

/**
 * Called when a service is about to leave its account for good (terminated or moved to another owner). A supplementary service just leaves its
 * group; the principal of a group that still has supplementary services must be handed over (or the group dissolved) first, so no supplementary
 * service is ever left without a principal.
 */
export async function releaseFromGroup(q: Queryable, actor: string, serviceId: string): Promise<void> {
  const m = (await q.query('SELECT group_id, role FROM service_group_members WHERE service_id=$1', [serviceId])).rows[0];
  if (!m) return;
  const g = await groupRow(q, m.groupId);
  if (m.role === 'PRINCIPAL') {
    const others = Number((await q.query('SELECT count(*) AS n FROM service_group_members WHERE group_id=$1 AND service_id<>$2', [m.groupId, serviceId])).rows[0]!.n);
    if (others > 0) throw rejected(`this is the principal service of the group “${g.name}”, which still has ${others} supplementary service${others === 1 ? '' : 's'}. Make another service the principal, or dissolve the group, first.`);
  }
  await removeGroupMember(q, actor, m.groupId, serviceId);
}
