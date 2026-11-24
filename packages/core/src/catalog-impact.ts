import { z } from 'zod';
import { audit } from './audit.js';
import { inReleaseState, previewRelease, type DiffNode } from './catalog-release.js';
import type { Db, Queryable } from './db.js';
import { conflict, invalid, notFound } from './errors.js';
import { withRollback } from './rollback.js';
import { priceBasket, type Priced, type PricingInput } from './order-pricing.js';

/**
 * Phase 4 of the release layer: what a release would touch (impact) and what it does to the price of typical baskets (what-if).
 * Nothing here prices or validates by itself: impact counts are capped indexed reads per offer, and the what-if runs the real `priceBasket` on the live catalogue and again inside
 * the release's rolled-back state, so it answers exactly as placing the order would.
 */
export const IMPACT_CAP = 10_000;       // a count stops here and says "10,000+"
export const IMPACT_MAX_OFFERS = 100;   // offers examined per release (the rest are listed as skipped)
export const PERSONA_MAX = 50;

export interface OfferImpact {
  id: string; name: string; why: Array<'retired' | 'deleted' | 'repriced' | 'changed'>;
  services: number; inFlightOrders: number;
  dependents: Array<{ id: string; name: string; via: 'requires' | 'excludes' | 'bundle rule' }>;
  capped: boolean;
}
export interface ReleaseImpact { offers: OfferImpact[]; skipped: number; cap: number }

const OPEN_ORDER_STATES = ['DRAFT', 'SUBMITTED', 'VALIDATED', 'PAYMENT_PENDING', 'PAID', 'FULFILMENT', 'AWAITING_INSTALLATION', 'SHIPPED', 'DELIVERED', 'ACTIVATED'];
const capped = async (q: Queryable, sql: string, args: unknown[]) => Number((await q.query(`SELECT count(*) AS n FROM (${sql} LIMIT ${IMPACT_CAP + 1}) c`, args)).rows[0]!.n);

async function offerImpact(q: Queryable, n: DiffNode): Promise<OfferImpact> {
  const why: OfferImpact['why'] = [];
  if (n.kind === 'DELETED') why.push('deleted');
  if (n.retired) why.push('retired');
  if (n.repriced) why.push('repriced');
  if (!why.length) why.push('changed');
  const services = await capped(q, `SELECT 1 FROM services WHERE offer_id = $1 AND status <> 'TERMINATED'`, [n.id]);
  const inFlight = await capped(q, `SELECT 1 FROM order_lines l JOIN orders o ON o.shard_id = l.shard_id AND o.id = l.order_id WHERE l.offer_id = $1 AND o.state::text = ANY($2::text[])`, [n.id, OPEN_ORDER_STATES]);
  const deps = (await q.query(`SELECT id, name, CASE WHEN data->'requires' ? $1 THEN 'requires' ELSE 'excludes' END AS via FROM catalog_nodes WHERE id <> $1 AND level = 'OFFER' AND (data->'requires' ? $1 OR data->'excludes' ? $1) ORDER BY id LIMIT 25`, [n.id])).rows
    .map((r) => ({ id: r.id as string, name: r.name as string, via: r.via as 'requires' | 'excludes' }));
  const rules = (await q.query(`SELECT id, name FROM bundle_rules WHERE status <> 'RETIRED' AND (data->'when' ? $1 OR data->>'target' = $1) ORDER BY id LIMIT 25`, [n.id])).rows
    .map((r) => ({ id: r.id as string, name: r.name as string, via: 'bundle rule' as const }));
  return { id: n.id, name: n.name, why, services: Math.min(services, IMPACT_CAP), inFlightOrders: Math.min(inFlight, IMPACT_CAP), dependents: [...deps, ...rules], capped: services > IMPACT_CAP || inFlight > IMPACT_CAP };
}

/** Who is affected: for each offer the release retires, deletes, reprices or changes, the live services and in-flight orders on it and what depends on it. Capped, indexed reads. */
export async function releaseImpact(db: Db, releaseId: string): Promise<ReleaseImpact> {
  const pv = await previewRelease(db, releaseId);
  const offers = pv.nodes.filter((n) => n.level === 'OFFER' && n.kind !== 'ADDED');
  const out: OfferImpact[] = [];
  for (const n of offers.slice(0, IMPACT_MAX_OFFERS)) out.push(await offerImpact(db, n));
  return { offers: out, skipped: Math.max(0, offers.length - IMPACT_MAX_OFFERS), cap: IMPACT_CAP };
}

// ───────────────────────── personas ─────────────────────────
export interface Persona { id: string; name: string; description: string; basket: PersonaBasket; createdBy: string; createdAt: string; updatedAt: string }
export type PersonaBasket = Pick<PricingInput, 'channel' | 'marketCode' | 'lines' | 'payment' | 'financing'>;

export const personaInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).optional(),
  basket: z.object({
    channel: z.string().min(1).max(40), marketCode: z.string().max(10).optional(),
    lines: z.array(z.object({ offerId: z.string().min(1).max(80), quantity: z.number().int().min(1).max(100).optional(), options: z.object({ variantId: z.string().max(60).optional() }).optional(), attachTo: z.number().int().min(0).max(20).optional(), dealTermMonths: z.number().int().optional() }).passthrough()).min(1).max(20),
    payment: z.object({ method: z.string().min(1).max(30), installmentMonths: z.number().int().optional() }).passthrough(),
    financing: z.object({ payInFull: z.boolean().optional() }).passthrough().optional(),
  }),
});
export type PersonaInput = z.infer<typeof personaInput>;

