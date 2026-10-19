import { enqueueOcs } from './ocs.js';
import { behaviourOf, type OfferNode } from '@meridian/types';
import { audit } from './audit.js';
import { assertAncestorsLive, getOffer, monthlyFee } from './catalog.js';
import type { Db, Queryable, Row } from './db.js';
import { invalid, notFound, rejected } from './errors.js';
import { addGroupMember, createGroup, dissolveGroup, getGroup, groupPlanTerms } from './groups.js';
import type { LineInput } from './order-pricing.js';
import { assertPortableNumber, cleanPortIn, type PortInInput } from './port-in.js';

/**
 * Group plans (family plans, multi-line shares) and how a group comes into being. There is no "Create group" button: a group is made by
 *  A. an ORDER that contains a group plan: the buyer's line becomes the family head (the group's Principal), and the same order lists the member lines
 *     (new numbers, ported-in numbers, physical SIMs or eSIMs, each on its own plan) up to the plan's limit; or
 *  B. a PLAN CHANGE: an existing single line moves to a group plan and becomes the family head, with the plan's remaining slots left open.
 * Members can be added later by another order that names the group (`joinGroupId`), or by staff on the account.
 *
 * In the data model: `service_groups` is the customer group (linked to the account), `service_group_members` maps services to it, and the Principal
 * member is the family head. Offers carry their terms in `catalog_nodes.data.group`.
 */
export type MemberInput = Omit<LineInput, 'members' | 'memberOf' | 'joinGroupId' | 'attachTo' | 'dealTermMonths' | 'quantity'>;

const isGroupPlan = (o: OfferNode) => !!o.group?.isGroupOffer;
/** A plan a member line may take: a mobile service plan that is not itself a group plan, and among the plan's allowed offers when it names any. */
function assertMemberOffer(head: OfferNode, member: OfferNode): void {
  const b = behaviourOf(member);
  if (isGroupPlan(member) || b.goods || b.service !== 'MOBILE') throw rejected(`${member.name} cannot be a member line: members take an ordinary mobile plan.`);
  const allowed = head.group?.allowedMemberOfferIds ?? [];
  if (allowed.length && !allowed.includes(member.id)) throw rejected(`${member.name} is not one of the plans ${head.name} allows for its members.`);
}

/**
 * Turns the cart into the order's real lines, before pricing: each group plan's member list becomes member lines (pointing at the head line), lines
 * that join an existing group are checked against its free slots, and port-in details are checked and tidied. Everything is refused here, in one place,
 * so the quote and the order agree.
 */
