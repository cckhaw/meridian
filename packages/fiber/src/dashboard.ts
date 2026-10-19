import { audit, conflict, invalid, notFound, queueOutbox, rejected, type Db, type Queryable, type Row } from '@meridian/core';
import { classifyPorts, usablePorts, type PortLevel } from './port-level.js';
import { getFiberSettings } from './settings.js';

/** The port exhaustion and waitlist dashboard: which distribution points are running out, who is waiting, and the expansion requests raised for them. */
export interface DpPressure {
  dpId: string; code: string; name: string; provider: string; city: string | null; lat: number; lng: number; splitter: number;
  total: number; available: number; reserved: number; inUse: number; faulty: number; utilisationPercent: number; level: PortLevel; waiting: number; expansion: { id: string; status: string } | null;
}

export async function exhaustionReport(q: Queryable, f: { level?: PortLevel; providerId?: string } = {}): Promise<{ items: DpPressure[]; summary: Record<PortLevel, number> & { waiting: number } }> {
  const s = await getFiberSettings(q);
  const rows = (await q.query(
    `SELECT d.id, d.code, d.name, d.city, d.lat, d.lng, d.splitter_ratio, pr.code AS provider,
            count(*) FILTER (WHERE p.state='AVAILABLE' OR (p.state='RESERVED_CHECKOUT' AND p.reserved_until < now()))::int AS available,
            count(*) FILTER (WHERE p.state IN ('RESERVED_ORDER') OR (p.state='RESERVED_CHECKOUT' AND p.reserved_until >= now()))::int AS reserved,
            count(*) FILTER (WHERE p.state='IN_USE')::int AS in_use, count(*) FILTER (WHERE p.state='FAULTY')::int AS faulty, count(p.id)::int AS total,
            (SELECT count(*) FROM fiber_waitlist w WHERE w.dp_id=d.id AND w.status='WAITING')::int AS waiting,
            (SELECT e.id FROM fiber_expansion_requests e WHERE e.dp_id=d.id AND e.status IN ('OPEN','IN_PROGRESS')) AS exp_id,
            (SELECT e.status FROM fiber_expansion_requests e WHERE e.dp_id=d.id AND e.status IN ('OPEN','IN_PROGRESS')) AS exp_status
       FROM fiber_dps d JOIN fiber_providers pr ON pr.id=d.provider_id LEFT JOIN fiber_ports p ON p.dp_id=d.id WHERE d.status='ACTIVE' ${f.providerId ? 'AND d.provider_id=$1' : ''} GROUP BY d.id, pr.code`, f.providerId ? [f.providerId] : [])).rows;
  const items: DpPressure[] = rows.map((r) => {
    const usable = usablePorts({ available: r.available, total: r.total, faulty: r.faulty });
    const pct = Math.round(((usable - r.available) / usable) * 100);
    const level = classifyPorts({ available: r.available, total: r.total, faulty: r.faulty }, s);
    return { dpId: r.id, code: r.code, name: r.name, provider: r.provider, city: r.city, lat: r.lat, lng: r.lng, splitter: r.splitterRatio, total: r.total, available: r.available, reserved: r.reserved, inUse: r.inUse, faulty: r.faulty, utilisationPercent: pct, level, waiting: r.waiting, expansion: r.expId ? { id: r.expId, status: r.expStatus } : null };
  });
  const order: Record<PortLevel, number> = { EXHAUSTED: 0, LOW: 1, OK: 2 };
  const all = items.sort((a, b) => order[a.level] - order[b.level] || b.waiting - a.waiting || a.available - b.available);
  const summary = { EXHAUSTED: all.filter((x) => x.level === 'EXHAUSTED').length, LOW: all.filter((x) => x.level === 'LOW').length, OK: all.filter((x) => x.level === 'OK').length, waiting: all.reduce((n, x) => n + x.waiting, 0) };
  return { items: f.level ? all.filter((x) => x.level === f.level) : all, summary };
}

