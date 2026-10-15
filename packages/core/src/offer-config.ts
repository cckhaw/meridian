import { cleanOcsMapping } from './ocs.js';
import { FULFILMENT_MECHANICS, OFFER_TEMPLATES, ORDER_STEPS, TEMPLATES, switchesOf, switchProblems, type BehaviourSwitches, type FulfilmentMechanic, type OfferTemplate, type OrderStep } from '@meridian/types';
import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { getServiceKind, isBuiltinKind } from './service-kinds.js';

/**
 * Catalog configuration: the offer types and fulfilment options an operator maintains in Settings → Catalog.
 * What a type or option does comes from its behaviour template / mechanic (fixed in code), so renaming or adding one can never leave the
 * platform not knowing how to sell, fulfil or bill it. The template and mechanic of an existing row never change.
 */
/** `template` is the preset a type started from; `behaviour` is what it does now (null: exactly the preset). `effective` is always the switches in force. */
export interface OfferType { id: string; name: string; description: string | null; template: OfferTemplate; behaviour: BehaviourSwitches | null; effective: BehaviourSwitches; status: 'ACTIVE' | 'INACTIVE'; sortOrder: number; isBuiltin: boolean }
export interface FulfilmentOption { id: string; name: string; description: string | null; mechanic: FulfilmentMechanic; tracksStock: boolean; status: 'ACTIVE' | 'INACTIVE'; sortOrder: number; isBuiltin: boolean }

const text = (v: string | undefined | null, max: number, what: string) => { const t = v?.trim(); if (t && t.length > max) throw invalid(`${what} is too long (max ${max} characters)`); return t || null; };

/** A short code from the name ("Prepaid SIM" → PREPAID_SIM), made unique in its table. Issued once and never changes. */
async function codeFor(q: Queryable, table: 'offer_types' | 'fulfilment_options', name: string): Promise<string> {
  const base = name.toUpperCase().normalize('NFKD').replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'ITEM';
  for (let i = 1; i < 100; i++) {
    const id = i === 1 ? base : `${base}_${i}`;
    if (!(await q.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id])).rows.length) return id;
  }
  throw conflict('could not issue a code');
}

// ───────────────────────── offer types ─────────────────────────
const TYPE_COLS = 'id, name, description, template, behaviour, status, sort_order, is_builtin';
const withEffective = (r: Row): OfferType => ({ ...(r as OfferType), effective: { ...switchesOf(TEMPLATES[r.template as OfferTemplate]), ...(r.behaviour ?? {}) } });
export async function getOfferType(q: Queryable, id: string): Promise<OfferType | null> {
  const r = (await q.query(`SELECT ${TYPE_COLS} FROM offer_types WHERE id=$1`, [id])).rows[0];
  return r ? withEffective(r) : null;
}
/** The offer types that can be picked in a step of the order wizard: those whose switches include it. */
export async function kindsForStep(q: Queryable, step: string): Promise<string[]> {
  if (!(ORDER_STEPS as readonly string[]).includes(step)) return [];
  return kindsWhere(q, (b) => b.steps.includes(step as OrderStep));
}
/** The offer types whose switches satisfy a test (for example: sold outright). */
export async function kindsWhere(q: Queryable, test: (b: BehaviourSwitches) => boolean): Promise<string[]> {
  return (await q.query(`SELECT ${TYPE_COLS} FROM offer_types`)).rows.map(withEffective).filter((t) => test(t.effective)).map((t) => t.id);
}

/** Checks a set of switches the way the order engine will need them: coherent, and any service kind it names exists and is on. */
async function checkSwitches(q: Queryable, b: BehaviourSwitches): Promise<void> {
  const problems = switchProblems(b);
  if (problems.length) throw invalid(problems.join(' '));
  if (b.service && !isBuiltinKind(b.service)) {
    const k = await getServiceKind(q, b.service);
    if (!k) throw invalid(`unknown service kind ${b.service}`);
    if (k.status !== 'ACTIVE') throw invalid(`the service kind ${k.name} is switched off`);
  } else if (b.service && !(await q.query('SELECT 1 FROM service_kinds WHERE id=$1', [b.service])).rows.length) throw invalid(`unknown service kind ${b.service}`);
}
const cleanSwitches = (v: Partial<BehaviourSwitches> | undefined, base: BehaviourSwitches): BehaviourSwitches => {
  const steps = (v?.steps ?? base.steps).filter((x, i, a) => a.indexOf(x) === i) as OrderStep[];
  return { service: v?.service === undefined ? base.service : v.service || null, serviceNeedsFee: v?.serviceNeedsFee ?? base.serviceNeedsFee, goods: v?.goods ?? base.goods, outright: v?.outright ?? base.outright, contract: v?.contract ?? base.contract, needsPartner: v?.needsPartner ?? base.needsPartner, needsInstallation: v?.needsInstallation ?? base.needsInstallation, steps, exclusive: v?.exclusive ?? base.exclusive };
};
export async function listOfferTypes(q: Queryable, o: { activeOnly?: boolean; withUsage?: boolean } = {}): Promise<Array<OfferType & { offers?: number }>> {
  const rows = (await q.query(`SELECT ${TYPE_COLS} FROM offer_types ${o.activeOnly ? `WHERE status='ACTIVE'` : ''} ORDER BY sort_order, name`)).rows.map(withEffective);
  if (!o.withUsage) return rows;
  const used = new Map((await q.query(`SELECT kind, count(*) AS n FROM catalog_nodes WHERE level='OFFER' GROUP BY kind`)).rows.map((r) => [r.kind as string, Number(r.n)]));
  return rows.map((r) => ({ ...r, offers: used.get(r.id) ?? 0 }));
}

