import { createHmac } from 'node:crypto';
import type { Db, Queryable, Row } from './db.js';
import { audit } from './audit.js';
import { invalid, notFound, rejected } from './errors.js';
import { resumeService, suspendService } from './lifecycle.js';

/**
 * The fraud desk: alerts for an analyst to look at, a hard bar that cuts a service off, and a blacklist of identities that may not be signed up.
 *
 * Alerts come from our own rules (`scanSimSwaps`), from a usage feed that calls `raiseAlert` (`USAGE_SPIKE`), or from an analyst. The hard bar is the
 * service lifecycle's FRAUD suspension, so nothing but a fraud release lifts it. The blacklist keeps only a keyed hash of each value, like the ID hash.
 */
export const ALERT_KINDS = ['SIM_SWAP_ANOMALY', 'USAGE_SPIKE', 'MANUAL', 'OTHER'] as const;
export const FRAUD_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const BLACKLIST_KINDS = ['ID_DOCUMENT', 'MSISDN', 'ICCID', 'IMEI', 'EMAIL'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type BlacklistKind = (typeof BLACKLIST_KINDS)[number];

export interface NewAlert {
  kind: AlertKind; severity?: (typeof FRAUD_SEVERITIES)[number]; summary: string; serviceId?: string | null; accountId?: string | null; customerId?: string | null;
  identifier?: string | null; detail?: Record<string, unknown>; source?: 'SCAN' | 'NETWORK' | 'MANUAL'; dedupeKey?: string; actor?: string;
}

/** Records an alert. The same dedupe key while one is still open returns the open one instead of a second. */
export async function raiseAlert(q: Queryable, a: NewAlert): Promise<{ alert: Row; created: boolean }> {
  if (!ALERT_KINDS.includes(a.kind)) throw invalid(`The kind is one of ${ALERT_KINDS.join(', ')}.`);
  if (a.severity && !FRAUD_SEVERITIES.includes(a.severity)) throw invalid(`The severity is one of ${FRAUD_SEVERITIES.join(', ')}.`);
  if (!a.summary?.trim()) throw invalid('Say what looks wrong.');
  const r = await q.query(
    `INSERT INTO fraud_alerts (kind, severity, service_id, account_id, customer_id, identifier, summary, detail, source, dedupe_key, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'OPEN' DO NOTHING RETURNING *`,
    [a.kind, a.severity ?? 'MEDIUM', a.serviceId ?? null, a.accountId ?? null, a.customerId ?? null, a.identifier ?? null, a.summary.trim().slice(0, 500), JSON.stringify(a.detail ?? {}),
     a.source ?? 'MANUAL', a.dedupeKey ?? null, a.actor ?? 'system']);
  if (r.rows[0]) return { alert: r.rows[0], created: true };
  return { alert: (await q.query(`SELECT * FROM fraud_alerts WHERE dedupe_key=$1 AND status='OPEN'`, [a.dedupeKey])).rows[0]!, created: false };
}

export async function listAlerts(q: Queryable, f: { status?: string; kind?: string; limit?: number } = {}): Promise<{ items: Row[]; open: number }> {
  const where: string[] = []; const vals: unknown[] = [];
  if (f.status) { vals.push(f.status); where.push(`status=$${vals.length}`); }
  if (f.kind) { vals.push(f.kind); where.push(`kind=$${vals.length}`); }
  vals.push(Math.min(Math.max(f.limit ?? 100, 1), 500));
  const items = (await q.query(`SELECT * FROM fraud_alerts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (status='OPEN') DESC, created_at DESC LIMIT $${vals.length}`, vals)).rows;
  const open = Number((await q.query(`SELECT count(*) AS n FROM fraud_alerts WHERE status='OPEN'`)).rows[0]!.n);
  return { items, open };
}

/** Closes an alert as a real case of fraud (CONFIRMED) or a false alarm (DISMISSED). */
export async function resolveAlert(db: Db, id: string, decision: 'CONFIRMED' | 'DISMISSED', actor: string, note?: string): Promise<Row> {
  if (decision !== 'CONFIRMED' && decision !== 'DISMISSED') throw invalid('Confirm or dismiss the alert.');
  return db.tx(async (q) => {
    const a = (await q.query('SELECT * FROM fraud_alerts WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!a) throw notFound('alert', id);
    if (a.status !== 'OPEN') throw rejected('That alert is already closed.');
    const r = (await q.query(`UPDATE fraud_alerts SET status=$2, handled_by=$3, handled_at=now(), note=$4 WHERE id=$1 RETURNING *`, [id, decision, actor, note?.trim() || null])).rows[0]!;
    await audit(q, actor, 'fraud_alert', id, decision, { kind: a.kind, serviceId: a.serviceId, security: true });
    return r;
  });
}

// ───────────────────────── SIM-swap anomalies ─────────────────────────
export interface SwapScanOptions { windowDays?: number; swapsToFlag?: number; numberChangeDays?: number; now?: Date; actor?: string }

/**
 * Looks at recent SIM swaps and raises an alert for the ones that look like account takeover: the same service swapped more than once in the window, or
 * a swap soon after the number was changed (a thief moves the line before taking it over). Safe to run often; an open alert is never duplicated.
 */
export async function scanSimSwaps(db: Db, o: SwapScanOptions = {}): Promise<{ scanned: number; raised: number }> {
  const windowDays = o.windowDays ?? 30; const flagAt = o.swapsToFlag ?? 2; const nearDays = o.numberChangeDays ?? 7;
  const since = new Date((o.now ?? new Date()).getTime() - windowDays * 86_400_000).toISOString();
  return db.tx(async (q) => {
    const swaps = (await q.query(
      `SELECT entity_id AS service_id, count(*)::int AS swaps, min(at) AS first_at, max(at) AS last_at, array_agg(detail->>'reason') AS reasons
         FROM audit_log WHERE entity='service' AND action='SIM_SWAP' AND at >= $1 GROUP BY entity_id`, [since])).rows;
    let raised = 0;
    for (const s of swaps) {
      const svc = (await q.query('SELECT id, account_id, customer_id, identifier FROM services WHERE id=$1', [s.serviceId])).rows[0];
      if (!svc) continue;
      const why: string[] = []; let severity: 'MEDIUM' | 'HIGH' = 'MEDIUM';
      if (s.swaps >= flagAt) { why.push(`${s.swaps} SIM swaps in ${windowDays} days`); severity = 'HIGH'; }
      const change = (await q.query(`SELECT max(at) AS at FROM audit_log WHERE entity='service' AND entity_id=$1 AND action IN ('MSISDN_CHANGE','OWNERSHIP_TRANSFER') AND at >= $2::timestamptz - make_interval(days => $3)`, [s.serviceId, s.firstAt, nearDays])).rows[0];
      if (change?.at && new Date(change.at) <= new Date(s.lastAt)) { why.push(`the number or owner changed within ${nearDays} days of a swap`); severity = 'HIGH'; }
      if (!why.length) continue;
      const r = await raiseAlert(q, { kind: 'SIM_SWAP_ANOMALY', severity, summary: `${svc.identifier}: ${why.join('; ')}`, serviceId: svc.id, accountId: svc.accountId, customerId: svc.customerId, identifier: svc.identifier,
        detail: { swaps: s.swaps, reasons: s.reasons, windowDays }, source: 'SCAN', dedupeKey: `simswap:${svc.id}`, actor: o.actor ?? 'system' });
      if (r.created) raised += 1;
    }
    return { scanned: swaps.length, raised };
  });
}

/** Swaps in the last days with who did them, for the analyst's table. */
export async function recentSimSwaps(q: Queryable, days = 30): Promise<Row[]> {
  return (await q.query(
    `SELECT a.entity_id AS service_id, s.identifier, a.actor, a.at, a.detail->>'reason' AS reason, a.detail->>'kind' AS sim_kind,
            (SELECT count(*)::int FROM audit_log b WHERE b.entity='service' AND b.entity_id=a.entity_id AND b.action='SIM_SWAP' AND b.at >= now() - make_interval(days => $1)) AS swaps_in_window
       FROM audit_log a LEFT JOIN services s ON s.id::text = a.entity_id
      WHERE a.entity='service' AND a.action='SIM_SWAP' AND a.at >= now() - make_interval(days => $1) ORDER BY a.at DESC LIMIT 200`, [days])).rows;
}

// ───────────────────────── hard bar ─────────────────────────
/** Cuts a service off completely (calls, data and SMS, in and out) and records why. Only `releaseBar` lifts it. */
export async function hardBar(db: Db, serviceId: string, reason: string, actor: string): Promise<Row> {
  if (!reason?.trim()) throw invalid('Say why the service is being barred.');
  const s = await suspendService(db, serviceId, 'FRAUD', actor, { kind: 'FRAUD' });
  await audit(db, actor, 'service', serviceId, 'FRAUD_BAR', { reason: reason.trim(), security: true });
  return s;
}
export async function releaseBar(db: Db, serviceId: string, reason: string, actor: string): Promise<Row> {
  if (!reason?.trim()) throw invalid('Say why the bar is being lifted.');
  const cur = (await db.query('SELECT status, suspension_kind FROM services WHERE id=$1', [serviceId])).rows[0];
  if (!cur) throw notFound('service', serviceId);
  if (cur.status !== 'SUSPENDED' || cur.suspensionKind !== 'FRAUD') throw rejected('This service is not under a fraud bar.');
  const s = await resumeService(db, serviceId, actor);
  await audit(db, actor, 'service', serviceId, 'FRAUD_RELEASE', { reason: reason.trim(), security: true });
  return s;
}

// ───────────────────────── blacklist ─────────────────────────
const norm = (kind: BlacklistKind, v: string) => (kind === 'EMAIL' ? v.trim().toLowerCase() : kind === 'MSISDN' ? v.replace(/[\s\-()]/g, '') : v.trim().toUpperCase());
const pepper = () => process.env.MERIDIAN_ID_PEPPER ?? 'dev-only-pepper';
/** The keyed hash a value is held under. The ID-document hash is the same one the customer record keeps, so a listed document matches at once. */
export const blacklistHash = (kind: BlacklistKind, value: string): string => createHmac('sha256', pepper()).update(norm(kind, value)).digest('hex');
const hint = (v: string) => (v.length <= 4 ? '****' : `…${v.slice(-3)}`);

export async function blacklistAdd(q: Queryable, i: { kind: BlacklistKind; value?: string; hash?: string; hint?: string; reason: string; actor: string }): Promise<Row> {
  if (!BLACKLIST_KINDS.includes(i.kind)) throw invalid(`The kind is one of ${BLACKLIST_KINDS.join(', ')}.`);
  if (!i.reason?.trim()) throw invalid('Say why this is being blacklisted.');
  if (!i.value?.trim() && !i.hash) throw invalid('Enter the value to blacklist.');
  const h = i.hash ?? blacklistHash(i.kind, i.value!);
  const r = await q.query(`INSERT INTO fraud_blacklist (kind, value_hash, value_hint, reason, added_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (kind, value_hash) WHERE removed_at IS NULL DO NOTHING RETURNING *`,
    [i.kind, h, i.hint ?? hint(norm(i.kind, i.value ?? '')), i.reason.trim().slice(0, 300), i.actor]);
  if (!r.rows[0]) throw rejected('That is already on the blacklist.');
  await audit(q, i.actor, 'blacklist', r.rows[0].id, 'ADD', { kind: i.kind, hint: r.rows[0].valueHint, security: true });
  return r.rows[0];
}
export async function blacklistRemove(q: Queryable, id: string, actor: string): Promise<void> {
  const r = await q.query(`UPDATE fraud_blacklist SET removed_by=$2, removed_at=now() WHERE id=$1 AND removed_at IS NULL RETURNING kind, value_hint`, [id, actor]);
  if (!r.rows[0]) throw notFound('blacklist entry', id);
  await audit(q, actor, 'blacklist', id, 'REMOVE', { kind: r.rows[0].kind, hint: r.rows[0].valueHint, security: true });
}
export async function listBlacklist(q: Queryable): Promise<Row[]> {
  return (await q.query(`SELECT id, kind, value_hint, reason, added_by, added_at FROM fraud_blacklist WHERE removed_at IS NULL ORDER BY added_at DESC LIMIT 500`)).rows;
}
/** Whether any of the given values is blacklisted (an ID document hash is passed as `idHash`). */
export async function blacklistHit(q: Queryable, v: { idHash?: string | null; msisdn?: string | null; iccid?: string | null; imei?: string | null; email?: string | null }): Promise<BlacklistKind | null> {
  const probes: [BlacklistKind, string][] = [];
  if (v.idHash) probes.push(['ID_DOCUMENT', v.idHash]);
  if (v.msisdn) probes.push(['MSISDN', blacklistHash('MSISDN', v.msisdn)]);
  if (v.iccid) probes.push(['ICCID', blacklistHash('ICCID', v.iccid)]);
  if (v.imei) probes.push(['IMEI', blacklistHash('IMEI', v.imei)]);
  if (v.email) probes.push(['EMAIL', blacklistHash('EMAIL', v.email)]);
  for (const [kind, h] of probes) {
    if ((await q.query('SELECT 1 FROM fraud_blacklist WHERE kind=$1 AND value_hash=$2 AND removed_at IS NULL', [kind, h])).rows[0]) return kind;
  }
  return null;
}
/** Refuses with a neutral message (it does not say which value matched) when anything is blacklisted. */
export async function assertNotBlacklisted(q: Queryable, v: Parameters<typeof blacklistHit>[1]): Promise<void> {
  if (await blacklistHit(q, v)) throw rejected('This request cannot be accepted. Please contact the operator.');
}