export async function prepareLines(q: Queryable, input: { customerId?: string; accountId?: string; lines: LineInput[] }): Promise<LineInput[]> {
  const out: LineInput[] = [];
  const heads: Array<{ index: number; offer: OfferNode; members: number }> = [];
  const offers = new Map<string, OfferNode>();
  const offerOf = async (id: string) => { let o = offers.get(id); if (!o) { o = await getOffer(q, id); offers.set(id, o); } return o; };
  const donors = new Set<string>();
  const extra = new Map<string, number>(); // slots this order takes in groups that exist already

  const accept = async (l: LineInput, groupHead?: number) => {
    const line: LineInput = { ...l };
    delete line.members;
    if (groupHead !== undefined) line.memberOf = groupHead;
    if (line.portIn) {
      const offer = await offerOf(line.offerId);
      const b = behaviourOf(offer);
      if (b.service !== 'MOBILE' || b.goods) throw invalid(`${offer.name} is not a mobile plan, so a number cannot be ported in to it.`);
      if ((line.quantity ?? 1) !== 1) throw invalid('A port-in is for one line: order one plan per line.');
      const clean = await cleanPortIn(q, line.portIn);
      if (donors.has(clean.donorMsisdn)) throw invalid(`${clean.donorMsisdn} is on this order twice.`);
      donors.add(clean.donorMsisdn);
      await assertPortableNumber(q, clean.donorMsisdn);
      if (line.msisdn) throw invalid('A line that ports a number in cannot also choose a number from our pool: the number is the one being ported in.');
      line.portIn = clean;
    }
    out.push(line);
    return out.length - 1;
  };

  for (const l of input.lines) {
    const offer = await offerOf(l.offerId);
    if (l.joinGroupId) {
      if (l.members?.length) throw invalid('A line that joins an existing group cannot bring its own members.');
      const g = (await q.query(`SELECT * FROM service_groups WHERE id=$1`, [l.joinGroupId])).rows[0];
      if (!g || g.status !== 'ACTIVE') throw notFound('group', l.joinGroupId);
      if (input.customerId && g.customerId !== input.customerId) throw rejected('That group belongs to a different customer.');
      if (input.accountId && g.accountId !== input.accountId) throw rejected('That group is on a different account.');
      if ((l.quantity ?? 1) !== 1) throw invalid('A line joins the group one at a time.');
      const gh = g.offerId ? await offerOf(g.offerId as string).catch(() => null) : null;
      if (gh) assertMemberOffer(gh, offer);
      else if (isGroupPlan(offer) || behaviourOf(offer).service !== 'MOBILE') throw rejected(`${offer.name} cannot join a group as a member line.`);
      const used = Number((await q.query(`SELECT count(*) AS n FROM service_group_members WHERE group_id=$1 AND role='SUPPLEMENTARY'`, [g.id])).rows[0]!.n) + (extra.get(g.id) ?? 0);
      if (g.maxSupplementary != null && used + 1 > g.maxSupplementary) throw rejected(`The group “${g.name}” has no free slot left (${g.maxSupplementary} supplementary line${g.maxSupplementary === 1 ? '' : 's'}).`);
      extra.set(g.id, (extra.get(g.id) ?? 0) + 1);
      await accept(l);
      continue;
    }
    if (isGroupPlan(offer)) {
      if ((l.quantity ?? 1) !== 1) throw invalid(`${offer.name} is a group plan: order it once, and list the member lines with it.`);
      if (l.attachTo !== undefined) throw invalid('A device on a contract goes with an ordinary plan, not a group plan.');
      const members = l.members ?? [];
      const max = offer.group!.maxGroupMembers;
      if (members.length > max) throw rejected(`${offer.name} holds up to ${max} member line${max === 1 ? '' : 's'}; ${members.length} were given.`);
      for (const m of members) assertMemberOffer(offer, await offerOf(m.offerId));
      const head = await accept(l);
      heads.push({ index: head, offer, members: members.length });
      for (const m of members) await accept({ ...m, quantity: 1 }, head);
      continue;
    }
    if (l.members?.length) throw invalid(`${offer.name} is not a group plan, so it cannot have member lines.`);
    await accept(l);
  }
  // attachTo indexes refer to positions in the cart the caller sent, which only differ when members were added after a device line: map them over.
  if (out.length !== input.lines.length && input.lines.some((x) => x.attachTo !== undefined)) {
    const map = new Map<LineInput, number>();
    let i = 0;
    for (const l of input.lines) { map.set(l, i); i += 1 + (l.members?.length ?? 0); }
    input.lines.forEach((l, k) => { if (l.attachTo !== undefined) out[map.get(l)!]!.attachTo = map.get(input.lines[l.attachTo]!)!; void k; });
  }
  return out;
}

/** What a group plan offers, for the cart: whether it is one, its limits, the plans a member may take. */
export function groupTermsOf(o: OfferNode): { maxMembers: number; sharedPoolQuotaGb: number | null; allowedMemberOfferIds: string[]; monthlyFeeMinor: number } | null {
  if (!o.group?.isGroupOffer) return null;
  return { maxMembers: o.group.maxGroupMembers, sharedPoolQuotaGb: o.group.sharedPoolQuotaGb ?? null, allowedMemberOfferIds: o.group.allowedMemberOfferIds ?? [], monthlyFeeMinor: monthlyFee(o)?.amount.amountMinor ?? 0 };
}

/**
 * After services have been created for an order's lines: opens the group for every group plan sold (the buyer's line is the family head) and puts the
 * member lines into it, or into the existing group they named. Safe to call again as more lines of the order switch on (a line waiting for a device,
 * a port-in waiting for its number): it only adds what is missing.
 */
