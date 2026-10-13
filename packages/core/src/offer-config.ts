import { FULFILMENT_MECHANICS, OFFER_TEMPLATES, TEMPLATES, type FulfilmentMechanic, type OfferTemplate } from '@meridian/types';
import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';

/**
 * Catalog configuration: the offer types and fulfilment options an operator maintains in Settings → Catalog.
 * What a type or option does comes from its behaviour template / mechanic (fixed in code), so renaming or adding one can never leave the
 * platform not knowing how to sell, fulfil or bill it. The template and mechanic of an existing row never change.
 */
export interface OfferType { id: string; name: string; description: string | null; template: OfferTemplate; status: 'ACTIVE' | 'INACTIVE'; sortOrder: number; isBuiltin: boolean }
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
export async function listOfferTypes(q: Queryable, o: { activeOnly?: boolean; withUsage?: boolean } = {}): Promise<Array<OfferType & { offers?: number }>> {
  const rows = (await q.query<OfferType & Row>(`SELECT id, name, description, template, status, sort_order, is_builtin FROM offer_types ${o.activeOnly ? `WHERE status='ACTIVE'` : ''} ORDER BY sort_order, name`)).rows;
  if (!o.withUsage) return rows;
  const used = new Map((await q.query(`SELECT kind, count(*) AS n FROM catalog_nodes WHERE level='OFFER' GROUP BY kind`)).rows.map((r) => [r.kind as string, Number(r.n)]));
  return rows.map((r) => ({ ...r, offers: used.get(r.id) ?? 0 }));
}

export async function createOfferType(q: Queryable, actor: string, i: { name: string; description?: string; template: string }): Promise<OfferType> {
  const name = text(i.name, 40, 'the name');
  if (!name) throw invalid('an offer type needs a name');
  if (!(OFFER_TEMPLATES as readonly string[]).includes(i.template)) throw invalid('choose what the new type behaves like');
  if ((await q.query('SELECT 1 FROM offer_types WHERE lower(name)=lower($1)', [name])).rows.length) throw conflict(`there is already an offer type called ${name}`);
  const id = await codeFor(q, 'offer_types', name);
  const order = Number((await q.query('SELECT COALESCE(max(sort_order),0) + 10 AS n FROM offer_types')).rows[0]!.n);
  await q.query(`INSERT INTO offer_types (id, name, description, template, sort_order, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, name, text(i.description, 200, 'the description'), i.template, order, actor]);
  await audit(q, actor, 'offer_type', id, 'create', { name, template: i.template });
  return (await q.query<OfferType & Row>('SELECT id, name, description, template, status, sort_order, is_builtin FROM offer_types WHERE id=$1', [id])).rows[0]!;
}

export async function updateOfferType(q: Queryable, actor: string, id: string, p: { name?: string; description?: string; status?: 'ACTIVE' | 'INACTIVE' }): Promise<OfferType> {
  const cur = (await q.query<OfferType & Row>('SELECT id, name, description, template, status, sort_order, is_builtin FROM offer_types WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound('offer type', id);
  const name = p.name === undefined ? cur.name : text(p.name, 40, 'the name');
  if (!name) throw invalid('an offer type needs a name');
  if (name.toLowerCase() !== cur.name.toLowerCase() && (await q.query('SELECT 1 FROM offer_types WHERE lower(name)=lower($1)', [name])).rows.length) throw conflict(`there is already an offer type called ${name}`);
  if (p.status === 'INACTIVE' && cur.status === 'ACTIVE' && Number((await q.query(`SELECT count(*) AS n FROM offer_types WHERE status='ACTIVE'`)).rows[0]!.n) <= 1) throw rejected('at least one offer type must stay switched on');
  await q.query('UPDATE offer_types SET name=$2, description=$3, status=$4, updated_at=now() WHERE id=$1', [id, name, p.description === undefined ? cur.description : text(p.description, 200, 'the description'), p.status ?? cur.status]);
  await audit(q, actor, 'offer_type', id, 'update', { ...p });
  return (await q.query<OfferType & Row>('SELECT id, name, description, template, status, sort_order, is_builtin FROM offer_types WHERE id=$1', [id])).rows[0]!;
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
  const type = (await q.query('SELECT id, name, template, status FROM offer_types WHERE id=$1', [kind])).rows[0];
  if (!type) throw invalid(`unknown offer type ${kind}`);
  if (type.status !== 'ACTIVE' && was?.kind !== kind) throw invalid(`the offer type ${type.name} is switched off`);
  const out: T = { ...o, template: type.template };
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
  if (TEMPLATES[type.template as OfferTemplate].needsInstallation && out.fulfilment && !out.fulfilment.requiresInstallation && ids) {
    throw invalid('fibre offers need an installation option');
  }
  return out;
}
