import { audit, conflict, invalid, notFound, rejected, type Db, type Queryable, type Row } from '@meridian/core';
import { getFiberSettings } from './settings.js';

/**
 * Port locks. When a customer picks a fibre plan at checkout the port is held (RESERVED_CHECKOUT) for the lock time so nobody else takes it while they pay;
 * placing the order confirms it (RESERVED_ORDER), the installation activates it (IN_USE), and abandoning checkout (or the clock) frees it.
 * The claim is one atomic statement that skips rows another checkout holds, so two customers can never get the same port.
 */
export interface ReserveInput {
  providerId: string; dpId?: string | null; customerRef?: string; speedMbps?: number; lat?: number; lng?: number; address?: string; actor?: string; ttlMinutes?: number;
}

export async function reservePort(db: Db, i: ReserveInput): Promise<Row> {
  const settings = await getFiberSettings(db);
  const ttl = i.ttlMinutes ?? settings.lockMinutes;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 240) throw invalid('The lock time is 1 to 240 minutes.');
  const actor = i.actor ?? 'system';
  return db.tx(async (q) => {
    const prov = (await q.query('SELECT id, enabled FROM fiber_providers WHERE id=$1', [i.providerId])).rows[0];
    if (!prov || !prov.enabled) throw notFound('provider', i.providerId);
    // The same customer asking again keeps one lock: it is renewed, not doubled.
    if (i.customerRef) {
      const mine = (await q.query(`SELECT * FROM fiber_reservations WHERE customer_ref=$1 AND provider_id=$2 AND state='ACTIVE' AND expires_at > now() FOR UPDATE`, [i.customerRef, i.providerId])).rows[0];
      if (mine && (!i.dpId || mine.dpId === i.dpId)) {
        const r = (await q.query(`UPDATE fiber_reservations SET expires_at = now() + make_interval(mins => $2) WHERE id=$1 RETURNING *`, [mine.id, ttl])).rows[0]!;
        if (mine.portId) await q.query(`UPDATE fiber_ports SET reserved_until = $2, updated_at=now() WHERE id=$1`, [mine.portId, r.expiresAt]);
        return r;
      }
      if (mine) await release(q, mine.id, actor, 'RELEASED');   // they moved to a different distribution point
    }
    let portId: string | null = null; let dpId: string | null = i.dpId ?? null;
    if (dpId) {
      const dp = (await q.query(`SELECT id, provider_id FROM fiber_dps WHERE id=$1 AND status='ACTIVE'`, [dpId])).rows[0];
      if (!dp || dp.providerId !== i.providerId) throw notFound('distribution point', dpId);
      const claimed = (await q.query(
        `UPDATE fiber_ports SET state='RESERVED_CHECKOUT', reserved_until = now() + make_interval(mins => $2), updated_at=now()
          WHERE id = (SELECT id FROM fiber_ports WHERE dp_id=$1 AND (state='AVAILABLE' OR (state='RESERVED_CHECKOUT' AND reserved_until < now())) ORDER BY port_no LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING id`, [dpId, ttl])).rows[0];
      if (!claimed) throw conflict('Every port on that distribution point is taken. Join the waitlist instead.');
      portId = claimed.id;
    }
    const r = (await q.query(
      `INSERT INTO fiber_reservations (provider_id, dp_id, port_id, customer_ref, speed_mbps, lat, lng, address, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(mins => $9), $10) RETURNING *`,
      [i.providerId, dpId, portId, i.customerRef ?? null, i.speedMbps ?? null, i.lat ?? null, i.lng ?? null, i.address ?? null, ttl, actor])).rows[0]!;
    if (portId) await q.query('UPDATE fiber_ports SET reservation_id=$2 WHERE id=$1', [portId, r.id]);
    await audit(q, actor, 'fiber_reservation', r.id, 'RESERVE', { provider: i.providerId, dp: dpId, port: portId, customer: i.customerRef, minutes: ttl });
    return r;
  });
}

