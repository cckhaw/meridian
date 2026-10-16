import { randomUUID } from 'node:crypto';
import { importAgents, importDealers, importStores } from '../bulk-import.js';
import { createNode } from '../catalog.js';
import { csvCell } from '../csv.js';
import { GL } from '../config.js';
import type { Db, Queryable } from '../db.js';
import { hashIdDocument, maskIdDocument } from '../customers.js';
import { postJournal } from '../ledger.js';
import { defaultCycleDay, getBillCycles } from '../customer-config.js';
import { getMarketSettings, marketDuplicates, marketFor } from '../settings.js';
import { importOffers } from '../offer-import.js';
import { importStock } from '../inventory-import.js';
import { getMatcher } from '../nrm.js';
import { shardFor } from '../shard.js';
import { importFields } from './entities.js';
import { entityById } from './entities.js';
import type { Rec } from './types.js';

/**
 * One importer per loadable record type. An importer is given a batch of clean records and answers for each: loaded, skipped (it is already there) or a problem.
 * The same code runs for the check and for the load (`write`): the check looks up everything and changes nothing, so what the check says is what the load will do.
 * Whatever a load creates is remembered in migration_refs against the key the record had in the old system, so other files can point at it, a second run does not
 * duplicate it, and a job's own records can be taken out again.
 */