export async function syncOrderGroups(q: Queryable, o: Row, actor: string): Promise<void> {
  const lines = (await q.query(`SELECT l.id, l.position, l.offer_id, l.service_id, l.group_head_position, l.join_group_id FROM order_lines l WHERE l.order_id=$1 AND l.status='ACTIVE' ORDER BY l.position`, [o.id])).rows;
  if (!lines.some((l) => l.groupHeadPosition != null || l.joinGroupId != null || false) && !(await anyGroupPlan(q, lines.map((l) => l.offerId as string)))) return;
  const memberOf = async (serviceId: string) => (await q.query('SELECT group_id FROM service_group_members WHERE service_id=$1', [serviceId])).rows[0]?.groupId as string | undefined;
  const customer = (await q.query('SELECT display_name FROM customers WHERE id=$1', [o.customerId])).rows[0];
  for (const head of lines) {
    if (!head.serviceId) continue;
    const offer = await getOffer(q, head.offerId as string);
    if (!isGroupPlan(offer)) continue;
    if (await memberOf(head.serviceId as string)) continue;
    const terms = await groupPlanTerms(q, offer.id);
    const pool = offer.group!.sharedPoolQuotaGb;
    await createGroup(q, actor, {
      accountId: o.accountId as string, name: `${customer?.displayName ?? 'Family'} – ${offer.name}`.slice(0, 80), principalServiceId: head.serviceId as string,
      offerId: offer.id, maxSupplementary: terms?.max ?? null, origin: 'CHECKOUT', benefits: pool ? { allowances: { dataGb: pool } } : undefined,
    });
  }
  for (const m of lines) {
    if (!m.serviceId) continue;
    let groupId: string | undefined;
    if (m.joinGroupId) groupId = m.joinGroupId as string;
    else if (m.groupHeadPosition != null) {
      const head = lines.find((l) => l.position === m.groupHeadPosition);
      if (head?.serviceId) groupId = await memberOf(head.serviceId as string);
    }
    if (!groupId || (await memberOf(m.serviceId as string))) continue;
    await addGroupMember(q, actor, groupId, m.serviceId as string);
  }
}
async function anyGroupPlan(q: Queryable, offerIds: string[]): Promise<boolean> {
  if (!offerIds.length) return false;
  return (await q.query(`SELECT 1 FROM catalog_nodes WHERE id = ANY($1::text[]) AND data->'group'->>'isGroupOffer' = 'true' LIMIT 1`, [offerIds])).rows.length > 0;
}

/**
 * Vector B: an existing single line moves to a group plan. The service keeps its number, SIM and history; it becomes the family head of a new group
 * that opens the plan's remaining slots, ready for members to be added (by an order that names the group, or by staff). The new plan's fee applies from
 * the next bill run, because bills are drawn from the catalog.
 */
export async function upgradeToGroupOffer(db: Db, actor: string, serviceId: string, offerId: string): Promise<Row> {
  return db.tx(async (q) => {
    const s = (await q.query('SELECT * FROM services WHERE id=$1 FOR UPDATE', [serviceId])).rows[0];
    if (!s) throw notFound('service', serviceId);
    if (s.status !== 'ACTIVE') throw rejected(`This line is ${String(s.status).toLowerCase()}; only an active line can move to a group plan.`);
    if (s.type !== 'MOBILE') throw rejected('Only a mobile line can move to a group plan.');
    if (await (async () => (await q.query('SELECT 1 FROM service_group_members WHERE service_id=$1', [serviceId])).rows.length > 0)()) throw rejected('This line is already in a group.');
    const offer = await getOffer(q, offerId);
    if (offer.status !== 'ACTIVE') throw rejected(`${offer.name} is not on sale.`);
    await assertAncestorsLive(q, [offer]);
    if (!isGroupPlan(offer)) throw rejected(`${offer.name} is not a group plan.`);
    if (offer.id === s.offerId) throw rejected('This line is already on that plan.');
    const cust = (await q.query('SELECT display_name, market_code FROM customers WHERE id=$1', [s.customerId])).rows[0];
    if (offer.markets.length && cust?.marketCode && !offer.markets.includes((cust.marketCode as string).trim())) throw rejected(`${offer.name} is not sold in this customer's market.`);
    const prior = s.offerId as string;
    const term = offer.contract?.termMonths || null;
    await q.query(`UPDATE services SET offer_id=$2, contract_term_months = COALESCE(contract_term_months, $3), contract_start = CASE WHEN contract_term_months IS NULL AND $3::int IS NOT NULL THEN COALESCE(contract_start, now()) ELSE contract_start END WHERE id=$1`, [serviceId, offer.id, term]);
    await audit(q, actor, 'service', serviceId, 'PLAN_CHANGED', { from: prior, to: offer.id, group: true });
    await enqueueOcs(q, 'CHANGE_PLAN', serviceId, { previousOfferId: prior });
    const pool = offer.group!.sharedPoolQuotaGb;
    const g = await createGroup(q, actor, {
      accountId: s.accountId as string, name: `${cust?.displayName ?? 'Family'} – ${offer.name}`.slice(0, 80), principalServiceId: serviceId, offerId: offer.id,
      maxSupplementary: offer.group!.maxGroupMembers, origin: 'PLAN_CHANGE', benefits: pool ? { allowances: { dataGb: pool } } : undefined,
    });
    await q.query(`INSERT INTO lifecycle_outbox (kind, service_id, account_id, instruction, payload) VALUES ('NETWORK', $1, $2, 'PLAN_CHANGE', $3)`, [serviceId, s.accountId, JSON.stringify({ from: prior, to: offer.id, sharedPoolQuotaGb: pool ?? null })]);
    return getGroup(q, g.id as string);
  });
}

