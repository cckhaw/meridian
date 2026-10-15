import { randomUUID } from 'node:crypto';
import { behaviourOf } from '@meridian/types';
import { audit } from './audit.js';
import { getOffer } from './catalog.js';
import type { Db, Queryable, Row } from './db.js';
import { invalid, notFound } from './errors.js';
import { getServiceKind } from './service-kinds.js';
import { OCS_COMMANDS, OCS_COMMAND_LABEL, OCS_VENDORS, TEMPLATE_VARS, ocsVendor, type OcsCommandName, type OcsConnector, type OcsPlan, type OcsRequest, type PlanParams } from './ocs-vendors/index.js';

/**
 * Provisioning into the online charging system (OCS), whichever vendor it is.
 *
 *  1. Something happens to a subscriber in Meridian (starts, changes plan, is barred or restored, gets a new SIM or number, ends). In the SAME transaction
 *     an `ocs_jobs` row says what must happen, in vendor-neutral terms (`OcsRequest`).
 *  2. A dispatcher (run by your scheduler, or the Run now button) hands each job to the connector of the chosen vendor, in order per subscriber, retrying
 *     with a back-off when the OCS is down, and keeping a job that cannot be delivered until someone retries it.
 *
 * Only offers with an OCS plan code are provisioned. A subscriber that was never provisioned is never sent anything else, so turning the OCS on does not
 * touch services that started before.
 */
export interface OcsSettings { vendor: string | null; enabled: boolean; /** What was entered for each vendor, kept when you switch to another. */ configs: Record<string, Record<string, unknown>> }
const DEFAULT: OcsSettings = { vendor: null, enabled: false, configs: {} };