export interface WaitlistInput { providerId: string; dpId?: string | null; customerRef?: string; contact?: string; lat?: number; lng?: number; address?: string; speedMbps?: number }
export async function joinWaitlist(q: Queryable, i: WaitlistInput): Promise<Row> {
  if (!i.contact?.trim() && !i.customerRef?.trim()) throw invalid('Give a way to reach the customer when a port frees up.');
  if (!(await q.query('SELECT 1 FROM fiber_providers WHERE id=$1', [i.providerId])).rows[0]) throw notFound('provider', i.providerId);
  const dup = (await q.query(`SELECT * FROM fiber_waitlist WHERE provider_id=$1 AND status='WAITING' AND coalesce(customer_ref,contact)=$2 AND dp_id IS NOT DISTINCT FROM $3`, [i.providerId, i.customerRef ?? i.contact, i.dpId ?? null])).rows[0];
  if (dup) return dup;
  return (await q.query(`INSERT INTO fiber_waitlist (provider_id, dp_id, customer_ref, contact, lat, lng, address, speed_mbps) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [i.providerId, i.dpId ?? null, i.customerRef ?? null, i.contact ?? null, i.lat ?? null, i.lng ?? null, i.address ?? null, i.speedMbps ?? null])).rows[0]!;
}
export async function listWaitlist(q: Queryable, f: { dpId?: string; status?: string; limit?: number } = {}): Promise<Row[]> {
  const w: string[] = []; const v: unknown[] = [];
  if (f.dpId) { v.push(f.dpId); w.push(`dp_id=$${v.length}`); }
  if (f.status) { v.push(f.status); w.push(`status=$${v.length}`); }
  v.push(Math.min(f.limit ?? 200, 1000));
  return (await q.query(`SELECT w.*, d.code AS dp_code FROM fiber_waitlist w LEFT JOIN fiber_dps d ON d.id=w.dp_id ${w.length ? 'WHERE ' + w.join(' AND ').replace(/\b(dp_id|status)\b/g, 'w.$1') : ''} ORDER BY w.created_at LIMIT $${v.length}`, v)).rows;
}
export async function cancelWaitlist(q: Queryable, id: string): Promise<void> {
  const r = await q.query(`UPDATE fiber_waitlist SET status='CANCELLED' WHERE id=$1 AND status='WAITING'`, [id]);
  if (!r.rowCount) throw notFound('waitlist entry', id);
}
/** Tells the first people in line, as many as there are free ports, that a port is available (through the notification outbox). */
export async function notifyWaitlist(db: Db, dpId: string, actor: string): Promise<{ notified: number }> {
  return db.tx(async (q) => {
    const free = Number((await q.query(`SELECT count(*) AS n FROM fiber_ports WHERE dp_id=$1 AND (state='AVAILABLE' OR (state='RESERVED_CHECKOUT' AND reserved_until < now()))`, [dpId])).rows[0]!.n);
    if (!free) throw rejected('There is no free port on that distribution point yet.');
    const next = (await q.query(`SELECT * FROM fiber_waitlist WHERE dp_id=$1 AND status='WAITING' ORDER BY created_at LIMIT $2 FOR UPDATE`, [dpId, free])).rows;
    for (const w of next) {
      await q.query(`UPDATE fiber_waitlist SET status='NOTIFIED', notified_at=now() WHERE id=$1`, [w.id]);
      await queueOutbox(q, { kind: 'NOTIFY', instruction: 'FIBER_PORT_AVAILABLE', payload: { waitlistId: w.id, customerRef: w.customerRef, contact: w.contact, address: w.address, speedMbps: w.speedMbps } });
    }
    if (next.length) await audit(q, actor, 'fiber_dp', dpId, 'WAITLIST_NOTIFIED', { count: next.length });
    return { notified: next.length };
  });
}

export async function requestExpansion(q: Queryable, actor: string, dpId: string, note?: string): Promise<Row> {
  if (!(await q.query('SELECT 1 FROM fiber_dps WHERE id=$1', [dpId])).rows[0]) throw notFound('distribution point', dpId);
  const waiting = Number((await q.query(`SELECT count(*) AS n FROM fiber_waitlist WHERE dp_id=$1 AND status='WAITING'`, [dpId])).rows[0]!.n);
  try {
    const r = (await q.query(`INSERT INTO fiber_expansion_requests (dp_id, waiting, note, requested_by) VALUES ($1,$2,$3,$4) RETURNING *`, [dpId, waiting, note?.slice(0, 500) ?? null, actor])).rows[0]!;
    await audit(q, actor, 'fiber_dp', dpId, 'EXPANSION_REQUESTED', { waiting });
    return r;
  } catch (e) { if ((e as { code?: string }).code === '23505') throw conflict('An expansion request is already open for that distribution point.'); throw e; }
}
export async function updateExpansion(q: Queryable, actor: string, id: string, status: 'IN_PROGRESS' | 'DONE' | 'REJECTED', note?: string): Promise<Row> {
  if (!['IN_PROGRESS', 'DONE', 'REJECTED'].includes(status)) throw invalid('The status is IN_PROGRESS, DONE or REJECTED.');
  const r = (await q.query(`UPDATE fiber_expansion_requests SET status=$2, note=coalesce($3, note), updated_by=$4, updated_at=now() WHERE id=$1 AND status IN ('OPEN','IN_PROGRESS') RETURNING *`, [id, status, note ?? null, actor])).rows[0];
  if (!r) throw notFound('open expansion request', id);
  await audit(q, actor, 'fiber_expansion', id, status);
  return r;
}
export const listExpansions = async (q: Queryable): Promise<Row[]> => (await q.query(`SELECT e.*, d.code AS dp_code, d.name AS dp_name FROM fiber_expansion_requests e JOIN fiber_dps d ON d.id=e.dp_id ORDER BY (e.status IN ('OPEN','IN_PROGRESS')) DESC, e.requested_at DESC LIMIT 200`)).rows;