/**
 * Dissolves a group and puts every line back on a single-line plan. A line on the group plan, or on a plan reserved for the group's members, means nothing
 * without the group, so a single plan must be chosen for it; any other line may keep its plan or take another. A plan is chosen as `{ [serviceId]: offerId }`. As when a line moves
 * to a group plan, the number, SIM and history stay and the new plan's fee applies from the next bill run.
 */
export async function dissolveToSingles(db: Db, actor: string, groupId: string, plans: Record<string, string> = {}): Promise<{ changed: Array<{ serviceId: string; identifier: string; from: string; to: string }> }> {
  return db.tx(async (q) => {
    const g = await getGroup(q, groupId);
    if (g.status !== 'ACTIVE') throw rejected('This group is already closed.');
    const members = g.members as Row[];
    for (const id of Object.keys(plans)) if (!members.some((m) => m.serviceId === id)) throw invalid('A plan was chosen for a line that is not in this group.');
    const changed: Array<{ serviceId: string; identifier: string; from: string; to: string }> = [];
    for (const m of members) {
      const current = await getOffer(q, m.offerId as string);
      const target = plans[m.serviceId as string];
      const tied = !!m.onGroupPlan;
      if (!target && tied) throw rejected(`Choose a single plan for ${m.identifier}: it is on ${current.name}, a plan that only exists with the group.`);
      if (!target || (target === current.id && !tied)) continue;
      const offer = await getOffer(q, target);
      if (offer.status !== 'ACTIVE') throw rejected(`${offer.name} is not on sale.`);
      await assertAncestorsLive(q, [offer]);
      if (isGroupPlan(offer) || (tied && target === current.id)) throw rejected(`${offer.name} only exists with the group. Choose a single-line plan for ${m.identifier}.`);
      const b = behaviourOf(offer);
      if (b.role !== 'PLAN' || b.goods || (b.service ?? 'MOBILE') !== String(m.type)) throw rejected(`${offer.name} is not a ${String(m.type).toLowerCase()} plan that ${m.identifier} can move to.`);
      const s = (await q.query('SELECT customer_id, account_id FROM services WHERE id=$1 FOR UPDATE', [m.serviceId])).rows[0]!;
      const cust = (await q.query('SELECT market_code FROM customers WHERE id=$1', [s.customerId])).rows[0];
      if (offer.markets.length && cust?.marketCode && !offer.markets.includes((cust.marketCode as string).trim())) throw rejected(`${offer.name} is not sold in this customer's market.`);
      const term = offer.contract?.termMonths || null;
      await q.query(`UPDATE services SET offer_id=$2, contract_term_months = COALESCE(contract_term_months, $3), contract_start = CASE WHEN contract_term_months IS NULL AND $3::int IS NOT NULL THEN COALESCE(contract_start, now()) ELSE contract_start END, updated_at=now() WHERE id=$1`, [m.serviceId, offer.id, term]);
      await audit(q, actor, 'service', m.serviceId as string, 'PLAN_CHANGED', { from: current.id, to: offer.id, groupDissolved: groupId });
      await enqueueOcs(q, 'CHANGE_PLAN', m.serviceId as string, { previousOfferId: current.id });
      await q.query(`INSERT INTO lifecycle_outbox (kind, service_id, account_id, instruction, payload) VALUES ('NETWORK', $1, $2, 'PLAN_CHANGE', $3)`, [m.serviceId, s.accountId, JSON.stringify({ from: current.id, to: offer.id, sharedPoolQuotaGb: null })]);
      changed.push({ serviceId: m.serviceId as string, identifier: m.identifier as string, from: current.name, to: offer.name });
    }
    await dissolveGroup(q, actor, groupId);
    return { changed };
  });
}

/** The group-order orchestrator as one object: group plans in carts and orders, groups opened at checkout, and the plan-change route. */
export class GroupOrderService {
  constructor(private readonly db: Db) {}
  /** Cart → order lines (members expanded, limits and port-in details checked). */
  prepare(input: { customerId?: string; accountId?: string; lines: LineInput[] }): Promise<LineInput[]> { return this.db.tx((q) => prepareLines(q, input)); }
  /** Vector B: an existing line moves to a group plan and becomes the family head. */
  upgrade(serviceId: string, offerId: string, actor: string): Promise<Row> { return upgradeToGroupOffer(this.db, actor, serviceId, offerId); }
  /** The slots of a group: how many member lines it holds, how many are taken and how many are free. */
  async slots(groupId: string): Promise<{ max: number | null; used: number; remaining: number | null }> {
    const g = await getGroup(this.db, groupId);
    return g.slots ? (g.slots as { max: number; used: number; remaining: number }) : { max: null, used: (g.members as Row[]).filter((m) => m.role === 'SUPPLEMENTARY').length, remaining: null };
  }
}

export type { PortInInput };