async function release(q: Queryable, id: string, actor: string, to: 'RELEASED' | 'EXPIRED'): Promise<void> {
  const r = (await q.query(`UPDATE fiber_reservations SET state=$2, released_at=now() WHERE id=$1 AND state IN ('ACTIVE','CONFIRMED') RETURNING port_id`, [id, to])).rows[0];
  if (!r) return;
  if (r.portId) await q.query(`UPDATE fiber_ports SET state='AVAILABLE', reservation_id=NULL, reserved_until=NULL, updated_at=now() WHERE id=$1 AND state IN ('RESERVED_CHECKOUT','RESERVED_ORDER')`, [r.portId]);
  await audit(q, actor, 'fiber_reservation', id, to === 'EXPIRED' ? 'EXPIRE' : 'RELEASE');
}

async function load(q: Queryable, id: string): Promise<Row> {
  const r = (await q.query('SELECT * FROM fiber_reservations WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!r) throw notFound('reservation', id);
  return r;
}

/** Placing the order: the lock becomes a hold for that order, with no clock. A lock that already ran out cannot be confirmed. */
export async function confirmReservation(db: Db, id: string, orderRef: string, actor = 'system'): Promise<Row> {
  if (!orderRef?.trim()) throw invalid('Say which order this port is for.');
  return db.tx(async (q) => {
    const r = await load(q, id);
    if (r.state === 'CONFIRMED' && r.orderRef === orderRef) return r;   // confirming twice is harmless
    if (r.state !== 'ACTIVE') throw rejected(`That reservation is ${r.state.toLowerCase()}.`);
    if (new Date(r.expiresAt) < new Date()) throw rejected('The port lock ran out before the order was placed. Please check availability again.');
    const c = (await q.query(`UPDATE fiber_reservations SET state='CONFIRMED', order_ref=$2, confirmed_at=now(), expires_at=NULL WHERE id=$1 RETURNING *`, [id, orderRef])).rows[0]!;
    if (r.portId) await q.query(`UPDATE fiber_ports SET state='RESERVED_ORDER', reserved_until=NULL, updated_at=now() WHERE id=$1`, [r.portId]);
    await audit(q, actor, 'fiber_reservation', id, 'CONFIRM', { order: orderRef });
    return c;
  });
}
export async function releaseReservation(db: Db, id: string, actor = 'system'): Promise<Row> {
  return db.tx(async (q) => { await load(q, id); await release(q, id, actor, 'RELEASED'); return (await q.query('SELECT * FROM fiber_reservations WHERE id=$1', [id])).rows[0]!; });
}
/** The installation is done and the customer is on the port. */
export async function activateReservation(db: Db, id: string, actor = 'system'): Promise<Row> {
  return db.tx(async (q) => {
    const r = await load(q, id);
    if (r.state !== 'CONFIRMED') throw rejected('Only a confirmed reservation can be activated.');
    const a = (await q.query(`UPDATE fiber_reservations SET state='ACTIVATED' WHERE id=$1 RETURNING *`, [id])).rows[0]!;
    if (r.portId) await q.query(`UPDATE fiber_ports SET state='IN_USE', updated_at=now() WHERE id=$1`, [r.portId]);
    await audit(q, actor, 'fiber_reservation', id, 'ACTIVATE');
    return a;
  });
}
export async function getReservation(q: Queryable, id: string): Promise<Row> {
  const r = (await q.query('SELECT * FROM fiber_reservations WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound('reservation', id);
  return r;
}
/** Frees every lock whose time has run out. Safe to run often. */
export async function sweepExpiredLocks(db: Db): Promise<{ released: number }> {
  return db.tx(async (q) => {
    const rows = (await q.query(`SELECT id FROM fiber_reservations WHERE state='ACTIVE' AND expires_at < now() FOR UPDATE SKIP LOCKED`)).rows;
    for (const r of rows) await release(q, r.id, 'system', 'EXPIRED');
    await q.query(`UPDATE fiber_ports SET state='AVAILABLE', reservation_id=NULL, reserved_until=NULL, updated_at=now() WHERE state='RESERVED_CHECKOUT' AND reserved_until < now()`);
    return { released: rows.length };
  });
}
