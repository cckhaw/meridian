import { randomUUID } from 'node:crypto';
import type { Db, Queryable, Row } from './db.js';
import { audit } from './audit.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { assertMsisdnTransition, auditIdentifier, getNumberingSettings, tierRuleMap, type MsisdnState } from './nrm.js';
import { queueOutbox } from './lifecycle-state.js';
import type { VipTier } from './vip-pattern-matcher.js';

/**
 * A lock that works across servers. Redis is the usual one (Redlock): take it before the database transaction so a flash sale does not send
 * hundreds of requests for one number into the database. The database is still the authority: the row lock (`FOR UPDATE SKIP LOCKED`) and the
 * state check decide who gets the number, so losing or skipping the distributed lock can never double-sell it.
 */
export interface DistributedLock {
  acquire(key: string, ttlMs: number, token: string): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
}

/** The part of a Redis client the lock needs (ioredis and node-redis both fit through a thin wrapper). */
export interface RedisLike {
  set(key: string, value: string, mode: 'PX', ttlMs: number, flag: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
export class RedisLock implements DistributedLock {
  constructor(private readonly redis: RedisLike, private readonly prefix = 'meridian:nrm:') {}
  async acquire(key: string, ttlMs: number, token: string) { return (await this.redis.set(this.prefix + key, token, 'PX', ttlMs, 'NX')) === 'OK'; }
  async release(key: string, token: string) { await this.redis.eval(RELEASE_SCRIPT, 1, this.prefix + key, token); }
}

export interface Reservation { msisdn: string; token: string; holder: string; expiresAt: string; tier: VipTier; oneTimeFeeMinor: number }
export interface NumberFilter { tier?: VipTier; prefix?: string; suffix?: string; contains?: string; limit?: number; cursor?: string; includeHeld?: boolean }

const digitsOnly = (s: string) => s.replace(/[^\d+]/g, '');

/** Holds a number inside an open transaction; see NumberReservationService.reserve. */
export async function reserveMsisdnTx(q: Queryable, msisdn: string, holder: string, token: string, ttlMs: number, o: { auctionWinner?: boolean; actor?: string } = {}): Promise<Reservation> {
  // SKIP LOCKED: if another transaction is picking this very row we do not wait for it, we lose the race at once.
  const row = (await q.query('SELECT * FROM msisdn_inventory WHERE msisdn=$1 FOR UPDATE SKIP LOCKED', [msisdn])).rows[0];
  if (!row) {
    if (!(await q.query('SELECT 1 FROM msisdn_inventory WHERE msisdn=$1', [msisdn])).rows.length) throw notFound('number', msisdn);
    throw conflict(`${msisdn} was just taken by someone else. Choose another number.`);
  }
  const lapsed = row.state === 'RESERVED_CHECKOUT' && row.reservedUntil && new Date(row.reservedUntil) < new Date();
  const mine = row.state === 'RESERVED_CHECKOUT' && row.reservedBy === holder;
  if (row.state === 'AUCTION_HOLD' && !o.auctionWinner) throw rejected(`${msisdn} is held for auction and cannot be bought directly.`);
  if (row.state === 'RESERVED_CHECKOUT' && !lapsed && !mine) throw conflict(`${msisdn} is being bought by someone else right now. Choose another number or try again in a few minutes.`);
  if (!['AVAILABLE', 'AUCTION_HOLD', 'RESERVED_CHECKOUT'].includes(row.state)) throw rejected(`${msisdn} is ${String(row.state).toLowerCase().replace(/_/g, ' ')} and cannot be chosen.`);
  if (row.state === 'AVAILABLE' || row.state === 'AUCTION_HOLD') assertMsisdnTransition(msisdn, row.state, 'RESERVED_CHECKOUT');
  const expires = new Date(Date.now() + ttlMs);
  const back = row.state === 'RESERVED_CHECKOUT' ? (row.previousState ?? 'AVAILABLE') : row.state;
  await q.query(`UPDATE number_reservation_locks SET state='EXPIRED', ended_at=now() WHERE resource_type='MSISDN' AND resource_id=$1 AND state='ACTIVE'`, [msisdn]);
  await q.query(`UPDATE msisdn_inventory SET state='RESERVED_CHECKOUT', previous_state=$2, reserved_by=$3, reserved_until=$4, updated_at=now() WHERE msisdn=$1`, [msisdn, back, holder, expires.toISOString()]);
  await q.query(`INSERT INTO number_reservation_locks (resource_type, resource_id, holder, token, expires_at) VALUES ('MSISDN',$1,$2,$3,$4)`, [msisdn, holder, token, expires.toISOString()]);
  await auditIdentifier(q, { type: 'MSISDN', id: msisdn, from: row.state, to: 'RESERVED_CHECKOUT', actor: o.actor ?? holder, reason: 'reserved for checkout', detail: { holder, until: expires.toISOString() } });
  const rule = (await tierRuleMap(q)).get(row.tier as VipTier);
  return { msisdn, token, holder, expiresAt: expires.toISOString(), tier: row.tier, oneTimeFeeMinor: rule?.oneTimeFeeMinor ?? 0 };
}

/** Gives a held number back; see NumberReservationService.release. */
export async function releaseMsisdnTx(q: Queryable, msisdn: string, holder: string, actor: string): Promise<boolean> {
  const row = (await q.query(`SELECT * FROM msisdn_inventory WHERE msisdn=$1 FOR UPDATE`, [msisdn])).rows[0];
  if (!row || row.state !== 'RESERVED_CHECKOUT' || row.reservedBy !== holder) return false;
  const to: MsisdnState = (row.previousState as MsisdnState) ?? 'AVAILABLE';
  await q.query(`UPDATE msisdn_inventory SET state=$2, previous_state=NULL, reserved_by=NULL, reserved_until=NULL, updated_at=now() WHERE msisdn=$1`, [msisdn, to]);
  await q.query(`UPDATE number_reservation_locks SET state='RELEASED', ended_at=now() WHERE resource_type='MSISDN' AND resource_id=$1 AND state='ACTIVE'`, [msisdn]);
  await auditIdentifier(q, { type: 'MSISDN', id: msisdn, from: 'RESERVED_CHECKOUT', to, actor, reason: 'released' });
  return true;
}

/** The order has been paid and the service is live: the hold becomes an assignment. */
export async function consumeMsisdnTx(q: Queryable, msisdn: string, serviceId: string, actor: string): Promise<void> {
  const row = (await q.query(`SELECT * FROM msisdn_inventory WHERE msisdn=$1 FOR UPDATE`, [msisdn])).rows[0];
  if (!row) return;
  assertMsisdnTransition(msisdn, row.state, 'ASSIGNED_ACTIVE');
  await q.query(`UPDATE msisdn_inventory SET state='ASSIGNED_ACTIVE', service_id=$2, previous_state=NULL, reserved_by=NULL, reserved_until=NULL, updated_at=now() WHERE msisdn=$1`, [msisdn, serviceId]);
  await q.query(`UPDATE number_reservation_locks SET state='CONSUMED', ended_at=now() WHERE resource_type='MSISDN' AND resource_id=$1 AND state='ACTIVE'`, [msisdn]);
  await auditIdentifier(q, { type: 'MSISDN', id: msisdn, from: row.state, to: 'ASSIGNED_ACTIVE', actor, detail: { service: serviceId } });
}

export class NumberReservationService {
  constructor(private readonly db: Db, private readonly opts: { lock?: DistributedLock; ttlMinutes?: number } = {}) {}

  private async ttlMs(q: Queryable, minutes?: number) { return (minutes ?? this.opts.ttlMinutes ?? (await getNumberingSettings(q)).reservationMinutes) * 60_000; }

  /** Numbers a customer can choose from: available ones (and ones whose hold has lapsed), newest tier first, never auction or blocked numbers. */
  async search(f: NumberFilter = {}): Promise<{ items: Array<Row & { oneTimeFeeMinor: number; minMonthlyPlanMinor: number; minContractMonths: number }>; nextCursor: string | null }> {
    const limit = Math.min(Math.max(f.limit ?? 24, 1), 100);
    const params: unknown[] = [];
    const p = (v: unknown) => `$${params.push(v)}`;
    const where = [`(m.state = 'AVAILABLE' OR (m.state = 'RESERVED_CHECKOUT' AND m.reserved_until < now()))`];
    if (f.tier) where.push(`m.tier = ${p(f.tier)}`);
    if (f.prefix) where.push(`m.msisdn LIKE ${p(digitsOnly(f.prefix).replace(/[%_]/g, '') + '%')}`);
    if (f.suffix) where.push(`m.msisdn LIKE ${p('%' + f.suffix.replace(/\D/g, ''))}`);
    if (f.contains) where.push(`m.msisdn LIKE ${p('%' + f.contains.replace(/\D/g, '') + '%')}`);
    if (f.cursor) where.push(`m.msisdn > ${p(f.cursor)}`);
    const rows = (await this.db.query(
      `SELECT m.msisdn, m.tier, m.pattern_code, r.label AS tier_label, r.one_time_fee_minor, r.min_monthly_plan_minor, r.min_contract_months
         FROM msisdn_inventory m JOIN msisdn_vip_tier_rules r ON r.tier = m.tier AND r.enabled
        WHERE ${where.join(' AND ')} ORDER BY m.msisdn LIMIT ${p(limit + 1)}`, params)).rows;
    const items = rows.slice(0, limit) as never;
    return { items, nextCursor: rows.length > limit ? (rows[limit - 1]!.msisdn as string) : null };
  }

  /**
   * Holds one number for a customer who is checking out (15 minutes by default). Two people choosing the same number at once: one wins, the other is told
   * it was just taken. Choosing the number you already hold again just extends the hold.
   */
  async reserve(msisdn: string, holder: string, o: { auctionWinner?: boolean; ttlMinutes?: number; actor?: string } = {}): Promise<Reservation> {
    if (!/^\+\d{8,15}$/.test(msisdn)) throw invalid(`invalid number ${msisdn}`);
    const token = randomUUID();
    const lockKey = `msisdn:${msisdn}`;
    const ttl = await this.ttlMs(this.db, o.ttlMinutes);
    const got = this.opts.lock ? await this.opts.lock.acquire(lockKey, Math.min(ttl, 30_000), token) : true;
    if (!got) throw conflict(`${msisdn} was just taken by someone else. Choose another number.`);
    try {
      return await this.db.tx((q) => this.reserveTx(q, msisdn, holder, token, ttl, o));
    } finally {
      if (this.opts.lock) await this.opts.lock.release(lockKey, token);
    }
  }

  /** The reservation inside an open transaction (the order engine uses this so the number is taken in the same transaction as the order). */
  reserveTx(q: Queryable, msisdn: string, holder: string, token: string, ttlMs: number, o: { auctionWinner?: boolean; actor?: string } = {}) { return reserveMsisdnTx(q, msisdn, holder, token, ttlMs, o); }

  /**
   * Picks numbers without waiting on anyone: the first free ones in a tier, skipping any row another checkout is holding at this moment, so a flash
   * sale of a thousand customers each gets a different number instead of queueing on one.
   */
  async pick(holderPrefix: string, o: { tier?: VipTier; prefix?: string; count?: number; ttlMinutes?: number } = {}): Promise<Reservation[]> {
    const count = Math.min(Math.max(o.count ?? 1, 1), 20);
    const ttl = await this.ttlMs(this.db, o.ttlMinutes);
    return this.db.tx(async (q) => {
      const rows = (await q.query(
        `SELECT msisdn FROM msisdn_inventory WHERE (state='AVAILABLE' OR (state='RESERVED_CHECKOUT' AND reserved_until < now())) AND tier=$1 AND ($2::text IS NULL OR msisdn LIKE $2)
          ORDER BY msisdn LIMIT $3 FOR UPDATE SKIP LOCKED`, [o.tier ?? 'STANDARD', o.prefix ? digitsOnly(o.prefix) + '%' : null, count])).rows;
      const out: Reservation[] = [];
      for (const r of rows) out.push(await this.reserveTx(q, r.msisdn as string, `${holderPrefix}`, randomUUID(), ttl));
      return out;
    });
  }

  /** The customer changed their mind, or the checkout was abandoned: the number goes back where it came from. */
  async release(msisdn: string, holder: string, actor = holder): Promise<boolean> {
    return this.db.tx((q) => this.releaseTx(q, msisdn, holder, actor));
  }
  releaseTx(q: Queryable, msisdn: string, holder: string, actor: string) { return releaseMsisdnTx(q, msisdn, holder, actor); }

  consumeTx(q: Queryable, msisdn: string, serviceId: string, actor: string) { return consumeMsisdnTx(q, msisdn, serviceId, actor); }

  /**
   * Holds that ran out (nobody paid or signed in time) go back: to AVAILABLE, or to AUCTION_HOLD for an auction number. Run every minute or so; the
   * search and the reserve calls also treat a lapsed hold as free, so a missed run costs nothing.
   */
  async expireStale(limit = 1000): Promise<number> {
    return this.db.tx(async (q) => {
      const rows = (await q.query(`SELECT msisdn, previous_state FROM msisdn_inventory WHERE state='RESERVED_CHECKOUT' AND reserved_until < now() ORDER BY reserved_until LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
      for (const r of rows) {
        const to: MsisdnState = (r.previousState as MsisdnState) ?? 'AVAILABLE';
        await q.query(`UPDATE msisdn_inventory SET state=$2, previous_state=NULL, reserved_by=NULL, reserved_until=NULL, updated_at=now() WHERE msisdn=$1`, [r.msisdn, to]);
        await q.query(`UPDATE number_reservation_locks SET state='EXPIRED', ended_at=now() WHERE resource_type='MSISDN' AND resource_id=$1 AND state='ACTIVE'`, [r.msisdn]);
        await auditIdentifier(q, { type: 'MSISDN', id: r.msisdn, from: 'RESERVED_CHECKOUT', to, actor: 'nrm', reason: 'hold expired' });
      }
      const sims = (await q.query(`SELECT iccid, previous_state FROM iccid_inventory WHERE state='RESERVED' AND reserved_until IS NOT NULL AND reserved_until < now() AND order_id IS NULL LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
      for (const s of sims) {
        const to = (s.previousState as string) ?? 'WAREHOUSE_INVENTORY';
        await q.query(`UPDATE iccid_inventory SET state=$2, previous_state=NULL, reserved_until=NULL, updated_at=now() WHERE iccid=$1`, [s.iccid, to]);
        await auditIdentifier(q, { type: 'ICCID', id: s.iccid, from: 'RESERVED', to, actor: 'nrm', reason: 'hold expired' });
      }
      return rows.length + sims.length;
    });
  }

  // ─────────────── auction hooks ───────────────
  /** High-demand numbers are taken off the shelf and held for sealed-bid auction (or an enterprise allocation). */
  async holdForAuction(msisdns: string[], actor: string): Promise<{ held: number; skipped: Array<{ msisdn: string; why: string }> }> {
    const skipped: Array<{ msisdn: string; why: string }> = [];
    let held = 0;
    await this.db.tx(async (q) => {
      for (const m of msisdns.slice(0, 1000)) {
        const row = (await q.query('SELECT * FROM msisdn_inventory WHERE msisdn=$1 FOR UPDATE', [m])).rows[0];
        if (!row) { skipped.push({ msisdn: m, why: 'not in the pool' }); continue; }
        if (!['AVAILABLE', 'BLOCKED_VIP'].includes(row.state)) { skipped.push({ msisdn: m, why: `it is ${String(row.state).toLowerCase().replace(/_/g, ' ')}` }); continue; }
        await q.query(`UPDATE msisdn_inventory SET state='AUCTION_HOLD', tier='AUCTION', updated_at=now() WHERE msisdn=$1`, [m]);
        await auditIdentifier(q, { type: 'MSISDN', id: m, from: row.state, to: 'AUCTION_HOLD', actor, reason: 'released to auction' });
        held++;
      }
      await audit(q, actor, 'numbering', 'auction', 'HELD', { held });
    });
    return { held, skipped };
  }

  /** An auction was cancelled or unsold: the numbers go back on the shelf in the tier their pattern gives. */
  async releaseFromAuction(msisdns: string[], actor: string): Promise<{ released: number }> {
    const { getMatcher } = await import('./nrm.js');
    const matcher = await getMatcher(this.db);
    let released = 0;
    await this.db.tx(async (q) => {
      for (const m of msisdns.slice(0, 1000)) {
        const row = (await q.query(`SELECT * FROM msisdn_inventory WHERE msisdn=$1 AND state='AUCTION_HOLD' FOR UPDATE`, [m])).rows[0];
        if (!row) continue;
        const c = matcher.classify(m);
        const tier = c.tier === 'STANDARD' ? 'DIAMOND' : c.tier; // an auction number is valuable by definition: never drop to a free tier by accident
        await q.query(`UPDATE msisdn_inventory SET state='AVAILABLE', tier=$2, pattern_code=$3, updated_at=now() WHERE msisdn=$1`, [m, tier, c.patternCode]);
        await auditIdentifier(q, { type: 'MSISDN', id: m, from: 'AUCTION_HOLD', to: 'AVAILABLE', actor, reason: 'withdrawn from auction' });
        released++;
      }
    });
    return { released };
  }

  /**
   * The auction closed and the winning bid was paid or committed: the number is reserved for the winner (for the settlement window, 48 hours by
   * default) and VIP_NUMBER_AUCTION_WON goes onto the message bus, so the order for it and the binding to the winner's account start at once.
   */
  async settleAuction(a: { msisdn: string; auctionId: string; winnerCustomerId: string; winningBidMinor: number; currency?: string }, actor: string): Promise<Reservation> {
    if (!Number.isInteger(a.winningBidMinor) || a.winningBidMinor < 0) throw invalid('The winning bid is a whole amount, zero or more.');
    const cfg = await getNumberingSettings(this.db);
    return this.db.tx(async (q) => {
      const cust = (await q.query('SELECT id FROM customers WHERE id=$1', [a.winnerCustomerId])).rows[0];
      if (!cust) throw notFound('customer', a.winnerCustomerId);
      const res = await this.reserveTx(q, a.msisdn, `auction:${a.auctionId}`, randomUUID(), cfg.auctionSettlementHours * 3_600_000, { auctionWinner: true, actor });
      await queueOutbox(q, { kind: 'EVENT', instruction: 'VIP_NUMBER_AUCTION_WON', payload: {
        topic: 'meridian.nrm.events', type: 'VIP_NUMBER_AUCTION_WON', key: a.msisdn, msisdn: a.msisdn, auctionId: a.auctionId, customerId: a.winnerCustomerId,
        winningBidMinor: a.winningBidMinor, currency: a.currency ?? null, reservedUntil: res.expiresAt, token: res.token,
      } });
      await audit(q, actor, 'numbering', a.msisdn, 'AUCTION_WON', { auctionId: a.auctionId, customerId: a.winnerCustomerId, winningBidMinor: a.winningBidMinor });
      return res;
    });
  }
}