export async function createOfferType(q: Queryable, actor: string, i: { name: string; description?: string; template: string; behaviour?: Partial<BehaviourSwitches> }): Promise<OfferType> {
  const name = text(i.name, 40, 'the name');
  if (!name) throw invalid('an offer type needs a name');
  if (!(OFFER_TEMPLATES as readonly string[]).includes(i.template)) throw invalid('choose what the new type behaves like: the preset it starts from');
  if ((await q.query('SELECT 1 FROM offer_types WHERE lower(name)=lower($1)', [name])).rows.length) throw conflict(`there is already an offer type called ${name}`);
  const preset = switchesOf(TEMPLATES[i.template as OfferTemplate]);
  const behaviour = i.behaviour ? cleanSwitches(i.behaviour, preset) : null;
  await checkSwitches(q, behaviour ?? preset);
  const id = await codeFor(q, 'offer_types', name);
  const order = Number((await q.query('SELECT COALESCE(max(sort_order),0) + 10 AS n FROM offer_types')).rows[0]!.n);
  await q.query(`INSERT INTO offer_types (id, name, description, template, behaviour, sort_order, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, name, text(i.description, 200, 'the description'), i.template, behaviour ? JSON.stringify(behaviour) : null, order, actor]);
  await audit(q, actor, 'offer_type', id, 'create', { name, template: i.template, behaviour });
  return (await getOfferType(q, id))!;
}

export async function updateOfferType(q: Queryable, actor: string, id: string, p: { name?: string; description?: string; status?: 'ACTIVE' | 'INACTIVE'; behaviour?: Partial<BehaviourSwitches> }): Promise<OfferType> {
  const cur = await getOfferType(q, id);
  if (!cur) throw notFound('offer type', id);
  const name = p.name === undefined ? cur.name : text(p.name, 40, 'the name');
  if (!name) throw invalid('an offer type needs a name');
  if (name.toLowerCase() !== cur.name.toLowerCase() && (await q.query('SELECT 1 FROM offer_types WHERE lower(name)=lower($1)', [name])).rows.length) throw conflict(`there is already an offer type called ${name}`);
  if (p.status === 'INACTIVE' && cur.status === 'ACTIVE' && Number((await q.query(`SELECT count(*) AS n FROM offer_types WHERE status='ACTIVE'`)).rows[0]!.n) <= 1) throw rejected('at least one offer type must stay switched on');
  let behaviour: BehaviourSwitches | null = cur.behaviour;
  let restamp = false;
  if (p.behaviour) {
    if (cur.isBuiltin) throw rejected('the built-in types keep their behaviour. Add a new type, starting from this one, to change it.');
    const next = cleanSwitches(p.behaviour, cur.effective);
    const changed = (Object.keys(next) as Array<keyof BehaviourSwitches>).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur.effective[k]));
    if (changed.length) {
      await checkSwitches(q, next);
      const offers = Number((await q.query(`SELECT count(*) AS n FROM catalog_nodes WHERE level='OFFER' AND kind=$1`, [id])).rows[0]!.n);
      // What an order creates cannot change under offers that already exist; where an offer is picked and whether only one fits an order can.
      const loose = changed.filter((k) => k !== 'steps' && k !== 'exclusive');
      if (offers && loose.length) throw rejected(`${offers} offer${offers === 1 ? ' uses' : 's use'} this type, so only where it is picked and “one per order” can change now. Add a new type for different behaviour.`);
      behaviour = next; restamp = offers > 0;
    }
  }
  await q.query('UPDATE offer_types SET name=$2, description=$3, status=$4, behaviour=$5, updated_at=now() WHERE id=$1', [id, name, p.description === undefined ? cur.description : text(p.description, 200, 'the description'), p.status ?? cur.status, behaviour ? JSON.stringify(behaviour) : null]);
  if (restamp && behaviour) await q.query(`UPDATE catalog_nodes SET data = jsonb_set(data, '{behaviour}', $2::jsonb) WHERE level='OFFER' AND kind=$1`, [id, JSON.stringify(behaviour)]);
  await audit(q, actor, 'offer_type', id, 'update', { ...p });
  return (await getOfferType(q, id))!;
}

/** A type that no offer uses and that was not built in can be removed; otherwise switch it off. */
export async function deleteOfferType(q: Queryable, actor: string, id: string): Promise<void> {
  const cur = (await q.query('SELECT is_builtin FROM offer_types WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound('offer type', id);
  if (cur.isBuiltin) throw rejected('built-in types cannot be removed. Switch it off instead.');
  const n = Number((await q.query(`SELECT count(*) AS n FROM catalog_nodes WHERE level='OFFER' AND kind=$1`, [id])).rows[0]!.n);
  if (n) throw rejected(`${n} offer${n === 1 ? ' uses' : 's use'} this type, so it cannot be removed. Switch it off instead: existing offers keep working.`);
  await q.query('DELETE FROM offer_types WHERE id=$1', [id]);
  await audit(q, actor, 'offer_type', id, 'delete', {});
}

/** Type ids behind a list that may mix type ids and behaviour templates ("every SIM + device kind"). Used by the sales screens' filters. */
export async function expandKinds(q: Queryable, tokens: string[]): Promise<string[]> {
  if (!tokens.length) return [];
  const rows = (await q.query('SELECT id FROM offer_types WHERE id = ANY($1::text[]) OR template = ANY($1::text[])', [tokens])).rows;
  return [...new Set([...tokens, ...rows.map((r) => r.id as string)])];
}

// ───────────────────────── fulfilment options ─────────────────────────
export async function listFulfilmentOptions(q: Queryable, o: { activeOnly?: boolean; withUsage?: boolean } = {}): Promise<Array<FulfilmentOption & { offers?: number }>> {
  const rows = (await q.query<FulfilmentOption & Row>(`SELECT id, name, description, mechanic, tracks_stock, status, sort_order, is_builtin FROM fulfilment_options ${o.activeOnly ? `WHERE status='ACTIVE'` : ''} ORDER BY sort_order, name`)).rows;
  if (!o.withUsage) return rows;
  return Promise.all(rows.map(async (r) => ({ ...r, offers: Number((await q.query(`SELECT count(*) AS n FROM catalog_nodes WHERE level='OFFER' AND data->'fulfilment'->'options' ? $1`, [r.id])).rows[0]!.n) })));
}

export async function createFulfilmentOption(q: Queryable, actor: string, i: { name: string; description?: string; mechanic: string; tracksStock?: boolean }): Promise<FulfilmentOption> {
  const name = text(i.name, 40, 'the name');
  if (!name) throw invalid('a fulfilment option needs a name');
  if (!FULFILMENT_MECHANICS.some((m) => m.id === i.mechanic)) throw invalid('choose how the new option works');
  if ((await q.query('SELECT 1 FROM fulfilment_options WHERE lower(name)=lower($1)', [name])).rows.length) throw conflict(`there is already an option called ${name}`);
  const id = await codeFor(q, 'fulfilment_options', name);
  const order = Number((await q.query('SELECT COALESCE(max(sort_order),0) + 10 AS n FROM fulfilment_options')).rows[0]!.n);
  await q.query(`INSERT INTO fulfilment_options (id, name, description, mechanic, tracks_stock, sort_order, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, name, text(i.description, 200, 'the description'), i.mechanic, !!i.tracksStock, order, actor]);
  await audit(q, actor, 'fulfilment_option', id, 'create', { name, mechanic: i.mechanic });
  return (await q.query<FulfilmentOption & Row>('SELECT id, name, description, mechanic, tracks_stock, status, sort_order, is_builtin FROM fulfilment_options WHERE id=$1', [id])).rows[0]!;
}