export async function listPersonas(q: Queryable): Promise<Persona[]> {
  return (await q.query(`SELECT id, name, description, basket, created_by, created_at, updated_at FROM catalog_pricing_personas ORDER BY name LIMIT ${PERSONA_MAX}`)).rows as unknown as Persona[];
}
export async function savePersona(q: Queryable, actor: string, input: PersonaInput, id?: string): Promise<Persona> {
  const v = personaInput.parse(input);
  if (!id && Number((await q.query('SELECT count(*) AS n FROM catalog_pricing_personas')).rows[0]!.n) >= PERSONA_MAX) throw invalid(`At most ${PERSONA_MAX} sample baskets.`);
  try {
    const r = id
      ? (await q.query(`UPDATE catalog_pricing_personas SET name = $2, description = $3, basket = $4, updated_at = now() WHERE id = $1 RETURNING id`, [id, v.name, v.description ?? '', JSON.stringify(v.basket)])).rows[0]
      : (await q.query(`INSERT INTO catalog_pricing_personas (name, description, basket, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [v.name, v.description ?? '', JSON.stringify(v.basket), actor])).rows[0];
    if (!r) throw notFound('sample basket', id ?? '');
    await audit(q, actor, 'catalog_persona', r.id as string, id ? 'PERSONA_UPDATED' : 'PERSONA_CREATED', { name: v.name });
    return (await q.query(`SELECT id, name, description, basket, created_by, created_at, updated_at FROM catalog_pricing_personas WHERE id = $1`, [r.id])).rows[0] as unknown as Persona;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw conflict(`A sample basket called “${v.name}” already exists.`);
    throw e;
  }
}
export async function deletePersona(q: Queryable, actor: string, id: string): Promise<void> {
  const r = await q.query('DELETE FROM catalog_pricing_personas WHERE id = $1 RETURNING name', [id]);
  if (!r.rows.length) throw notFound('sample basket', id);
  await audit(q, actor, 'catalog_persona', id, 'PERSONA_DELETED', { name: r.rows[0]!.name });
}

// ───────────────────────── what-if ─────────────────────────
export interface PriceFigures { dueNowMinor: number; netMinor: number; monthlyPlanMinor: number; monthlyInstalmentMinor: number; discountMinor: number; problems: string[]; lines: Array<{ offerId: string; name: string; grossMinor: number; monthlyFeeMinor: number }> }
export interface WhatIfRow {
  personaId: string | null; name: string; before: PriceFigures | { error: string }; after: PriceFigures | { error: string };
  /** after − before; absent when either side could not be priced */
  delta?: { dueNowMinor: number; monthlyPlanMinor: number; monthlyInstalmentMinor: number; discountMinor: number };
  changed: boolean;
}
const figures = (p: Priced): PriceFigures => ({
  dueNowMinor: p.dueNow, netMinor: p.net, monthlyPlanMinor: p.monthlyPlanMinor, monthlyInstalmentMinor: p.monthlyInstalmentMinor, discountMinor: p.discountMinor, problems: p.problems,
  lines: p.lines.map((l) => ({ offerId: l.offer.id, name: l.offer.name, grossMinor: l.gross, monthlyFeeMinor: l.monthlyFeeMinor })),
});
const priceOrError = async (q: Queryable, basket: PersonaBasket): Promise<PriceFigures | { error: string }> => {
  await q.query('SAVEPOINT whatif');
  try { const f = figures(await priceBasket(q, basket as PricingInput, { soft: true })); await q.query('RELEASE SAVEPOINT whatif'); return f; }
  catch (e) { await q.query('ROLLBACK TO SAVEPOINT whatif'); return { error: e instanceof Error ? e.message : String(e) }; }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Prices each sample basket on the live catalogue and as the release would leave it, with the real pricing code. A basket that cannot be priced on either side (an offer that
 * is not sold any more, say) says why instead of a price. Nothing is stored: the after side runs inside the release's rolled-back state.
 */
export async function releaseWhatIf(db: Db, releaseId: string, o: { personaIds?: string[]; baskets?: Array<{ name: string; basket: PersonaBasket }> } = {}): Promise<{ rows: WhatIfRow[] }> {
  const personas = (await listPersonas(db)).filter((p) => !o.personaIds || o.personaIds.includes(p.id));
  const subjects = [...personas.map((p) => ({ personaId: p.id as string | null, name: p.name, basket: p.basket })), ...(o.baskets ?? []).map((b) => ({ personaId: null, name: b.name, basket: personaInput.shape.basket.parse(b.basket) as PersonaBasket }))].slice(0, PERSONA_MAX);
  const before = await withRollback(db, async (q) => { const r: Array<PriceFigures | { error: string }> = []; for (const s of subjects) r.push(await priceOrError(q, s.basket)); return r; });
  const after = await inReleaseState(db, releaseId, async (q) => { const r: Array<PriceFigures | { error: string }> = []; for (const s of subjects) r.push(await priceOrError(q, s.basket)); return r; });
  return {
    rows: subjects.map((s, i) => {
      const b = before[i]!, a = after[i]!;
      const ok = !('error' in b) && !('error' in a);
      return {
        personaId: s.personaId, name: s.name, before: b, after: a,
        delta: ok ? { dueNowMinor: a.dueNowMinor - b.dueNowMinor, monthlyPlanMinor: a.monthlyPlanMinor - b.monthlyPlanMinor, monthlyInstalmentMinor: a.monthlyInstalmentMinor - b.monthlyInstalmentMinor, discountMinor: a.discountMinor - b.discountMinor } : undefined,
        changed: !same(b, a),
      };
    }),
  };
}