export async function getOcsSettings(q: Queryable): Promise<OcsSettings> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='ocs'`)).rows[0]?.value ?? {};
  return { ...DEFAULT, ...v, configs: v.configs ?? {} };
}

export async function setOcsSettings(q: Queryable, actor: string, i: { vendor: string | null; enabled: boolean; config?: unknown }): Promise<OcsSettings> {
  const cur = await getOcsSettings(q);
  if (i.enabled && !i.vendor) throw invalid('Choose the charging system first.');
  const next: OcsSettings = { vendor: i.vendor, enabled: i.enabled, configs: { ...cur.configs } };
  if (i.vendor) {
    const v = ocsVendor(i.vendor);
    next.configs[i.vendor] = v.validate(i.config ?? cur.configs[i.vendor] ?? v.defaults());
  }
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('ocs', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(next), actor]);
  await audit(q, actor, 'settings', 'ocs', 'update', { vendor: next.vendor, enabled: next.enabled });
  return next;
}

/** The connector for the chosen vendor, or null when the OCS is off. */
export async function activeConnector(q: Queryable, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Promise<OcsConnector | null> {
  const s = await getOcsSettings(q);
  if (!s.enabled || !s.vendor) return null;
  const v = ocsVendor(s.vendor);
  return v.create(v.validate(s.configs[s.vendor] ?? v.defaults()), env, fetchImpl);
}

export const planCodeOk = (c: unknown): c is string => typeof c === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,59}$/.test(c);
export function cleanOcsMapping(raw: unknown): { planCode: string; params?: PlanParams } | undefined {
  if (raw == null) return undefined;
  const r = raw as { planCode?: unknown; params?: unknown };
  if (r.planCode === '' || r.planCode === undefined) return undefined;
  if (!planCodeOk(r.planCode)) throw invalid('The OCS plan code is 1 to 60 letters, digits, dots, dashes, colons or slashes.');
  const params: PlanParams = {};
  for (const [k, v] of Object.entries((r.params ?? {}) as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(k)) throw invalid(`The OCS parameter name “${k}” is not valid.`);
    if (typeof v === 'string' ? v.length > 100 : typeof v !== 'number' && typeof v !== 'boolean') throw invalid(`The OCS parameter “${k}” must be text, a number or yes/no.`);
    params[k] = v as string | number | boolean;
  }
  return { planCode: r.planCode, ...(Object.keys(params).length ? { params } : {}) };
}

const planOf = (o: { id: string; name: string; ocs?: { planCode: string; params?: PlanParams } }): OcsPlan | null => (o.ocs?.planCode ? { offerId: o.id, offerName: o.name, planCode: o.ocs.planCode, params: o.ocs.params ?? {} } : null);

type Extra = Partial<Pick<OcsRequest, 'barring' | 'identity' | 'termination'>> & { previousOfferId?: string };

/**
 * Queues what has to happen to a subscriber, if the OCS is on and the subscriber is (or, for PROVISION and CHANGE_PLAN, should become) one of its own.
 * Call it inside the transaction that made the change. Returns the job id, or null when nothing was queued.
 */
export async function enqueueOcs(q: Queryable, command: OcsCommandName, serviceId: string, extra: Extra = {}): Promise<number | null> {
  const st = await getOcsSettings(q);
  if (!st.enabled || !st.vendor) return null;
  const svc = (await q.query('SELECT * FROM services WHERE id=$1', [serviceId])).rows[0];
  if (!svc) return null;
  const provisioned = (await q.query(`SELECT 1 FROM ocs_jobs WHERE service_id=$1 AND command='PROVISION' LIMIT 1`, [serviceId])).rows.length > 0;
  const kind = await getServiceKind(q, (svc.serviceKind ?? svc.type) as string);
  if (kind && !kind.ocsEnabled) return null; // the service type is switched off for the charging system
  const offer = await getOffer(q, svc.offerId as string).catch(() => null);
  const plan = offer ? planOf(offer) : null;
  let cmd = command;
  if (cmd === 'CHANGE_PLAN' && !provisioned) cmd = 'PROVISION'; // it was not in the OCS before: it starts there now
  if (cmd === 'PROVISION' || cmd === 'CHANGE_PLAN') {
    if (!plan) {
      if (cmd === 'CHANGE_PLAN') await audit(q, 'ocs', 'service', serviceId, 'OCS_PLAN_UNMAPPED', { offerId: svc.offerId });
      return null;
    }
    if (cmd === 'PROVISION' && provisioned) return null;
  } else if (!provisioned) return null;

  const cust = (await q.query('SELECT segment, market_code FROM customers WHERE id=$1', [svc.customerId])).rows[0];
  const acct = (await q.query('SELECT credit_limit_minor FROM accounts WHERE id=$1', [svc.accountId])).rows[0];
  const prior = extra.previousOfferId ? await getOffer(q, extra.previousOfferId).catch(() => null) : null;
  const req: OcsRequest = {
    command: cmd, idempotencyKey: cmd === 'PROVISION' ? `ocs:PROVISION:${serviceId}` : `ocs:${cmd}:${serviceId}:${randomUUID()}`, at: new Date().toISOString(),
    subscriber: {
      serviceId, identifier: svc.identifier, serviceType: svc.type, serviceKind: svc.serviceKind ?? null, iccid: svc.iccid ?? null, imsi: svc.imsi ?? null, customerId: svc.customerId, accountId: svc.accountId,
      segment: cust?.segment ? String(cust.segment).trim() : null, marketCode: cust?.marketCode ? String(cust.marketCode).trim() : null, creditLimitMinor: acct?.creditLimitMinor == null ? null : Number(acct.creditLimitMinor),
    },
    plan, ...(cmd === 'PROVISION' ? { expiresAt: svc.expiresAt ? new Date(svc.expiresAt).toISOString() : null } : {}),
    ...(cmd === 'CHANGE_PLAN' ? { previousPlan: prior ? planOf(prior) : null } : {}),
    ...(extra.barring ? { barring: extra.barring } : {}), ...(extra.identity ? { identity: extra.identity } : {}), ...(extra.termination ? { termination: extra.termination } : {}),
  };
  const r = await q.query(`INSERT INTO ocs_jobs (service_id, command, idempotency_key, payload, vendor) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [serviceId, cmd, req.idempotencyKey, JSON.stringify(req), st.vendor]);
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

// ───────────────────────── delivery ─────────────────────────
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 43_200];
export const OCS_MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
export interface DispatchResult { attempted: number; sent: number; skipped: number; retrying: number; dead: number; notReady?: string }

/**
 * Delivers due jobs, oldest first, one subscriber's jobs strictly in order (a job waits for the earlier ones of the same subscriber to be delivered).
 * Safe to run from several places at once. A failure that is worth retrying waits 1 min, 5 min, 30 min, 2 h, 12 h; after that, or on a refusal, the job
 * is kept as DEAD and Ops hear about it. Nothing is lost: a DEAD job stays until retried, and later jobs of that subscriber wait behind it.
 */