export async function updateFulfilmentOption(q: Queryable, actor: string, id: string, p: { name?: string; description?: string; tracksStock?: boolean; status?: 'ACTIVE' | 'INACTIVE' }): Promise<FulfilmentOption> {
  const cur = (await q.query<FulfilmentOption & Row>('SELECT id, name, description, mechanic, tracks_stock, status, sort_order, is_builtin FROM fulfilment_options WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound('fulfilment option', id);
  const name = p.name === undefined ? cur.name : text(p.name, 40, 'the name');
  if (!name) throw invalid('a fulfilment option needs a name');
  if (name.toLowerCase() !== cur.name.toLowerCase() && (await q.query('SELECT 1 FROM fulfilment_options WHERE lower(name)=lower($1)', [name])).rows.length) throw conflict(`there is already an option called ${name}`);
  await q.query('UPDATE fulfilment_options SET name=$2, description=$3, tracks_stock=$4, status=$5, updated_at=now() WHERE id=$1',
    [id, name, p.description === undefined ? cur.description : text(p.description, 200, 'the description'), p.tracksStock ?? cur.tracksStock, p.status ?? cur.status]);
  await audit(q, actor, 'fulfilment_option', id, 'update', { ...p });
  return (await q.query<FulfilmentOption & Row>('SELECT id, name, description, mechanic, tracks_stock, status, sort_order, is_builtin FROM fulfilment_options WHERE id=$1', [id])).rows[0]!;
}

export async function deleteFulfilmentOption(q: Queryable, actor: string, id: string): Promise<void> {
  const cur = (await q.query('SELECT is_builtin FROM fulfilment_options WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound('fulfilment option', id);
  if (cur.isBuiltin) throw rejected('built-in options cannot be removed. Switch it off instead.');
  const n = Number((await q.query(`SELECT count(*) AS n FROM catalog_nodes WHERE level='OFFER' AND data->'fulfilment'->'options' ? $1`, [id])).rows[0]!.n);
  if (n) throw rejected(`${n} offer${n === 1 ? ' uses' : 's use'} this option, so it cannot be removed. Switch it off instead.`);
  await q.query('DELETE FROM fulfilment_options WHERE id=$1', [id]);
  await audit(q, actor, 'fulfilment_option', id, 'delete', {});
}

// ───────────────────────── applying the configuration to an offer being saved ─────────────────────────
/**
 * Resolves what an offer is built on: its type (must exist, and be switched on unless the offer already had it) gives the behaviour template stored
 * on the offer; the chosen fulfilment options give the fulfilment flags the order engine uses (shipping, collection, installation, SIM).
 * Callers that pass only the flags (seeds, older clients) are left as they are.
 */
export async function prepareOffer<T extends { kind?: string; template?: string; fulfilment?: { requiresShipping?: boolean; requiresInstallation?: boolean; requiresSimActivation?: boolean; requiresCollection?: boolean; inventorySkus?: string[]; options?: string[] } }>(
  q: Queryable, o: T, was?: { kind?: string; options?: string[] },
): Promise<T> {
  const kind = o.kind ?? '';
  const type = await getOfferType(q, kind);
  if (!type) throw invalid(`unknown offer type ${kind}`);
  if (type.status !== 'ACTIVE' && was?.kind !== kind) throw invalid(`the offer type ${type.name} is switched off`);
  const out: T = { ...o, template: type.template, behaviour: type.effective } as T;
  const ids = o.fulfilment?.options;
  if (ids) {
    const unique = [...new Set(ids)];
    const rows = unique.length ? (await q.query('SELECT id, name, mechanic, status FROM fulfilment_options WHERE id = ANY($1::text[])', [unique])).rows : [];
    for (const id of unique) {
      const r = rows.find((x) => x.id === id);
      if (!r) throw invalid(`unknown fulfilment option ${id}`);
      if (r.status !== 'ACTIVE' && !(was?.options ?? []).includes(id)) throw invalid(`the fulfilment option ${r.name} is switched off`);
    }
    const has = (m: string) => rows.some((r) => r.mechanic === m);
    out.fulfilment = { ...o.fulfilment, options: unique, requiresShipping: has('SHIP'), requiresCollection: has('COLLECT'), requiresInstallation: has('INSTALL'), requiresSimActivation: has('SIM'), inventorySkus: o.fulfilment?.inventorySkus ?? [] };
  }
  // A service kind that expires: the offer may set its own length (a 7-day pass beside a 30-day pass); otherwise the kind's default applies.
  const sk = type.effective.service && !isBuiltinKind(type.effective.service) ? await getServiceKind(q, type.effective.service) : null;
  const days = (o as { validityDays?: number }).validityDays;
  if (sk?.expires) { if (days != null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw invalid('the validity is 1 to 3650 days'); } else delete (out as { validityDays?: number }).validityDays;
  // How the charging system knows this plan. Only an offer that starts a service can have one.
  const mapping = cleanOcsMapping((o as { ocs?: unknown }).ocs);
  if (mapping && type.effective.service == null) throw invalid('Only an offer that starts a service can have an OCS plan code.');
  if (mapping) (out as { ocs?: unknown }).ocs = mapping; else delete (out as { ocs?: unknown }).ocs;
  if (type.effective.needsInstallation && out.fulfilment && !out.fulfilment.requiresInstallation && ids) {
    throw invalid('fibre offers need an installation option');
  }
  return out;
}
