import { randomBytes } from 'node:crypto';
import type { Db, Queryable, Row } from './db.js';
import { audit } from './audit.js';
import { csvCell, parseCsv } from './csv.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { assertIccidTransition, assertImsiTransition, auditIdentifier, getMatcher, getNumberingSettings, type IccidState } from './nrm.js';
import { assertStockLocation } from './warehouses.js';
import { VIP_TIERS, type VipTier } from './vip-pattern-matcher.js';

const E164 = /^\+\d{8,15}$/;
const IMSI = /^\d{15}$/;
export const ICCID = /^89\d{17,18}$/;
const CHUNK = 1000;
export const MAX_RANGE = 200_000;

export interface PoolImportResult {
  applied: boolean; total: number; added: number; duplicates: number; errors: Array<{ line: number; value: string; message: string }>;
  /** MSISDN imports: how many numbers fall in each tier. */
  byTier?: Partial<Record<VipTier, number>>;
}

/** Numbers from a range: +60128000000 to +60128009999 (digits only after the +, same length, at most 200,000). */
function expandRange(from: string, to: string, max = MAX_RANGE): string[] {
  const prefix = from.startsWith('+') ? '+' : '';
  const a = from.replace(/^\+/, ''), b = to.replace(/^\+/, '');
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b) || a.length !== b.length) throw invalid('A range runs between two numbers of the same length.');
  const lo = BigInt(a), hi = BigInt(b);
  if (hi < lo) throw invalid('The range ends before it starts.');
  if (hi - lo + 1n > BigInt(max)) throw invalid(`A range can hold at most ${max.toLocaleString('en')} numbers; split it.`);
  const out: string[] = [];
  for (let n = lo; n <= hi; n++) out.push(prefix + n.toString().padStart(a.length, '0'));
  return out;
}

function listFrom(input: { csv?: string; range?: { from: string; to: string } }, headerNames: string[]): Array<{ line: number; cells: string[] }> {
  if (input.range) return expandRange(input.range.from, input.range.to).map((v, i) => ({ line: i + 1, cells: [v] }));
  const rows = parseCsv(input.csv ?? '');
  if (!rows.length) throw invalid('The file is empty.');
  const first = (rows[0]!.cells[0] ?? '').toLowerCase().trim();
  const hasHeader = headerNames.includes(first);
  return rows.slice(hasHeader ? 1 : 0).filter((r) => r.cells.some((c) => c.trim()));
}

// ───────────────────────── MSISDN ─────────────────────────
/** Loads phone numbers into the pool, each put in its tier by the pattern rules. The check changes nothing. A number already in the pool is skipped, never overwritten. */
export async function importMsisdns(db: Db, input: { csv?: string; range?: { from: string; to: string } }, o: { apply: boolean; actor: string; batch?: string }): Promise<PoolImportResult> {
  const rows = listFrom(input, ['msisdn', 'number']);
  const matcher = await getMatcher(db);
  const res: PoolImportResult = { applied: false, total: rows.length, added: 0, duplicates: 0, errors: [], byTier: {} };
  const seen = new Set<string>();
  const good: Array<{ msisdn: string; tier: VipTier; code: string | null }> = [];
  for (const r of rows) {
    const v = (r.cells[0] ?? '').trim().replace(/[\s()-]/g, '');
    if (!E164.test(v)) { res.errors.push({ line: r.line, value: v, message: 'Use the full number with country code, like +60128001234.' }); continue; }
    if (seen.has(v)) { res.duplicates++; continue; }
    seen.add(v);
    const c = matcher.classify(v);
    good.push({ msisdn: v, tier: c.tier, code: c.patternCode });
  }
  const have = new Set<string>();
  for (let i = 0; i < good.length; i += CHUNK) {
    for (const x of (await db.query('SELECT msisdn FROM msisdn_inventory WHERE msisdn = ANY($1::text[])', [good.slice(i, i + CHUNK).map((g) => g.msisdn)])).rows) have.add(x.msisdn as string);
  }
  const fresh = good.filter((g) => { if (have.has(g.msisdn)) { res.duplicates++; return false; } return true; });
  for (const f of fresh) res.byTier![f.tier] = (res.byTier![f.tier] ?? 0) + 1;
  res.added = fresh.length;
  if (!o.apply) return res;
  if (res.errors.length) throw rejected(`${res.errors.length} line(s) have a problem, so nothing was loaded. Fix them and try again.`);
  const batch = o.batch ?? `import-${new Date().toISOString().slice(0, 16)}`;
  await db.tx(async (q) => {
    for (let i = 0; i < fresh.length; i += CHUNK) {
      const part = fresh.slice(i, i + CHUNK);
      await q.query(`INSERT INTO msisdn_inventory (msisdn, tier, pattern_code, batch) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) ON CONFLICT DO NOTHING`,
        [part.map((p) => p.msisdn), part.map((p) => p.tier), part.map((p) => p.code), part.map(() => batch)]);
    }
    await audit(q, o.actor, 'numbering', 'msisdn', 'IMPORTED', { added: fresh.length, byTier: res.byTier, batch });
  });
  res.applied = true;
  return res;
}