export async function dispatchOcs(db: Db, o: { limit?: number; now?: Date; env?: NodeJS.ProcessEnv; connector?: OcsConnector | null } = {}): Promise<DispatchResult> {
  const res: DispatchResult = { attempted: 0, sent: 0, skipped: 0, retrying: 0, dead: 0 };
  const connector = o.connector === undefined ? await activeConnector(db, o.env) : o.connector;
  if (!connector) { res.notReady = 'The OCS is switched off.'; return res; }
  const problem = connector.problem();
  if (problem) { res.notReady = problem; return res; }
  const now = o.now ?? new Date();
  for (let n = 0; n < (o.limit ?? 25); n++) {
    const job = await db.tx(async (q) => {
      const j = (await q.query(
        `SELECT * FROM ocs_jobs j WHERE j.status='PENDING' AND j.next_attempt_at <= $1 AND (j.claimed_until IS NULL OR j.claimed_until < $1)
           AND NOT EXISTS (SELECT 1 FROM ocs_jobs e WHERE e.service_id = j.service_id AND e.id < j.id AND e.status IN ('PENDING','DEAD'))
         ORDER BY j.id LIMIT 1 FOR UPDATE SKIP LOCKED`, [now])).rows[0];
      if (!j) return null;
      await q.query(`UPDATE ocs_jobs SET claimed_until = $2::timestamptz + interval '2 minutes' WHERE id=$1`, [j.id, now]);
      return j;
    });
    if (!job) break;
    res.attempted++;
    let out;
    try { out = await connector.handle(job.payload as OcsRequest); } catch (e) { out = { ok: false as const, retryable: true, detail: `The connector failed: ${(e as Error).message}` }; }
    const attempts = Number(job.attempts) + 1;
    await db.tx(async (q) => {
      if (out.ok) {
        await q.query(`UPDATE ocs_jobs SET status=$2, attempts=$3, claimed_until=NULL, reference=$4, detail=$5, last_error=NULL, sent_at=$6, updated_at=now() WHERE id=$1`,
          [job.id, out.skipped ? 'SKIPPED' : 'SENT', attempts, out.reference ?? null, out.detail ?? null, now]);
        out.skipped ? res.skipped++ : res.sent++;
      } else if (out.retryable && attempts < OCS_MAX_ATTEMPTS) {
        await q.query(`UPDATE ocs_jobs SET attempts=$2, claimed_until=NULL, last_error=$3, next_attempt_at=$4::timestamptz + make_interval(secs => $5), updated_at=now() WHERE id=$1`,
          [job.id, attempts, out.detail.slice(0, 500), now, BACKOFF_SECONDS[attempts - 1]]);
        res.retrying++;
      } else {
        await q.query(`UPDATE ocs_jobs SET status='DEAD', attempts=$2, claimed_until=NULL, last_error=$3, updated_at=now() WHERE id=$1`, [job.id, attempts, out.detail.slice(0, 500)]);
        await audit(q, 'ocs', 'service', job.serviceId, 'OCS_FAILED', { command: job.command, attempts, error: out.detail.slice(0, 200) });
        await q.query(`INSERT INTO lifecycle_outbox (kind, service_id, instruction, payload) VALUES ('EVENT', $1, 'OCS_JOB_FAILED', $2)`,
          [job.serviceId, JSON.stringify({ jobId: String(job.id), command: job.command, error: out.detail.slice(0, 200) })]);
        res.dead++;
      }
    });
  }
  return res;
}

// ───────────────────────── reading and retrying ─────────────────────────
export interface OcsJobView { id: string; createdAt: string; command: OcsCommandName; status: string; attempts: number; nextAttemptAt: string | null; serviceId: string; identifier: string; planCode: string | null; vendor: string | null; reference: string | null; detail: string | null; lastError: string | null; sentAt: string | null }
const view = (r: Row): OcsJobView => ({
  id: String(r.id), createdAt: new Date(r.createdAt).toISOString(), command: r.command, status: r.status, attempts: Number(r.attempts), nextAttemptAt: r.status === 'PENDING' ? new Date(r.nextAttemptAt).toISOString() : null,
  serviceId: r.serviceId, identifier: r.payload?.subscriber?.identifier ?? '', planCode: r.payload?.plan?.planCode ?? null, vendor: r.vendor, reference: r.reference, detail: r.detail, lastError: r.lastError, sentAt: r.sentAt ? new Date(r.sentAt).toISOString() : null,
});