export interface BatchRow { line: number; rec: Rec; /** the raw cells and header, for importers that reuse a screen's own CSV loader */ cells?: string[] }
export interface RowResult { status: 'OK' | 'ERROR' | 'SKIPPED'; message?: string; field?: string; code?: string }
export interface ImportCtx { db: Db; q: Queryable; jobId: string; actor: string; write: boolean; header: string[] | null }
export interface Importer {
  /** Records per batch (each batch is one transaction). */
  batch: number;
  /** Runs outside the batch transaction (it opens its own): the importer reuses a screen's loader. */
  raw?: boolean;
  /** Takes the raw cells and the header instead of cleaned records. */
  cellsOnly?: boolean;
  /** Can what a load created be taken out again? */
  undo?: (q: Queryable, jobId: string, limit: number) => Promise<number>;
  run(ctx: ImportCtx, rows: BatchRow[]): Promise<RowResult[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (message: string, field?: string, code = 'INVALID'): RowResult => ({ status: 'ERROR', message, field, code });
const OK: RowResult = { status: 'OK' };
const skip = (message: string): RowResult => ({ status: 'SKIPPED', message, code: 'ALREADY_LOADED' });
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const label = (id: string) => 'c_' + id.replaceAll('-', '_');
const today = () => new Date().toISOString().slice(0, 10);

// ───────────────────────── references ─────────────────────────
/** old key → internal id, for keys that earlier loads created. */
async function refMap(q: Queryable, entity: string, refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = [...new Set(refs.filter(Boolean))];
  if (!want.length) return out;
  for (const r of (await q.query('SELECT ref, internal_id FROM migration_refs WHERE entity=$1 AND ref = ANY($2::text[])', [entity, want])).rows) out.set(r.ref, r.internalId);
  return out;
}
/** Keys already seen earlier in this job's file (checking pass only). */
async function seenKeys(ctx: ImportCtx, entity: string, refs: string[]): Promise<Set<string>> {
  if (ctx.write || !refs.length) return new Set();
  const keys = refs.map((r) => `${entity}:${r}`);
  return new Set((await ctx.q.query('SELECT key FROM migration_keys WHERE job_id=$1 AND key = ANY($2::text[])', [ctx.jobId, keys])).rows.map((r) => r.key as string));
}
/** Remembers what a batch loaded (load), or the keys it saw (check). */
async function remember(ctx: ImportCtx, entity: string, items: Array<{ ref: string; id: string }>): Promise<void> {
  if (!items.length) return;
  if (ctx.write) await ctx.q.query(`INSERT INTO migration_refs (entity, ref, internal_id, job_id) SELECT $1, r, i, $2 FROM unnest($3::text[], $4::text[]) AS t(r, i) ON CONFLICT (entity, ref) DO NOTHING`, [entity, ctx.jobId, items.map((x) => x.ref), items.map((x) => x.id)]);
  else await ctx.q.query('INSERT INTO migration_keys (job_id, key) SELECT $1, k FROM unnest($2::text[]) AS k ON CONFLICT DO NOTHING', [ctx.jobId, items.map((x) => `${entity}:${x.ref}`)]);
}
async function keyNote(ctx: ImportCtx, extra: string[]): Promise<void> {
  if (!ctx.write && extra.length) await ctx.q.query('INSERT INTO migration_keys (job_id, key) SELECT $1, k FROM unnest($2::text[]) AS k ON CONFLICT DO NOTHING', [ctx.jobId, extra]);
}

/** INSERT … SELECT FROM unnest(arrays): one statement for the whole batch. */
interface Col { n: string; t: string; v: unknown[]; expr?: string }
async function bulk(q: Queryable, table: string, cols: Col[], tail = ''): Promise<number> {
  const names = cols.map((c) => c.n).join(', ');
  const sel = cols.map((c) => c.expr ?? `t.${c.n}`).join(', ');
  const un = cols.map((c, i) => `$${i + 1}::${c.t}[]`).join(', ');
  return (await q.query(`INSERT INTO ${table} (${names}) SELECT ${sel} FROM unnest(${un}) AS t(${names}) ${tail}`, cols.map((c) => c.v))).rowCount;
}
const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
const opt = (v: unknown) => (v === undefined ? null : v);

/** Undo by deleting rows a job created, keyed through migration_refs. */
async function createdIds(q: Queryable, entity: string, jobId: string, limit: number): Promise<Array<{ ref: string; id: string }>> {
  return (await q.query('SELECT ref, internal_id AS id FROM migration_refs WHERE entity=$1 AND job_id=$2 AND created ORDER BY ref LIMIT $3', [entity, jobId, limit])).rows as Array<{ ref: string; id: string }>;
}
const forget = (q: Queryable, entity: string, refs: string[]) => q.query('DELETE FROM migration_refs WHERE entity=$1 AND ref = ANY($2::text[])', [entity, refs]);

// ───────────────────────── customers ─────────────────────────
const customers: Importer = {
  batch: 500,
  async run(ctx, rows) {
    const q = ctx.q;
    const out: RowResult[] = rows.map(() => OK);
    const refs = rows.map((r) => str(r.rec.id));
    const parentRefs = rows.map((r) => str(r.rec.parent_customer_id));
    const existing = await refMap(q, 'customers', [...refs, ...parentRefs]);
    const seen = await seenKeys(ctx, 'customers', [...refs, ...parentRefs]);
    const hashSeen = await seenKeys(ctx, 'customers#hash', rows.map((r) => (r.rec.id_document ? hashIdDocument(str(r.rec.id_document)) : str(r.rec.id_document_hash))).filter(Boolean));
    const segs = new Map((await q.query('SELECT id, individual, status FROM customer_segments')).rows.map((s) => [s.id as string, s]));
    const ms = await getMarketSettings(q);
    const parentIds = [...new Set(parentRefs.map((p) => existing.get(p) ?? (UUID.test(p) ? p.toLowerCase() : '')).filter(Boolean))];
    const parentPath = new Map<string, string>((parentIds.length ? (await q.query('SELECT id, hierarchy_path FROM customers WHERE id = ANY($1::uuid[])', [parentIds])).rows : []).map((p) => [p.id as string, p.hierarchyPath as string]));
    const uuidKeys = refs.filter((r) => UUID.test(r)).map((r) => r.toLowerCase());
    const taken = new Set((uuidKeys.length ? (await q.query('SELECT id FROM customers WHERE id = ANY($1::uuid[])', [uuidKeys])).rows : []).map((r) => r.id as string));
    const hashes = rows.map((r) => (r.rec.id_document ? hashIdDocument(str(r.rec.id_document)) : str(r.rec.id_document_hash))).filter(Boolean);
    const dupRows = hashes.length ? (await q.query('SELECT id_document_hash AS h, market_code AS m FROM customers WHERE id_document_hash = ANY($1::text[])', [hashes])).rows : [];

    const batch = new Map<string, { id: string; path: string }>();
    const batchHash = new Set<string>();
    const ins: Array<Record<string, unknown>> = [];
    for (const [i, row] of rows.entries()) {
      const r = row.rec, ref = refs[i]!;
      if (existing.has(ref)) { out[i] = skip(`Customer ${ref} was loaded earlier.`); continue; }
      if (batch.has(ref) || seen.has(`customers:${ref}`)) { out[i] = err(`The key ${ref} appears more than once in the file.`, 'id', 'DUPLICATE_KEY'); continue; }
      const seg = segs.get(str(r.segment));
      if (!seg) { out[i] = err(`There is no customer segment “${str(r.segment)}”. Create it in Settings first.`, 'segment', 'UNKNOWN_REFERENCE'); continue; }
      if (seg.status !== 'ACTIVE') { out[i] = err(`The segment ${str(r.segment)} is not active.`, 'segment', 'INACTIVE_REFERENCE'); continue; }
      const market = str(r.market_code) || ms.defaultMarket;
      if (!ms.markets.some((m) => m.code === market)) { out[i] = err(`Market ${market} is not set up in Settings.`, 'market_code', 'UNKNOWN_REFERENCE'); continue; }
      let hash = '', docRef = '';
      if (r.id_document) { hash = hashIdDocument(str(r.id_document)); docRef = maskIdDocument(str(r.id_document)); }
      else if (r.id_document_hash) { hash = str(r.id_document_hash); docRef = str(r.id_document_ref) || '(restored)'; }
      else if (seg.individual) { out[i] = err('An individual customer needs id_document (or id_document_hash when restoring an export).', 'id_document', 'REQUIRED'); continue; }
      else docRef = str(r.id_document_ref) || '-';
      if (hash && seg.individual) {
        const dupMarket = await marketDuplicates(q, market);
        if (dupRows.some((d) => d.h === hash && (dupMarket === null || d.m === dupMarket)) || batchHash.has(hash) || hashSeen.has(`customers#hash:${hash}`)) { out[i] = err('Another customer already has this ID document.', 'id_document', 'DUPLICATE_CUSTOMER'); continue; }
      }
      const id = UUID.test(ref) ? ref.toLowerCase() : randomUUID();
      if (taken.has(id)) { out[i] = err(`A customer with the id ${ref} already exists.`, 'id', 'DUPLICATE_KEY'); continue; }
      let path = label(id), parentId: string | null = null;
      const pref = parentRefs[i]!;
      if (pref) {
        if (pref === ref) { out[i] = err('A customer cannot be its own parent.', 'parent_customer_id', 'INVALID'); continue; }
        const inBatch = batch.get(pref);
        if (inBatch) { parentId = inBatch.id; path = `${inBatch.path}.${label(id)}`; }
        else if (existing.has(pref) || UUID.test(pref)) {
          parentId = existing.get(pref) ?? pref.toLowerCase();
          const pp = parentPath.get(parentId);
          if (!pp) { out[i] = err(`The parent customer ${pref} does not exist. Load parents before departments.`, 'parent_customer_id', 'UNKNOWN_REFERENCE'); continue; }
          path = `${pp}.${label(id)}`;
        } else if (seen.has(`customers:${pref}`)) { parentId = '00000000-0000-0000-0000-000000000000'; } // checking pass: the parent is earlier in this file
        else { out[i] = err(`The parent customer ${pref} was not found. Load parents before departments (earlier in this file, or in an earlier load).`, 'parent_customer_id', 'UNKNOWN_REFERENCE'); continue; }
      }
      batch.set(ref, { id, path });
      if (hash && seg.individual) batchHash.add(hash);
      ins.push({ ref, id, shard: shardFor(id), segment: str(r.segment), name: str(r.display_name), docRef, hash: hash || null, market, parent: parentId, path, email: opt(r.email), phone: opt(r.phone), status: str(r.status) || 'ACTIVE', kyc: str(r.kyc_status) || 'NOT_VERIFIED', kycAt: opt(r.kyc_verified_at), dob: opt(r.date_of_birth), gender: opt(r.gender), address: json(r.address), vipFlag: r.vip === true, risk: str(r.credit_risk) || 'NORMAL', createdAt: opt(r.created_at) });
    }
    if (ctx.write && ins.length) {
      const c = (k: string) => ins.map((x) => x[k]);
      await bulk(q, 'customers', [
        { n: 'id', t: 'uuid', v: c('id') }, { n: 'shard_id', t: 'smallint', v: c('shard') }, { n: 'segment', t: 'text', v: c('segment') }, { n: 'display_name', t: 'text', v: c('name') },
        { n: 'id_document_ref', t: 'text', v: c('docRef') }, { n: 'id_document_hash', t: 'text', v: c('hash') }, { n: 'market_code', t: 'text', v: c('market') }, { n: 'parent_customer_id', t: 'uuid', v: c('parent') },
        { n: 'hierarchy_path', t: 'text', v: c('path'), expr: 't.hierarchy_path::ltree' }, { n: 'email', t: 'text', v: c('email') }, { n: 'phone', t: 'text', v: c('phone') }, { n: 'status', t: 'text', v: c('status') },
        { n: 'kyc_status', t: 'text', v: c('kyc') }, { n: 'kyc_verified_at', t: 'timestamptz', v: c('kycAt') }, { n: 'date_of_birth', t: 'date', v: c('dob') }, { n: 'gender', t: 'text', v: c('gender') },
        { n: 'address', t: 'text', v: c('address'), expr: 't.address::jsonb' }, { n: 'vip', t: 'boolean', v: c('vipFlag') }, { n: 'credit_risk', t: 'text', v: c('risk') },
        { n: 'created_at', t: 'timestamptz', v: c('createdAt'), expr: 'COALESCE(t.created_at, now())' },
      ]);
    }
    await remember(ctx, 'customers', ins.map((x) => ({ ref: x.ref as string, id: x.id as string })));
    await keyNote(ctx, ins.filter((x) => x.hash).map((x) => `customers#hash:${x.hash}`));
    return out;
  },
  async undo(q, jobId, limit) {
    const ids = await createdIds(q, 'customers', jobId, limit);
    if (!ids.length) return 0;
    // Deepest departments first is not needed: nothing references a customer by a foreign key, and the whole batch goes together.
    await q.query('DELETE FROM customers WHERE id = ANY($1::uuid[])', [ids.map((x) => x.id)]);
    await forget(q, 'customers', ids.map((x) => x.ref));
    return ids.length;
  },
};

// ───────────────────────── accounts ─────────────────────────
const accounts: Importer = {
  batch: 500,
  async run(ctx, rows) {
    const q = ctx.q;
    const out: RowResult[] = rows.map(() => OK);
    const refs = rows.map((r) => str(r.rec.id));
    const custRefs = rows.map((r) => str(r.rec.customer_id));
    const payerRefs = rows.map((r) => str(r.rec.payer_account_id));
    const existing = await refMap(q, 'accounts', [...refs, ...payerRefs]);
    const seen = await seenKeys(ctx, 'accounts', [...refs, ...payerRefs]);
    const custMap = await refMap(q, 'customers', custRefs);
    const custIds = [...new Set(custRefs.map((c) => custMap.get(c) ?? (UUID.test(c) ? c.toLowerCase() : '')).filter(Boolean))];
    const custRows = new Map((custIds.length ? (await q.query('SELECT id, shard_id, market_code FROM customers WHERE id = ANY($1::uuid[])', [custIds])).rows : []).map((c) => [c.id as string, c]));
    const uuidKeys = refs.filter((r) => UUID.test(r)).map((r) => r.toLowerCase());
    const taken = new Set((uuidKeys.length ? (await q.query('SELECT id FROM accounts WHERE id = ANY($1::uuid[])', [uuidKeys])).rows : []).map((r) => r.id as string));
    const payerMap = new Map<string, string>(); // payer key -> id
    const dayOfDefault = defaultCycleDay(await getBillCycles(q));
    const batch = new Map<string, string>();
    const ins: Array<Record<string, unknown>> = [];
    for (const [i, row] of rows.entries()) {
      const r = row.rec, ref = refs[i]!;
      if (existing.has(ref)) { out[i] = skip(`Account ${ref} was loaded earlier.`); continue; }
      if (batch.has(ref) || seen.has(`accounts:${ref}`)) { out[i] = err(`The key ${ref} appears more than once in the file.`, 'id', 'DUPLICATE_KEY'); continue; }
      const cref = custRefs[i]!;
      const cid = custMap.get(cref) ?? (UUID.test(cref) ? cref.toLowerCase() : '');
      const cust = cid ? custRows.get(cid) : undefined;
      if (!cust) { out[i] = err(`The customer ${cref} was not found. Load customers first.`, 'customer_id', 'UNKNOWN_REFERENCE'); continue; }
      const id = UUID.test(ref) ? ref.toLowerCase() : randomUUID();
      if (taken.has(id)) { out[i] = err(`An account with the id ${ref} already exists.`, 'id', 'DUPLICATE_KEY'); continue; }
      const cur = str(r.currency) || (await marketFor(q, cust.marketCode)).currency;
      const day = str(r.bill_cycle_day);
      const pref = payerRefs[i]!;
      let payer: string | null = null;
      if (pref) {
        if (pref === ref) { out[i] = err('An account cannot pay for itself under another name; leave payer_account_id empty.', 'payer_account_id', 'INVALID'); continue; }
        const pid = batch.get(pref) ?? existing.get(pref) ?? (UUID.test(pref) ? pref.toLowerCase() : undefined);
        if (pid) payer = pid; else if (seen.has(`accounts:${pref}`)) payer = '00000000-0000-0000-0000-000000000000'; else { out[i] = err(`The paying account ${pref} was not found. List the paying account before the accounts it pays for.`, 'payer_account_id', 'UNKNOWN_REFERENCE'); continue; }
      }
      const credit = str(r.credit_state) || 'OK';
      if (!['OK', 'WARNED', 'BLOCKED'].includes(credit)) { out[i] = err('credit_state is OK, WARNED or BLOCKED.', 'credit_state', 'BAD_VALUE'); continue; }
      const stage = r.dunning_stage === undefined ? 0 : Number(r.dunning_stage);
      if (stage < 0 || stage > 5) { out[i] = err('dunning_stage is 0 to 5.', 'dunning_stage', 'BAD_VALUE'); continue; }
      batch.set(ref, id); payerMap.set(ref, id);
      ins.push({ ref, id, shard: cust.shardId, customer: cid, name: str(r.name) || 'Main account', day: day === 'DAILY' ? null : day ? Number(day) : dayOfDefault, status: str(r.status) || 'ACTIVE', currency: cur, payer, limit: opt(r.credit_limit_minor), deposit: r.deposit_minor ?? 0, credit, stage, createdAt: opt(r.created_at) });
    }
    if (ctx.write && ins.length) {
      const c = (k: string) => ins.map((x) => x[k]);
      await bulk(q, 'accounts', [
        { n: 'id', t: 'uuid', v: c('id') }, { n: 'shard_id', t: 'smallint', v: c('shard') }, { n: 'customer_id', t: 'uuid', v: c('customer') }, { n: 'name', t: 'text', v: c('name') },
        { n: 'bill_cycle_day', t: 'smallint', v: c('day') }, { n: 'status', t: 'text', v: c('status'), expr: 't.status::account_status' }, { n: 'currency', t: 'text', v: c('currency') },
        { n: 'payer_account_id', t: 'uuid', v: c('payer') }, { n: 'credit_limit_minor', t: 'bigint', v: c('limit') }, { n: 'deposit_minor', t: 'bigint', v: c('deposit') },
        { n: 'credit_state', t: 'text', v: c('credit') }, { n: 'dunning_stage', t: 'smallint', v: c('stage') }, { n: 'created_at', t: 'timestamptz', v: c('createdAt'), expr: 'COALESCE(t.created_at, now())' },
      ]);
    }
    await remember(ctx, 'accounts', ins.map((x) => ({ ref: x.ref as string, id: x.id as string })));
    return out;
  },
  async undo(q, jobId, limit) {
    const ids = await createdIds(q, 'accounts', jobId, limit);
    if (!ids.length) return 0;
    const used = (await q.query('SELECT DISTINCT account_id FROM services WHERE account_id = ANY($1::uuid[]) LIMIT 1', [ids.map((x) => x.id)])).rows.length + (await q.query('SELECT 1 FROM invoices WHERE account_id = ANY($1::uuid[]) AND kind <> \'OPENING\' LIMIT 1', [ids.map((x) => x.id)])).rows.length;
    if (used) throw new Error('Some of these accounts now have services or invoices. Take those loads out first.');
    await q.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [ids.map((x) => x.id)]);
    await forget(q, 'accounts', ids.map((x) => x.ref));
    return ids.length;
  },
};

// ───────────────────────── services ─────────────────────────
const TERMINAL = new Set(['TERMINATED']);
const services: Importer = {
  batch: 500,
  async run(ctx, rows) {
    const q = ctx.q;
    const out: RowResult[] = rows.map(() => OK);
    const refs = rows.map((r) => str(r.rec.id));
    const existing = await refMap(q, 'services', refs);
    const seen = await seenKeys(ctx, 'services', refs);
    const acctRefs = rows.map((r) => str(r.rec.account_id));
    const acctMap = await refMap(q, 'accounts', acctRefs);
    const acctIds = [...new Set(acctRefs.map((a) => acctMap.get(a) ?? (UUID.test(a) ? a.toLowerCase() : '')).filter(Boolean))];
    const acctRows = new Map((acctIds.length ? (await q.query('SELECT id, shard_id, customer_id, status FROM accounts WHERE id = ANY($1::uuid[])', [acctIds])).rows : []).map((a) => [a.id as string, a]));
    const offerIds = [...new Set(rows.map((r) => str(r.rec.offer_id)))];
    const offers = new Set((await q.query(`SELECT id FROM catalog_nodes WHERE level='OFFER' AND id = ANY($1::text[])`, [offerIds])).rows.map((o) => o.id as string));
    const kinds = new Set((await q.query('SELECT id FROM service_kinds')).rows.map((k) => k.id as string));
    const uuidKeys = refs.filter((r) => UUID.test(r)).map((r) => r.toLowerCase());
    const taken = new Set((uuidKeys.length ? (await q.query('SELECT id FROM services WHERE id = ANY($1::uuid[])', [uuidKeys])).rows : []).map((r) => r.id as string));
    const identKeys = rows.map((r) => `services#ident:${str(r.rec.type)}:${str(r.rec.identifier)}`);
    const identSeen = await seenKeys(ctx, 'services#ident', rows.map((r) => `${str(r.rec.type)}:${str(r.rec.identifier)}`));

    // Which numbers are already taken: in the services table of the account's shard, or in the platform-wide registry.
    const probe = rows.map((r, i) => ({ i, a: acctRows.get(acctMap.get(acctRefs[i]!) ?? acctRefs[i]!.toLowerCase()) })).filter((x) => x.a);
    const dupSvc = new Set<string>();
    if (probe.length) {
      for (const d of (await q.query(`SELECT s.type::text AS type, s.identifier FROM services s JOIN unnest($1::smallint[], $2::text[], $3::text[]) u(sh, ty, idf) ON s.shard_id = u.sh AND s.type = u.ty::service_type AND s.identifier = u.idf`,
        [probe.map((p) => p.a!.shardId), probe.map((p) => str(rows[p.i]!.rec.type)), probe.map((p) => str(rows[p.i]!.rec.identifier))])).rows) dupSvc.add(`${d.type}:${d.identifier}`);
    }
    const dupReg = new Set((await q.query('SELECT r.type, r.identifier FROM identifier_registry r JOIN unnest($1::text[], $2::text[]) u(ty, idf) ON r.type = u.ty AND r.identifier = u.idf', [rows.map((r) => str(r.rec.type)), rows.map((r) => str(r.rec.identifier))])).rows.map((d) => `${d.type}:${d.identifier}`));

    const parentRefs = rows.map((r) => str(r.rec.parent_service_id));
    const parentMap = await refMap(q, 'services', parentRefs);
    const parentSeen = await seenKeys(ctx, 'services', parentRefs);
    const batch = new Set<string>(), batchIdent = new Set<string>();
    const ins: Array<Record<string, any>> = [];
    for (const [i, row] of rows.entries()) {
      const r = row.rec, ref = refs[i]!;
      if (existing.has(ref)) { out[i] = skip(`Service ${ref} was loaded earlier.`); continue; }
      if (batch.has(ref) || seen.has(`services:${ref}`)) { out[i] = err(`The key ${ref} appears more than once in the file.`, 'id', 'DUPLICATE_KEY'); continue; }
      const aid = acctMap.get(acctRefs[i]!) ?? (UUID.test(acctRefs[i]!) ? acctRefs[i]!.toLowerCase() : '');
      const acct = aid ? acctRows.get(aid) : undefined;
      if (!acct) { out[i] = err(`The account ${acctRefs[i]} was not found. Load accounts first.`, 'account_id', 'UNKNOWN_REFERENCE'); continue; }
      const type = str(r.type), ident = str(r.identifier), status = str(r.status);
      if (!offers.has(str(r.offer_id))) { out[i] = err(`The offer ${str(r.offer_id)} is not in the catalog. Load the catalog first.`, 'offer_id', 'UNKNOWN_REFERENCE'); continue; }
      if (type === 'MOBILE' && !/^\+\d{8,15}$/.test(ident)) { out[i] = err(`A mobile number is in international form, such as +6591234567 (it is “${ident}”).`, 'identifier', 'BAD_FORMAT'); continue; }
      if (r.service_kind && !kinds.has(str(r.service_kind))) { out[i] = err(`There is no service type “${str(r.service_kind)}”.`, 'service_kind', 'UNKNOWN_REFERENCE'); continue; }
      if (status === 'TERMINATED' && !r.terminated_at) { out[i] = err('A terminated service needs terminated_at.', 'terminated_at', 'REQUIRED'); continue; }
      const idk = `${type}:${ident}`;
      if (batchIdent.has(idk) || identSeen.has(`services#ident:${idk}`)) { out[i] = err(`${ident} appears on more than one service in this file. Keep only the current holder of a number.`, 'identifier', 'DUPLICATE_IDENTIFIER'); continue; }
      if (dupSvc.has(idk) || (!TERMINAL.has(status) && dupReg.has(idk))) { out[i] = err(`${ident} is already in use by another service.`, 'identifier', 'DUPLICATE_IDENTIFIER'); continue; }
      const id = UUID.test(ref) ? ref.toLowerCase() : randomUUID();
      if (taken.has(id)) { out[i] = err(`A service with the id ${ref} already exists.`, 'id', 'DUPLICATE_KEY'); continue; }
      const pref = parentRefs[i]!;
      if (pref && pref !== ref && !parentMap.has(pref) && !batch.has(pref) && !parentSeen.has(`services:${pref}`)) { out[i] = err(`The parent service ${pref} was not found. List the mobile service before the value-added services that belong to it.`, 'parent_service_id', 'UNKNOWN_REFERENCE'); continue; }
      if (pref === ref) { out[i] = err('A service cannot be its own parent.', 'parent_service_id', 'INVALID'); continue; }
      batch.add(ref); batchIdent.add(idk);
      ins.push({ ref, id, shard: acct.shardId, account: aid, customer: acct.customerId, type, ident, iccid: opt(r.iccid), offer: str(r.offer_id), status, contractStart: opt(r.contract_start), term: opt(r.contract_term_months), activatedAt: opt(r.activated_at),
        terminatedAt: opt(r.terminated_at), termReason: opt(r.terminated_reason), suspReason: opt(r.suspended_reason), susKind: status === 'SUSPENDED' ? str(r.suspension_kind) || 'ADMIN' : null, suspAt: status === 'SUSPENDED' ? opt(r.suspended_at) ?? new Date().toISOString() : null, suspUntil: opt(r.suspend_until), bar: str(r.bar_level) || 'NONE', imsi: opt(r.imsi), vip: opt(r.vip_tier), vipEtc: opt(r.vip_etc_bps),
        numStatus: opt(r.number_status), parentRef: pref || null, swapped: opt(r.sim_swapped_at), deal: json(r.deal), kind: opt(r.service_kind), expires: opt(r.expires_at), createdAt: opt(r.created_at) });
    }
    if (ctx.write && ins.length) {
      const c = (k: string) => ins.map((x) => x[k]);
      await bulk(q, 'services', [
        { n: 'id', t: 'uuid', v: c('id') }, { n: 'shard_id', t: 'smallint', v: c('shard') }, { n: 'account_id', t: 'uuid', v: c('account') }, { n: 'customer_id', t: 'uuid', v: c('customer') },
        { n: 'type', t: 'text', v: c('type'), expr: 't.type::service_type' }, { n: 'identifier', t: 'text', v: c('ident') }, { n: 'iccid', t: 'text', v: c('iccid') }, { n: 'offer_id', t: 'text', v: c('offer') },
        { n: 'status', t: 'text', v: c('status'), expr: 't.status::service_status' }, { n: 'contract_start', t: 'timestamptz', v: c('contractStart') }, { n: 'contract_term_months', t: 'smallint', v: c('term') },
        { n: 'activated_at', t: 'timestamptz', v: c('activatedAt') }, { n: 'terminated_at', t: 'timestamptz', v: c('terminatedAt') }, { n: 'terminated_reason', t: 'text', v: c('termReason') },
        { n: 'suspended_reason', t: 'text', v: c('suspReason') }, { n: 'suspension_kind', t: 'text', v: c('susKind') }, { n: 'suspended_at', t: 'timestamptz', v: c('suspAt') }, { n: 'suspend_until', t: 'date', v: c('suspUntil') },
        { n: 'vip_etc_bps', t: 'integer', v: c('vipEtc') }, { n: 'number_status', t: 'text', v: c('numStatus') }, { n: 'sim_swapped_at', t: 'timestamptz', v: c('swapped') }, { n: 'deal', t: 'text', v: c('deal'), expr: 't.deal::jsonb' },
        { n: 'bar_level', t: 'text', v: c('bar') }, { n: 'imsi', t: 'text', v: c('imsi') }, { n: 'vip_tier', t: 'text', v: c('vip') }, { n: 'service_kind', t: 'text', v: c('kind') },
        { n: 'expires_at', t: 'timestamptz', v: c('expires') }, { n: 'created_at', t: 'timestamptz', v: c('createdAt'), expr: 'COALESCE(t.created_at, now())' },
      ]);
      const live = ins.filter((x) => x.status !== 'TERMINATED');
      if (live.length) {
        await bulk(q, 'identifier_registry', [{ n: 'type', t: 'text', v: live.map((x) => x.type) }, { n: 'identifier', t: 'text', v: live.map((x) => x.ident) }, { n: 'service_id', t: 'uuid', v: live.map((x) => x.id) }], 'ON CONFLICT DO NOTHING');
        const mobile = live.filter((x) => x.type === 'MOBILE');
        if (mobile.length) {
          const matcher = await getMatcher(q);
          const cls = mobile.map((x) => (x.vip ? { tier: String(x.vip).toUpperCase(), patternCode: null } : matcher.classify(x.ident)));
          await q.query(`INSERT INTO msisdn_inventory (msisdn, state, tier, pattern_code, service_id) SELECT m, 'ASSIGNED_ACTIVE', CASE WHEN tr IN ('DIAMOND','GOLD','SILVER','STANDARD','AUCTION') THEN tr ELSE 'STANDARD' END, pc, s FROM unnest($1::text[], $2::text[], $3::text[], $4::uuid[]) AS t(m, tr, pc, s)
                         ON CONFLICT (msisdn) DO UPDATE SET state='ASSIGNED_ACTIVE', service_id=EXCLUDED.service_id, reserved_by=NULL, reserved_until=NULL, updated_at=now()`,
            [mobile.map((x) => x.ident), cls.map((c) => c.tier), cls.map((c) => c.patternCode), mobile.map((x) => x.id)]);
        }
        const withSim = live.filter((x) => x.iccid);
        if (withSim.length) await q.query(`INSERT INTO iccid_inventory (iccid, state, imsi, service_id) SELECT i, 'ACTIVE', m, s FROM unnest($1::text[], $2::text[], $3::uuid[]) AS t(i, m, s)
                         ON CONFLICT (iccid) DO UPDATE SET state='ACTIVE', service_id=EXCLUDED.service_id, imsi=COALESCE(EXCLUDED.imsi, iccid_inventory.imsi), updated_at=now()`, [withSim.map((x) => x.iccid), withSim.map((x) => x.imsi), withSim.map((x) => x.id)]);
        const withImsi = live.filter((x) => x.imsi);
        if (withImsi.length) await q.query(`INSERT INTO imsi_inventory (imsi, state, iccid, service_id) SELECT m, 'ACTIVE', i, s FROM unnest($1::text[], $2::text[], $3::uuid[]) AS t(m, i, s)
                         ON CONFLICT (imsi) DO UPDATE SET state='ACTIVE', service_id=EXCLUDED.service_id, iccid=COALESCE(EXCLUDED.iccid, imsi_inventory.iccid), updated_at=now()`, [withImsi.map((x) => x.imsi), withImsi.map((x) => x.iccid), withImsi.map((x) => x.id)]);
      }
    }
    if (ctx.write) {
      // A value-added service points at the mobile service it belongs to: resolved once the batch is in (the parent may be in this batch or an earlier load).
      const kids = ins.filter((x) => x.parentRef);
      if (kids.length) {
        const own = new Map(ins.map((x) => [x.ref as string, x.id as string]));
        const pid = kids.map((x) => own.get(x.parentRef) ?? parentMap.get(x.parentRef) ?? null);
        await q.query(`UPDATE services s SET parent_service_id = u.p FROM unnest($1::uuid[], $2::uuid[]) u(id, p) WHERE s.id = u.id AND u.p IS NOT NULL`, [kids.map((x) => x.id), pid]);
      }
    }
    await remember(ctx, 'services', ins.map((x) => ({ ref: x.ref, id: x.id })));
    await keyNote(ctx, ins.map((x) => `services#ident:${x.type}:${x.ident}`));
    void identKeys;
    return out;
  },
  async undo(q, jobId, limit) {
    const ids = await createdIds(q, 'services', jobId, limit);
    if (!ids.length) return 0;
    const sid = ids.map((x) => x.id);
    await q.query(`UPDATE msisdn_inventory SET state='AVAILABLE', service_id=NULL, updated_at=now() WHERE service_id = ANY($1::uuid[])`, [sid]);
    await q.query(`UPDATE iccid_inventory SET state='WAREHOUSE_INVENTORY', service_id=NULL, updated_at=now() WHERE service_id = ANY($1::uuid[])`, [sid]);
    await q.query(`UPDATE imsi_inventory SET state='BOUND_TO_SIM', service_id=NULL, updated_at=now() WHERE service_id = ANY($1::uuid[])`, [sid]);
    await q.query('DELETE FROM identifier_registry WHERE service_id = ANY($1::uuid[])', [sid]);
    await q.query('DELETE FROM services WHERE id = ANY($1::uuid[])', [sid]);
    await forget(q, 'services', ids.map((x) => x.ref));
    return ids.length;
  },
};

// ───────────────────────── inventory pools ─────────────────────────
function pool(entity: 'sims' | 'imsis' | 'msisdns'): Importer {
  const T = { sims: { table: 'iccid_inventory', key: 'iccid' }, imsis: { table: 'imsi_inventory', key: 'imsi' }, msisdns: { table: 'msisdn_inventory', key: 'msisdn' } }[entity];
  return {
    batch: 2000,
    async run(ctx, rows) {
      const q = ctx.q;
      const out: RowResult[] = rows.map(() => OK);
      const keys = rows.map((r) => str(r.rec[T.key]));
      const there = new Set((await q.query(`SELECT ${T.key} AS k FROM ${T.table} WHERE ${T.key} = ANY($1::text[])`, [keys])).rows.map((r) => r.k as string));
      const seen = await seenKeys(ctx, entity, keys);
      const batch = new Set<string>();
      const matcher = entity === 'msisdns' ? await getMatcher(q) : null;
      const ins: Array<{ r: Record<string, unknown>; k: string }> = [];
      for (const [i, row] of rows.entries()) {
        const k = keys[i]!;
        if (there.has(k)) { out[i] = skip(`${k} is already in the inventory.`); continue; }
        if (batch.has(k) || seen.has(`${entity}:${k}`)) { out[i] = err(`${k} appears more than once in the file.`, T.key, 'DUPLICATE_KEY'); continue; }
        if (entity === 'msisdns' && row.rec.tier && !['DIAMOND', 'GOLD', 'SILVER', 'STANDARD', 'AUCTION'].includes(str(row.rec.tier).toUpperCase())) { out[i] = err('tier is DIAMOND, GOLD, SILVER, STANDARD or AUCTION.', 'tier', 'BAD_VALUE'); continue; }
        batch.add(k); ins.push({ r: row.rec, k });
      }
      if (ctx.write && ins.length) {
        const c = (name: string) => ins.map((x) => opt(x.r[name]));
        if (entity === 'sims') await bulk(q, T.table, [{ n: 'iccid', t: 'text', v: ins.map((x) => x.k) }, { n: 'kind', t: 'text', v: ins.map((x) => str(x.r.kind) || 'PHYSICAL') }, { n: 'state', t: 'text', v: ins.map((x) => str(x.r.state) || 'WAREHOUSE_INVENTORY') },
          { n: 'location_id', t: 'text', v: c('location_id') }, { n: 'imsi', t: 'text', v: c('imsi') }, { n: 'activation_code', t: 'text', v: c('activation_code') }, { n: 'batch', t: 'text', v: c('batch') }], 'ON CONFLICT DO NOTHING');
        else if (entity === 'imsis') await bulk(q, T.table, [{ n: 'imsi', t: 'text', v: ins.map((x) => x.k) }, { n: 'state', t: 'text', v: ins.map((x) => str(x.r.state) || 'POOL_UNASSIGNED') }, { n: 'iccid', t: 'text', v: c('iccid') },
          { n: 'previous_msisdn', t: 'text', v: c('previous_msisdn') }, { n: 'quarantine_until', t: 'date', v: c('quarantine_until') }, { n: 'batch', t: 'text', v: c('batch') }], 'ON CONFLICT DO NOTHING');
        else {
          const cls = ins.map((x) => (x.r.tier ? { tier: str(x.r.tier).toUpperCase(), patternCode: opt(x.r.pattern_code) } : matcher!.classify(x.k)));
          await bulk(q, T.table, [{ n: 'msisdn', t: 'text', v: ins.map((x) => x.k) }, { n: 'state', t: 'text', v: ins.map((x) => str(x.r.state) || 'AVAILABLE') }, { n: 'tier', t: 'text', v: cls.map((x) => x.tier) },
            { n: 'pattern_code', t: 'text', v: ins.map((x, i) => x.r.pattern_code ?? cls[i]!.patternCode ?? null) }, { n: 'quarantine_until', t: 'date', v: c('quarantine_until') }, { n: 'batch', t: 'text', v: c('batch') }], 'ON CONFLICT DO NOTHING');
        }
      }
      await remember(ctx, entity, ins.map((x) => ({ ref: x.k, id: x.k })));
      return out;
    },
    async undo(q, jobId, limit) {
      const ids = await createdIds(q, entity, jobId, limit);
      if (!ids.length) return 0;
      await q.query(`DELETE FROM ${T.table} WHERE ${T.key} = ANY($1::text[]) AND service_id IS NULL`, [ids.map((x) => x.id)]);
      await forget(q, entity, ids.map((x) => x.ref));
      return ids.length;
    },
  };
}

// ───────────────────────── balances and dunning ─────────────────────────
async function accountsFor(ctx: ImportCtx, refs: string[]) {
  const m = await refMap(ctx.q, 'accounts', refs);
  const ids = [...new Set(refs.map((a) => m.get(a) ?? (UUID.test(a) ? a.toLowerCase() : '')).filter(Boolean))];
  const rows = new Map((ids.length ? (await ctx.q.query('SELECT id, shard_id, customer_id, currency, status FROM accounts WHERE id = ANY($1::uuid[])', [ids])).rows : []).map((a) => [a.id as string, a]));
  return (ref: string) => rows.get(m.get(ref) ?? (UUID.test(ref) ? ref.toLowerCase() : ''));
}

const balances: Importer = {
  batch: 500,
  async run(ctx, rows) {
    const q = ctx.q;
    const out: RowResult[] = rows.map(() => OK);
    const refs = rows.map((r) => str(r.rec.account_id));
    const existing = await refMap(q, 'account_balances', refs);
    const seen = await seenKeys(ctx, 'account_balances', refs);
    const acct = await accountsFor(ctx, refs);
    const batch = new Set<string>();
    const ins: Array<{ ref: string; id: string; a: any; amount: number; due: string; cur: string }> = [];
    for (const [i, row] of rows.entries()) {
      const ref = refs[i]!;
      if (existing.has(ref)) { out[i] = skip(`The opening balance of ${ref} was loaded earlier.`); continue; }
      if (batch.has(ref) || seen.has(`account_balances:${ref}`)) { out[i] = err(`The account ${ref} has more than one balance row: give one total per account.`, 'account_id', 'DUPLICATE_KEY'); continue; }
      const a = acct(ref);
      if (!a) { out[i] = err(`The account ${ref} was not found. Load accounts first.`, 'account_id', 'UNKNOWN_REFERENCE'); continue; }
      const cur = str(row.rec.currency) || a.currency;
      if (cur !== a.currency) { out[i] = err(`The account bills in ${a.currency}, not ${cur}.`, 'currency', 'BAD_VALUE'); continue; }
      const amount = Number(row.rec.balance_minor);
      if (!Number.isInteger(amount) || amount <= 0) { out[i] = err('balance_minor must be a positive whole number (zero balances are not loaded).', 'balance_minor', 'BAD_VALUE'); continue; }
      batch.add(ref);
      ins.push({ ref, id: randomUUID(), a, amount, due: str(row.rec.due_date) || today(), cur });
    }
    if (ctx.write && ins.length) {
      const t = today();
      const seqs = (await q.query(`SELECT nextval('invoice_seq') AS n FROM generate_series(1, $1)`, [ins.length])).rows.map((r) => r.n as number);
      const c = ins.map((x, i) => ({ ...x, number: `INV-${t.slice(0, 4)}-${String(seqs[i]).padStart(6, '0')}`, issue: x.due < t ? x.due : t }));
      await bulk(q, 'invoices', [
        { n: 'id', t: 'uuid', v: c.map((x) => x.id) }, { n: 'shard_id', t: 'smallint', v: c.map((x) => x.a.shardId) }, { n: 'number', t: 'text', v: c.map((x) => x.number) },
        { n: 'account_id', t: 'uuid', v: c.map((x) => x.a.id) }, { n: 'customer_id', t: 'uuid', v: c.map((x) => x.a.customerId) }, { n: 'kind', t: 'text', v: c.map(() => 'OPENING') },
        { n: 'period_start', t: 'date', v: c.map((x) => x.issue) }, { n: 'period_end', t: 'date', v: c.map((x) => x.issue) }, { n: 'issue_date', t: 'date', v: c.map((x) => x.issue) }, { n: 'due_date', t: 'date', v: c.map((x) => x.due) },
        { n: 'status', t: 'text', v: c.map((x) => (x.due < t ? 'OVERDUE' : 'ISSUED')) }, { n: 'currency', t: 'text', v: c.map((x) => x.cur) },
        { n: 'net_minor', t: 'bigint', v: c.map((x) => x.amount) }, { n: 'tax_minor', t: 'bigint', v: c.map(() => 0) }, { n: 'total_minor', t: 'bigint', v: c.map((x) => x.amount) },
      ]);
      // The other side: receivables up, the migration clearing account down, so the ledger still balances and reconciles with the open invoices.
      for (const x of c) await postJournal(q, { date: x.issue, sourceType: 'OPENING_BALANCE', sourceId: x.id, currency: x.cur, eventType: 'ADJUSTMENT_POSTED', lines: [{ account: GL.AR, debit: x.amount, description: `Opening balance ${x.number}` }, { account: GL.OPENING_BALANCE, credit: x.amount, description: `Opening balance ${x.number}` }] });
    }
    await remember(ctx, 'account_balances', ins.map((x) => ({ ref: x.ref, id: x.id })));
    return out;
  },
  async undo(q, jobId, limit) {
    const ids = await createdIds(q, 'account_balances', jobId, limit);
    if (!ids.length) return 0;
    const paid = (await q.query(`SELECT 1 FROM invoices WHERE id = ANY($1::uuid[]) AND (paid_minor > 0 OR credited_minor > 0 OR status NOT IN ('ISSUED','OVERDUE')) LIMIT 1`, [ids.map((x) => x.id)])).rows.length;
    if (paid) throw new Error('A payment or credit has already been applied to some of these opening balances, so they cannot be taken out.');
    await q.query(`DELETE FROM gl_entries WHERE source_type='OPENING_BALANCE' AND source_id = ANY($1::text[])`, [ids.map((x) => x.id)]);
    await q.query('DELETE FROM invoices WHERE id = ANY($1::uuid[])', [ids.map((x) => x.id)]);
    await forget(q, 'account_balances', ids.map((x) => x.ref));
    return ids.length;
  },
};

const dunning: Importer = {
  batch: 500,
  async run(ctx, rows) {
    const q = ctx.q;
    const out: RowResult[] = rows.map(() => OK);
    const refs = rows.map((r) => str(r.rec.account_id));
    const existing = await refMap(q, 'dunning_states', refs);
    const seen = await seenKeys(ctx, 'dunning_states', refs);
    const acct = await accountsFor(ctx, refs);
    const ids = refs.map((r) => acct(r)?.id as string | undefined).filter(Boolean) as string[];
    const active = new Set((ids.length ? (await q.query(`SELECT account_id FROM dunning_runs WHERE status='ACTIVE' AND account_id = ANY($1::uuid[])`, [ids])).rows : []).map((r) => r.accountId as string));
    const batch = new Set<string>();
    const ins: Array<{ ref: string; a: any; stage: number; due: string; at: unknown; step: unknown }> = [];
    for (const [i, row] of rows.entries()) {
      const ref = refs[i]!;
      if (existing.has(ref)) { out[i] = skip(`The dunning case of ${ref} was loaded earlier.`); continue; }
      if (batch.has(ref) || seen.has(`dunning_states:${ref}`)) { out[i] = err(`The account ${ref} has more than one dunning row.`, 'account_id', 'DUPLICATE_KEY'); continue; }
      const a = acct(ref);
      if (!a) { out[i] = err(`The account ${ref} was not found. Load accounts first.`, 'account_id', 'UNKNOWN_REFERENCE'); continue; }
      if (active.has(a.id)) { out[i] = err('This account already has an active dunning case.', 'account_id', 'CONFLICT'); continue; }
      batch.add(ref);
      ins.push({ ref, a, stage: Number(row.rec.stage), due: str(row.rec.anchor_due), at: opt(row.rec.started_at), step: opt(row.rec.last_step) });
    }
    const idOf = new Map<string, string>();
    if (ctx.write && ins.length) {
      const res = await q.query(`INSERT INTO dunning_runs (account_id, anchor_due, started_at, last_step) SELECT a, d, COALESCE(s, now()), l FROM unnest($1::uuid[], $2::date[], $3::timestamptz[], $4::text[]) AS t(a, d, s, l) RETURNING id, account_id`,
        [ins.map((x) => x.a.id), ins.map((x) => x.due), ins.map((x) => x.at), ins.map((x) => x.step)]);
      for (const r of res.rows) idOf.set(r.accountId as string, String(r.id));
      await q.query('UPDATE accounts SET dunning_stage = u.s FROM unnest($1::uuid[], $2::smallint[]) AS u(a, s) WHERE accounts.id = u.a', [ins.map((x) => x.a.id), ins.map((x) => x.stage)]);
    }
    await remember(ctx, 'dunning_states', ins.map((x) => ({ ref: x.ref, id: idOf.get(x.a.id) ?? '0' })));
    return out;
  },
  async undo(q, jobId, limit) {
    const ids = await createdIds(q, 'dunning_states', jobId, limit);
    if (!ids.length) return 0;
    const runs = (await q.query(`DELETE FROM dunning_runs WHERE id = ANY($1::bigint[]) AND status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM dunning_steps s WHERE s.run_id = dunning_runs.id) RETURNING account_id`, [ids.map((x) => x.id)])).rows;
    await q.query('UPDATE accounts SET dunning_stage = 0 WHERE id = ANY($1::uuid[])', [runs.map((r) => r.accountId)]);
    await forget(q, 'dunning_states', ids.map((x) => x.ref));
    return ids.length;
  },
};

// ───────────────────────── importers that reuse a screen's own loader ─────────────────────────
/** The rows as CSV text: the header, then the raw cells. */
function csvOf(header: string[], rows: BatchRow[]): string {
  return [header.map(csvCell).join(','), ...rows.map((r) => (r.cells ?? header.map(() => '')).map(csvCell).join(','))].join('\r\n') + '\r\n';
}
type Loader = (db: Db, text: string, o: { apply: boolean; actor: string }) => Promise<{ rows: Array<{ status: 'OK' | 'ERROR' | 'SKIPPED'; message?: string }> }>;
function viaScreen(loader: Loader, o: { batch: number }): Importer {
  return {
    batch: o.batch, raw: true, cellsOnly: true,
    async run(ctx, rows) {
      const header = ctx.header!;
      const res = (await loader(ctx.db, csvOf(header, rows), { apply: false, actor: ctx.actor })).rows;
      const out: RowResult[] = res.map((r) => (r.status === 'ERROR' ? err(r.message ?? 'Not accepted.') : r.status === 'SKIPPED' ? { status: 'SKIPPED', message: r.message } : OK));
      if (ctx.write) {
        const good = rows.filter((_, i) => out[i]!.status === 'OK');
        if (good.length) await loader(ctx.db, csvOf(header, good), { apply: true, actor: ctx.actor });
      }
      return out;
    },
  };
}

const catalog: Importer = {
  batch: 200, raw: true,
  async run(ctx, rows) {
    const out: RowResult[] = rows.map(() => OK);
    const run = async (q: Queryable, commit: boolean) => {
      for (const [i, row] of rows.entries()) {
        const r = row.rec;
        await q.query('SAVEPOINT node');
        try {
          const found = (await q.query('SELECT level FROM catalog_nodes WHERE id=$1', [str(r.id)])).rows[0];
          if (found) { out[i] = skip(`${str(r.id)} is already in the catalog.`); await q.query('RELEASE SAVEPOINT node'); continue; }
          await createNode(q, { id: str(r.id), level: str(r.level) as 'NETWORK_TYPE', name: str(r.name), parentId: str(r.parent_id) || null, status: (str(r.status) || 'ACTIVE') as 'ACTIVE', networkType: str(r.network_type) || undefined, activeFrom: opt(r.active_from) ?? undefined, markets: Array.isArray(r.markets) ? (r.markets as string[]) : [] } as never, ctx.actor);
          await q.query('RELEASE SAVEPOINT node');
        } catch (e) {
          await q.query('ROLLBACK TO SAVEPOINT node');
          out[i] = err((e as { details?: string[] }).details?.length ? (e as { details: string[] }).details.join('; ') : (e as Error).message);
        }
      }
      if (!commit) throw new Error('__check__');
    };
    try { await ctx.db.tx((q) => run(q, ctx.write)); } catch (e) { if ((e as Error).message !== '__check__') throw e; }
    return out;
  },
};

// ───────────────────────── warehouses and opening stock ─────────────────────────
const warehouses: Importer = {
  batch: 500,
  async run(ctx, rows) {
    const q = ctx.q;
    const out: RowResult[] = rows.map(() => OK);
    const ids = rows.map((r) => str(r.rec.id));
    const names = rows.map((r) => str(r.rec.name).toLowerCase());
    const found = (await q.query('SELECT id, lower(name) AS name FROM warehouses WHERE id = ANY($1::text[]) OR lower(name) = ANY($2::text[])', [ids.filter(Boolean), names])).rows;
    const foundIds = new Set(found.map((w) => w.id as string)), foundNames = new Set(found.map((w) => w.name as string));
    const seen = await seenKeys(ctx, 'warehouses#name', names);
    const seenId = await seenKeys(ctx, 'warehouses', ids.filter(Boolean));
    const inBatch = new Set<string>(), idsInBatch = new Set<string>();
    const ins: Array<{ ref: string; id: string; name: string; address: unknown; status: string; at: unknown }> = [];
    for (const [i, row] of rows.entries()) {
      const r = row.rec, id = ids[i]!, name = str(r.name);
      if (id && !/^[A-Za-z0-9][A-Za-z0-9-]{1,39}$/.test(id)) { out[i] = err('The id is letters, digits and dashes, 2 to 40 characters (WH-00001).', 'id', 'BAD_FORMAT'); continue; }
      if (id && foundIds.has(id)) { out[i] = skip(`Warehouse ${id} is already there.`); continue; }
      if (foundNames.has(names[i]!)) { out[i] = err(`There is already a warehouse called ${name}.`, 'name', 'DUPLICATE_NAME'); continue; }
      if (inBatch.has(names[i]!) || seen.has(`warehouses#name:${names[i]}`)) { out[i] = err(`${name} appears more than once in the file.`, 'name', 'DUPLICATE_KEY'); continue; }
      if (id && (idsInBatch.has(id) || seenId.has(`warehouses:${id}`))) { out[i] = err(`The id ${id} appears more than once in the file.`, 'id', 'DUPLICATE_KEY'); continue; }
      inBatch.add(names[i]!); if (id) idsInBatch.add(id);
      ins.push({ ref: id || `line-${row.line}`, id, name, address: opt(r.address), status: str(r.status) || 'ACTIVE', at: opt(r.created_at) });
    }
    if (ctx.write && ins.length) {
      const made = (await q.query(
        `INSERT INTO warehouses (id, name, address, status, created_by, created_at)
         SELECT COALESCE(NULLIF(t.id, ''), 'WH-' || lpad(nextval('warehouse_id_seq')::text, 5, '0')), t.name, t.address, t.status, $5, COALESCE(t.at, now())
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $6::timestamptz[]) AS t(id, name, address, status, at) RETURNING id, lower(name) AS name`,
        [ins.map((x) => x.id), ins.map((x) => x.name), ins.map((x) => x.address), ins.map((x) => x.status), ctx.actor, ins.map((x) => x.at)])).rows;
      const byName = new Map(made.map((m) => [m.name as string, m.id as string]));
      await remember(ctx, 'warehouses', ins.map((x) => ({ ref: x.ref, id: byName.get(x.name.toLowerCase())! })));
    } else {
      await remember(ctx, 'warehouses', ins.filter((x) => x.id).map((x) => ({ ref: x.id, id: x.id })));
      await keyNote(ctx, ins.map((x) => `warehouses#name:${x.name.toLowerCase()}`));
    }
    return out;
  },
  async undo(q, jobId, limit) {
    const ids = await createdIds(q, 'warehouses', jobId, limit);
    if (!ids.length) return 0;
    // A warehouse that has since received stock or been part of a transfer stays: taking it out would lose that history.
    const used = new Set((await q.query(`SELECT DISTINCT location_id AS id FROM inventory_stock WHERE location_id = ANY($1::text[]) UNION SELECT from_location FROM stock_transfers WHERE from_location = ANY($1::text[]) UNION SELECT to_location FROM stock_transfers WHERE to_location = ANY($1::text[])`, [ids.map((x) => x.id)])).rows.map((r) => r.id as string));
    if (used.size) throw new Error(`Warehouse ${[...used][0]} now holds stock or has transfers; clear that first.`);
    await q.query('DELETE FROM warehouses WHERE id = ANY($1::text[])', [ids.map((x) => x.id)]);
    await forget(q, 'warehouses', ids.map((x) => x.ref));
    return ids.length;
  },
};

/** Opening stock: each row sets the count at a location, through the stock screen's own loader (same checks, same movement ledger). */
const stock: Importer = {
  batch: 1000, raw: true,
  async run(ctx, rows) {
    const text = (list: BatchRow[]) => ['location_id,sku,quantity,action', ...list.map((r) => [str(r.rec.location_id), str(r.rec.sku), str(r.rec.on_hand), 'SET'].map(csvCell).join(','))].join('\r\n') + '\r\n';
    const res = (await importStock(ctx.db, text(rows), { apply: false, actor: ctx.actor, confirmRepeat: true })).rows;
    const out: RowResult[] = rows.map((_, i) => { const r = res[i]; return !r ? OK : r.status === 'ERROR' ? err(r.message ?? 'Not accepted.') : r.status === 'SKIPPED' ? { status: 'SKIPPED' as const, message: r.message } : OK; });
    if (ctx.write) {
      const good = rows.filter((_, i) => out[i]!.status === 'OK');
      if (good.length) await importStock(ctx.db, text(good), { apply: true, actor: ctx.actor, confirmRepeat: true });
    }
    return out;
  },
};

const lineItems: Importer = {
  batch: 200, raw: true,
  async run(ctx, rows) {
    const out: RowResult[] = rows.map(() => OK);
    const run = async (q: Queryable, commit: boolean) => {
      for (const [i, row] of rows.entries()) {
        const r = row.rec;
        await q.query('SAVEPOINT item');
        try {
          if ((await q.query('SELECT 1 FROM catalog_nodes WHERE id=$1', [str(r.id)])).rows.length) { out[i] = skip(`${str(r.id)} is already in the catalog.`); await q.query('RELEASE SAVEPOINT item'); continue; }
          const parent = (await q.query('SELECT level FROM catalog_nodes WHERE id=$1', [str(r.parent_id)])).rows[0];
          if (!parent || parent.level !== 'OFFER') { out[i] = err(`The offer ${str(r.parent_id)} was not found. Load offers first.`, 'parent_id', 'UNKNOWN_REFERENCE'); await q.query('RELEASE SAVEPOINT item'); continue; }
          await createNode(q, { id: str(r.id), level: 'LINE_ITEM', name: str(r.name), parentId: str(r.parent_id), status: (str(r.status) || 'ACTIVE') as 'ACTIVE', itemType: str(r.item_type), quantity: r.quantity === null || r.quantity === undefined || r.quantity === '' ? undefined : Number(r.quantity), unit: opt(r.unit) ?? undefined, unlimited: r.unlimited === true, sku: opt(r.sku) ?? undefined, description: opt(r.description) ?? undefined, markets: [] } as never, ctx.actor);
          await q.query('RELEASE SAVEPOINT item');
        } catch (e) {
          await q.query('ROLLBACK TO SAVEPOINT item');
          out[i] = err((e as { details?: string[] }).details?.length ? (e as { details: string[] }).details.join('; ') : (e as Error).message);
        }
      }
      if (!commit) throw new Error('__check__');
    };
    try { await ctx.db.tx((q) => run(q, ctx.write)); } catch (e) { if ((e as Error).message !== '__check__') throw e; }
    return out;
  },
};

export const IMPORTERS: Record<string, Importer> = {
  line_items: lineItems,
  warehouses, inventory_stock: stock,
  catalog_structure: catalog,
  offers: viaScreen(importOffers as unknown as Loader, { batch: 500 }),
  stores: viaScreen(importStores as unknown as Loader, { batch: 1000 }),
  dealers: viaScreen((db, text, o) => importDealers(db, text, { ...o, channel: true }) as never, { batch: 1000 }),
  agents: viaScreen(importAgents as unknown as Loader, { batch: 1000 }),
  sims: pool('sims'), imsis: pool('imsis'), msisdns: pool('msisdns'),
  customers, accounts, services, account_balances: balances, dunning_states: dunning,
};

export const importerFor = (entity: string): Importer | null => (entityById(entity)?.importable ? IMPORTERS[entity] ?? null : null);
export const canRollBack = (entity: string): boolean => !!IMPORTERS[entity]?.undo;
void importFields;