// ───────────────────────── IMSI ─────────────────────────
export async function importImsis(db: Db, input: { csv?: string; range?: { from: string; to: string } }, o: { apply: boolean; actor: string; batch?: string }): Promise<PoolImportResult> {
  const rows = listFrom(input, ['imsi']);
  const res: PoolImportResult = { applied: false, total: rows.length, added: 0, duplicates: 0, errors: [] };
  const seen = new Set<string>();
  const good: string[] = [];
  for (const r of rows) {
    const v = (r.cells[0] ?? '').trim();
    if (!IMSI.test(v)) { res.errors.push({ line: r.line, value: v, message: 'An IMSI is 15 digits.' }); continue; }
    if (seen.has(v)) { res.duplicates++; continue; }
    seen.add(v); good.push(v);
  }
  const have = new Set<string>();
  for (let i = 0; i < good.length; i += CHUNK) for (const x of (await db.query('SELECT imsi FROM imsi_inventory WHERE imsi = ANY($1::text[])', [good.slice(i, i + CHUNK)])).rows) have.add(x.imsi as string);
  const fresh = good.filter((g) => { if (have.has(g)) { res.duplicates++; return false; } return true; });
  res.added = fresh.length;
  if (!o.apply) return res;
  if (res.errors.length) throw rejected(`${res.errors.length} line(s) have a problem, so nothing was loaded. Fix them and try again.`);
  const batch = o.batch ?? `import-${new Date().toISOString().slice(0, 16)}`;
  await db.tx(async (q) => {
    for (let i = 0; i < fresh.length; i += CHUNK) await q.query(`INSERT INTO imsi_inventory (imsi, batch) SELECT x, $2 FROM unnest($1::text[]) AS x ON CONFLICT DO NOTHING`, [fresh.slice(i, i + CHUNK), batch]);
    await audit(q, o.actor, 'numbering', 'imsi', 'IMPORTED', { added: fresh.length, batch });
  });
  res.applied = true;
  return res;
}

/** Takes the next free IMSIs from the pool without waiting on anyone else who is taking them (recycled ones come back around when their turn comes). */
async function takeImsis(q: Queryable, n: number): Promise<string[]> {
  const rows = (await q.query(`SELECT imsi FROM imsi_inventory WHERE state='POOL_UNASSIGNED' ORDER BY (quarantine_until IS NULL), imsi LIMIT $1 FOR UPDATE SKIP LOCKED`, [n])).rows;
  return rows.map((r) => r.imsi as string);
}

async function bindImsi(q: Queryable, imsi: string, iccid: string, actor: string, reason: string) {
  const row = (await q.query('SELECT * FROM imsi_inventory WHERE imsi=$1 FOR UPDATE', [imsi])).rows[0];
  if (!row) throw notFound('IMSI', imsi);
  assertImsiTransition(imsi, row.state, 'BOUND_TO_SIM');
  await q.query(`UPDATE imsi_inventory SET state='BOUND_TO_SIM', iccid=$2, updated_at=now() WHERE imsi=$1`, [imsi, iccid]);
  await auditIdentifier(q, { type: 'IMSI', id: imsi, from: row.state, to: 'BOUND_TO_SIM', actor, reason, detail: { iccid } });
}