export async function listOcsJobs(q: Queryable, f: { status?: string; serviceId?: string; limit?: number } = {}): Promise<OcsJobView[]> {
  if (f.status && !['PENDING', 'SENT', 'SKIPPED', 'DEAD'].includes(f.status)) throw invalid('unknown status');
  const rows = (await q.query(`SELECT * FROM ocs_jobs WHERE ($1::text IS NULL OR status=$1) AND ($2::uuid IS NULL OR service_id=$2) ORDER BY id DESC LIMIT $3`, [f.status ?? null, f.serviceId ?? null, Math.min(f.limit ?? 50, 200)])).rows;
  return rows.map(view);
}

export async function retryOcsJob(q: Queryable, id: string, actor: string): Promise<OcsJobView> {
  const r = (await q.query(`UPDATE ocs_jobs SET status='PENDING', attempts=0, next_attempt_at=now(), claimed_until=NULL, updated_at=now() WHERE id=$1 AND status='DEAD' RETURNING *`, [id])).rows[0];
  if (!r) {
    if (!(await q.query('SELECT 1 FROM ocs_jobs WHERE id=$1', [id])).rows.length) throw notFound('OCS job', id);
    throw invalid('Only a job that failed for good can be retried.');
  }
  await audit(q, actor, 'service', r.serviceId, 'OCS_RETRY', { jobId: String(r.id), command: r.command });
  return view(r);
}

export interface OcsStats { pending: number; sent: number; skipped: number; dead: number; oldestPendingAt: string | null; unmappedOffers: number; unmappedNames: string[] }
export async function ocsStats(q: Queryable): Promise<OcsStats> {
  const c = (await q.query(`SELECT status, count(*)::int AS n, min(created_at) AS oldest FROM ocs_jobs GROUP BY status`)).rows;
  const n = (s: string) => Number(c.find((x) => x.status === s)?.n ?? 0);
  const pend = c.find((x) => x.status === 'PENDING');
  // Offers on sale that start a service but have no OCS plan code: they will not be provisioned.
  const offers = (await q.query(`SELECT name, kind, data FROM catalog_nodes WHERE level='OFFER' AND status='ACTIVE' AND COALESCE(data->'ocs'->>'planCode','') = '' ORDER BY name`)).rows;
  const un = offers.filter((o) => behaviourOf({ kind: o.kind, template: o.data?.template, behaviour: o.data?.behaviour }).service != null);
  return { pending: n('PENDING'), sent: n('SENT'), skipped: n('SKIPPED'), dead: n('DEAD'), oldestPendingAt: pend?.oldest ? new Date(pend.oldest).toISOString() : null, unmappedOffers: un.length, unmappedNames: un.slice(0, 8).map((o) => o.name as string) };
}

/** What the Integration page needs: the vendors with their settings forms, what is saved, and how the queue is doing. */
export async function ocsOverview(q: Queryable, env: NodeJS.ProcessEnv = process.env) {
  const s = await getOcsSettings(q);
  const vendors = Object.values(OCS_VENDORS).map((v) => ({
    id: v.id, label: v.label, summary: v.summary, notes: v.notes ?? [], real: v.real, fields: v.fields,
    config: s.configs[v.id] ?? v.defaults(), saved: !!s.configs[v.id],
    envSet: Object.fromEntries(v.fields.filter((f) => f.kind === 'env').map((f) => { const name = String((s.configs[v.id] ?? v.defaults())[f.key] ?? ''); return [name, !!(name && (env[name] ?? '').trim())]; })),
  }));
  return { vendor: s.vendor, enabled: s.enabled, vendors, commands: OCS_COMMANDS.map((c) => ({ id: c, label: OCS_COMMAND_LABEL[c] })), placeholders: [...TEMPLATE_VARS], stats: await ocsStats(q), jobs: await listOcsJobs(q, { status: 'DEAD', limit: 20 }), recent: await listOcsJobs(q, { limit: 8 }) };
}