// ───────────────────────── ICCID / SIMs ─────────────────────────
export interface SimImportOptions { apply: boolean; actor: string; kind?: 'PHYSICAL' | 'ESIM'; locationId?: string; batch?: string; /** Write a free IMSI from the pool onto every SIM that does not come with one (factory pre-personalisation). */ autoBindImsi?: boolean }

/**
 * Loads a batch of SIMs. Columns: iccid, imsi (optional), type (PHYSICAL or ESIM, optional), location (optional), activation_code (eSIM, optional).
 * A SIM without an IMSI gets the next one from the pool (this is where recycled IMSIs go back onto new SIMs). A SIM already in the pool is skipped.
 */
export async function importSims(db: Db, input: { csv: string }, o: SimImportOptions): Promise<PoolImportResult & { bound: number }> {
  const rows = listFrom(input, ['iccid']);
  const res = { applied: false, total: rows.length, added: 0, duplicates: 0, errors: [] as PoolImportResult['errors'], bound: 0 };
  const defLoc = o.locationId ?? 'WH-MAIN';
  await assertStockLocation(db, defLoc);
  const seen = new Set<string>();
  const good: Array<{ iccid: string; imsi: string | null; kind: 'PHYSICAL' | 'ESIM'; location: string; code: string | null }> = [];
  const locs = new Map<string, boolean>();
  for (const r of rows) {
    const [iccidRaw, imsiRaw, typeRaw, locRaw, codeRaw] = r.cells.map((c) => (c ?? '').trim());
    const iccid = (iccidRaw ?? '').replace(/\s/g, '');
    if (!ICCID.test(iccid)) { res.errors.push({ line: r.line, value: iccid, message: 'An ICCID is 19 or 20 digits starting with 89.' }); continue; }
    if (seen.has(iccid)) { res.duplicates++; continue; }
    seen.add(iccid);
    if (imsiRaw && !IMSI.test(imsiRaw)) { res.errors.push({ line: r.line, value: iccid, message: `The IMSI ${imsiRaw} should be 15 digits.` }); continue; }
    const kind = (typeRaw ? typeRaw.toUpperCase() : o.kind ?? 'PHYSICAL') as 'PHYSICAL' | 'ESIM';
    if (kind !== 'PHYSICAL' && kind !== 'ESIM') { res.errors.push({ line: r.line, value: iccid, message: 'The type is PHYSICAL or ESIM.' }); continue; }
    const location = locRaw || defLoc;
    if (!locs.has(location)) { try { await assertStockLocation(db, location); locs.set(location, true); } catch { locs.set(location, false); } }
    if (!locs.get(location)) { res.errors.push({ line: r.line, value: iccid, message: `Unknown location “${location}”. Use a warehouse or a store.` }); continue; }
    good.push({ iccid, imsi: imsiRaw || null, kind, location, code: codeRaw || null });
  }
  const have = new Set<string>();
  for (let i = 0; i < good.length; i += CHUNK) for (const x of (await db.query('SELECT iccid FROM iccid_inventory WHERE iccid = ANY($1::text[])', [good.slice(i, i + CHUNK).map((g) => g.iccid)])).rows) have.add(x.iccid as string);
  const fresh = good.filter((g) => { if (have.has(g.iccid)) { res.duplicates++; return false; } return true; });
  res.added = fresh.length;
  if (!o.apply) return res;
  if (res.errors.length) throw rejected(`${res.errors.length} line(s) have a problem, so nothing was loaded. Fix them and try again.`);
  const batch = o.batch ?? `sims-${new Date().toISOString().slice(0, 16)}`;
  await db.tx(async (q) => {
    const needImsi = fresh.filter((f) => !f.imsi && f.kind === 'PHYSICAL' && o.autoBindImsi !== false);
    const pool = needImsi.length ? await takeImsis(q, needImsi.length) : [];
    if (pool.length < needImsi.length) throw rejected(`The IMSI pool has ${pool.length} free identities but ${needImsi.length} SIMs need one. Load more IMSIs first, or load the SIMs with their IMSI.`);
    needImsi.forEach((f, i) => { f.imsi = pool[i]!; });
    for (const f of fresh) {
      await q.query(`INSERT INTO iccid_inventory (iccid, kind, state, location_id, imsi, activation_code, batch) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [f.iccid, f.kind, f.location.startsWith('WH-') ? 'WAREHOUSE_INVENTORY' : 'DISTRIBUTED_DEALER', f.location, f.imsi, f.code, batch]);
      if (f.imsi) {
        const existing = (await q.query('SELECT state FROM imsi_inventory WHERE imsi=$1', [f.imsi])).rows[0];
        if (!existing) await q.query(`INSERT INTO imsi_inventory (imsi, batch) VALUES ($1,$2)`, [f.imsi, batch]); // an IMSI that came with its SIM joins the pool and is bound at once
        await bindImsi(q, f.imsi, f.iccid, o.actor, 'written onto the SIM at personalisation');
        res.bound++;
      }
      await auditIdentifier(q, { type: 'ICCID', id: f.iccid, to: 'WAREHOUSE_INVENTORY', actor: o.actor, reason: 'loaded', detail: { batch, kind: f.kind, location: f.location, imsi: f.imsi } });
    }
    await audit(q, o.actor, 'numbering', 'iccid', 'IMPORTED', { added: fresh.length, bound: res.bound, batch });
  });
  res.applied = true;
  return res;
}

export async function simTemplate(): Promise<string> {
  return [
    '# ICCID: 19-20 digits starting with 89. IMSI: 15 digits, optional (a free one from the pool is written onto the SIM if blank). type: PHYSICAL or ESIM. location: a warehouse or store id.',
    'iccid,imsi,type,location,activation_code',
    ['8960123456789012345', '', 'PHYSICAL', 'WH-MAIN', ''].map(csvCell).join(','),
  ].join('\n') + '\n';
}

/** Moves a SIM between states by hand (hand out to a dealer, take back, scrap, decommission). A SIM that was never used gives its IMSI back to the pool. */
export async function transitionSim(db: Db, iccid: string, to: IccidState, o: { actor: string; reason?: string; locationId?: string }): Promise<Row> {
  return db.tx(async (q) => {
    const sim = (await q.query('SELECT * FROM iccid_inventory WHERE iccid=$1 FOR UPDATE', [iccid])).rows[0];
    if (!sim) throw notFound('SIM', iccid);
    if (to === 'RESERVED' || to === 'ACTIVE') throw rejected('A SIM is reserved and activated by an order, not by hand.');
    if (sim.state === 'RESERVED') throw rejected('This SIM is reserved for an order. Cancel the order first.');
    assertIccidTransition(iccid, sim.state, to);
    if (to === 'DISTRIBUTED_DEALER' && !o.locationId) throw invalid('Say which dealer or store receives the SIM.');
    if (o.locationId) await assertStockLocation(q, o.locationId).catch((e) => { if (to === 'DISTRIBUTED_DEALER' && /dealer/i.test(String(o.locationId))) return; throw e; });
    if ((to === 'DAMAGED_SCRAPPED' || to === 'DECOMMISSIONED') && !(o.reason ?? '').trim()) throw invalid('Say why the SIM is scrapped.');
    await q.query(`UPDATE iccid_inventory SET state=$2, location_id=COALESCE($3, location_id), updated_at=now() WHERE iccid=$1`, [iccid, to, o.locationId ?? null]);
    await auditIdentifier(q, { type: 'ICCID', id: iccid, from: sim.state, to, actor: o.actor, reason: o.reason });
    if (sim.imsi && (to === 'DAMAGED_SCRAPPED' || to === 'DECOMMISSIONED') && sim.state !== 'ACTIVE') {
      const im = (await q.query('SELECT * FROM imsi_inventory WHERE imsi=$1 FOR UPDATE', [sim.imsi])).rows[0];
      if (im?.state === 'BOUND_TO_SIM') {
        await q.query(`UPDATE imsi_inventory SET state='POOL_UNASSIGNED', iccid=NULL, updated_at=now() WHERE imsi=$1`, [sim.imsi]);
        await auditIdentifier(q, { type: 'IMSI', id: sim.imsi, from: 'BOUND_TO_SIM', to: 'POOL_UNASSIGNED', actor: o.actor, reason: 'the SIM it was written on was scrapped before use' });
      }
    }
    return (await q.query('SELECT * FROM iccid_inventory WHERE iccid=$1', [iccid])).rows[0]!;
  });
}

export interface SimFilter { locationId?: string; kind?: 'PHYSICAL' | 'ESIM'; state?: string; q?: string; limit?: number; cursor?: string }
export async function listSims(q: Queryable, f: SimFilter = {}): Promise<{ items: Row[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where: string[] = [];
  if (f.locationId) where.push(`location_id = ${p(f.locationId)}`);
  if (f.kind) where.push(`kind = ${p(f.kind)}`);
  if (f.state === 'AVAILABLE') where.push(`state IN ('WAREHOUSE_INVENTORY','DISTRIBUTED_DEALER')`);
  else if (f.state) where.push(`state = ${p(f.state)}`);
  if (f.q?.trim()) where.push(`iccid LIKE ${p(f.q.replace(/\D/g, '') + '%')}`);
  if (f.cursor) where.push(`iccid > ${p(f.cursor)}`);
  const rows = (await q.query(`SELECT iccid, kind, state, location_id, imsi, batch, order_id, service_id, updated_at FROM iccid_inventory ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY iccid LIMIT ${p(limit + 1)}`, params)).rows;
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? (rows[limit - 1]!.iccid as string) : null };
}

export async function listMsisdns(q: Queryable, f: { state?: string; tier?: string; q?: string; limit?: number; cursor?: string } = {}): Promise<{ items: Row[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where: string[] = [];
  if (f.state) where.push(`state = ${p(f.state)}`);
  if (f.tier) where.push(`tier = ${p(f.tier)}`);
  if (f.q?.trim()) where.push(`msisdn LIKE ${p((f.q.startsWith('+') ? '+' : '%') + f.q.replace(/\D/g, '') + '%')}`);
  if (f.cursor) where.push(`msisdn > ${p(f.cursor)}`);
  const rows = (await q.query(`SELECT msisdn, state, tier, pattern_code, reserved_until, service_id, quarantine_until, batch FROM msisdn_inventory ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY msisdn LIMIT ${p(limit + 1)}`, params)).rows;
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? (rows[limit - 1]!.msisdn as string) : null };
}

export async function listImsis(q: Queryable, f: { state?: string; q?: string; limit?: number; cursor?: string } = {}): Promise<{ items: Row[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where: string[] = [];
  if (f.state) where.push(`state = ${p(f.state)}`);
  if (f.q?.trim()) where.push(`imsi LIKE ${p(f.q.replace(/\D/g, '') + '%')}`);
  if (f.cursor) where.push(`imsi > ${p(f.cursor)}`);
  const rows = (await q.query(`SELECT imsi, state, iccid, service_id, previous_msisdn, quarantine_until, batch FROM imsi_inventory ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY imsi LIMIT ${p(limit + 1)}`, params)).rows;
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? (rows[limit - 1]!.imsi as string) : null };
}

// ───────────────────────── eSIM ─────────────────────────
/** The operator's SM-DP+ (GSMA SGP.22): creates a downloadable profile for an ICCID/IMSI and returns the activation code the customer scans. */
export interface SmDpPlus { createProfile(input: { iccid: string; imsi: string }): Promise<{ activationCode: string }>; }
export const stubSmDpPlus: SmDpPlus = {
  async createProfile({ iccid }) { return { activationCode: `LPA:1$smdp.example.net$${iccid.slice(-8)}-${randomBytes(4).toString('hex').toUpperCase()}` }; },
};

/**
 * Issues a fresh eSIM profile: takes a free eSIM ICCID template and a free IMSI (this is the other place recycled IMSIs go), asks SM-DP+ for a
 * profile and returns the activation code. The ICCID is held (RESERVED) for the order.
 */
export async function issueEsimProfile(q: Queryable, o: { actor: string; orderId?: string; smdp?: SmDpPlus; holdMinutes?: number }): Promise<{ iccid: string; imsi: string; activationCode: string }> {
  const tpl = (await q.query(`SELECT * FROM iccid_inventory WHERE kind='ESIM' AND state IN ('WAREHOUSE_INVENTORY','DISTRIBUTED_DEALER') ORDER BY iccid LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
  if (!tpl) throw rejected('There are no eSIM profiles left in inventory. Load more eSIM ICCIDs.');
  const [imsi] = await takeImsis(q, 1);
  if (!imsi) throw rejected('The IMSI pool is empty. Load more IMSIs.');
  const { activationCode } = await (o.smdp ?? stubSmDpPlus).createProfile({ iccid: tpl.iccid, imsi });
  const hold = new Date(Date.now() + (o.holdMinutes ?? (await getNumberingSettings(q)).reservationMinutes) * 60_000).toISOString();
  assertIccidTransition(tpl.iccid, tpl.state, 'RESERVED');
  await q.query(`UPDATE iccid_inventory SET state='RESERVED', previous_state=$2, imsi=$3, activation_code=$4, order_id=$5, reserved_until=$6, updated_at=now() WHERE iccid=$1`, [tpl.iccid, tpl.state, imsi, activationCode, o.orderId ?? null, o.orderId ? null : hold]);
  await auditIdentifier(q, { type: 'ICCID', id: tpl.iccid, from: tpl.state, to: 'RESERVED', actor: o.actor, reason: 'eSIM profile issued', detail: { order: o.orderId ?? null } });
  await bindImsi(q, imsi, tpl.iccid, o.actor, 'issued on an eSIM profile');
  return { iccid: tpl.iccid as string, imsi, activationCode };
}

// ───────────────────────── allocating for an order ─────────────────────────
export interface SimChoice { iccid?: string; simType?: 'PHYSICAL' | 'ESIM' }
export interface AllocatedSim { iccid: string; imsi: string | null; kind: 'PHYSICAL' | 'ESIM'; activationCode: string | null }

/**
 * Takes the SIM an order line asked for. A named physical SIM must be in inventory where the seller works (their store, or a warehouse for
 * remote channels). No SIM named: the next free physical SIM at that place. eSIM: a fresh profile.
 */
export async function allocateSimTx(q: Queryable, c: SimChoice, o: { orderId: string; storeId?: string | null; actor: string }): Promise<AllocatedSim> {
  if (c.simType === 'ESIM') {
    const e = await issueEsimProfile(q, { actor: o.actor, orderId: o.orderId });
    return { iccid: e.iccid, imsi: e.imsi, kind: 'ESIM', activationCode: e.activationCode };
  }
  let sim: Row | undefined;
  if (c.iccid) {
    sim = (await q.query('SELECT * FROM iccid_inventory WHERE iccid=$1 FOR UPDATE SKIP LOCKED', [c.iccid])).rows[0];
    if (!sim) {
      if (!(await q.query('SELECT 1 FROM iccid_inventory WHERE iccid=$1', [c.iccid])).rows.length) throw notFound('SIM', c.iccid);
      throw conflict(`SIM ${c.iccid} was just taken by another order. Choose another.`);
    }
  } else {
    sim = (await q.query(
      `SELECT * FROM iccid_inventory WHERE kind='PHYSICAL' AND state IN ('WAREHOUSE_INVENTORY','DISTRIBUTED_DEALER') AND (CASE WHEN $1::text IS NOT NULL THEN location_id = $1 ELSE location_id LIKE 'WH-%' END)
        ORDER BY iccid LIMIT 1 FOR UPDATE SKIP LOCKED`, [o.storeId ?? null])).rows[0];
    if (!sim) throw rejected(o.storeId ? `There are no free SIM cards at your store (${o.storeId}). Receive some first, or sell an eSIM.` : 'There are no free SIM cards in the warehouse.');
  }
  if (!['WAREHOUSE_INVENTORY', 'DISTRIBUTED_DEALER'].includes(sim.state)) throw rejected(`SIM ${sim.iccid} is ${String(sim.state).toLowerCase().replace(/_/g, ' ')} and cannot be sold.`);
  if (o.storeId && sim.locationId !== o.storeId) throw rejected(`SIM ${sim.iccid} is at ${sim.locationId}, not at your store (${o.storeId}).`);
  assertIccidTransition(sim.iccid, sim.state, 'RESERVED');
  await q.query(`UPDATE iccid_inventory SET state='RESERVED', previous_state=$2, order_id=$3, updated_at=now() WHERE iccid=$1`, [sim.iccid, sim.state, o.orderId]);
  await auditIdentifier(q, { type: 'ICCID', id: sim.iccid, from: sim.state, to: 'RESERVED', actor: o.actor, reason: 'allocated to an order', detail: { order: o.orderId } });
  return { iccid: sim.iccid as string, imsi: (sim.imsi as string) ?? null, kind: sim.kind, activationCode: (sim.activationCode as string) ?? null };
}

/** The service is live: the SIM, its IMSI and the number become ACTIVE / ASSIGNED_ACTIVE and point at the service. */
export async function activateResourcesTx(q: Queryable, r: { iccid?: string | null; msisdn?: string | null; serviceId: string; actor: string }): Promise<{ imsi: string | null }> {
  let imsi: string | null = null;
  if (r.iccid) {
    const sim = (await q.query('SELECT * FROM iccid_inventory WHERE iccid=$1 FOR UPDATE', [r.iccid])).rows[0];
    if (sim) {
      assertIccidTransition(sim.iccid, sim.state, 'ACTIVE');
      await q.query(`UPDATE iccid_inventory SET state='ACTIVE', service_id=$2, reserved_until=NULL, previous_state=NULL, updated_at=now() WHERE iccid=$1`, [sim.iccid, r.serviceId]);
      await auditIdentifier(q, { type: 'ICCID', id: sim.iccid, from: sim.state, to: 'ACTIVE', actor: r.actor, detail: { service: r.serviceId } });
      imsi = (sim.imsi as string) ?? null;
      if (imsi) {
        const im = (await q.query('SELECT * FROM imsi_inventory WHERE imsi=$1 FOR UPDATE', [imsi])).rows[0];
        if (im) {
          assertImsiTransition(imsi, im.state, 'ACTIVE');
          await q.query(`UPDATE imsi_inventory SET state='ACTIVE', service_id=$2, updated_at=now() WHERE imsi=$1`, [imsi, r.serviceId]);
          await auditIdentifier(q, { type: 'IMSI', id: imsi, from: im.state, to: 'ACTIVE', actor: r.actor, detail: { service: r.serviceId, iccid: sim.iccid } });
        }
      }
    }
  }
  return { imsi };
}

/** An order that never became a service (cancelled, failed, expired): its SIM goes back where it was, and a fresh eSIM profile is undone. */
export async function releaseOrderSimsTx(q: Queryable, orderId: string, actor: string): Promise<number> {
  const sims = (await q.query(`SELECT * FROM iccid_inventory WHERE order_id=$1 AND state='RESERVED' FOR UPDATE`, [orderId])).rows;
  for (const s of sims) {
    const to = ((s.previousState as string) ?? 'WAREHOUSE_INVENTORY') as IccidState;
    assertIccidTransition(s.iccid, 'RESERVED', to);
    const esim = s.kind === 'ESIM';
    await q.query(`UPDATE iccid_inventory SET state=$2, previous_state=NULL, order_id=NULL, imsi=${esim ? 'NULL' : 'imsi'}, activation_code=${esim ? 'NULL' : 'activation_code'}, updated_at=now() WHERE iccid=$1`, [s.iccid, to]);
    await auditIdentifier(q, { type: 'ICCID', id: s.iccid, from: 'RESERVED', to, actor, reason: 'order did not complete', detail: { order: orderId } });
    if (esim && s.imsi) { // the IMSI issued for the profile goes straight back to the pool
      await q.query(`UPDATE imsi_inventory SET state='POOL_UNASSIGNED', iccid=NULL, updated_at=now() WHERE imsi=$1 AND state='BOUND_TO_SIM'`, [s.imsi]);
      await auditIdentifier(q, { type: 'IMSI', id: s.imsi, from: 'BOUND_TO_SIM', to: 'POOL_UNASSIGNED', actor, reason: 'eSIM profile withdrawn' });
    }
  }
  return sims.length;
}

export const TIER_LIST = VIP_TIERS;
