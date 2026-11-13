import { randomInt } from 'node:crypto';
import { audit } from './audit.js';
import { TX_SCOPE, type Db, type Queryable, type Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { CASES_FROM, listCaseIds, QUEUE_SQL, waitingCounts, wildcardPattern, type KycListFilter } from './kyc-list.js';
import { permissionsOf, roleDef, ROLE_IDS, rolePermissions, type RoleBook } from './rbac.js';
import { getRoleOverrides } from './roles-config.js';
import { getStoreSettings } from './store-settings.js';
import { notifyUser, type AlertEvent } from './user-notifications.js';

/**
 * Who reviews which KYC case, and how a case moves between people.
 *
 *  - A case that reaches the queue gets a risk, a priority, and (unless switched off) an officer, chosen to equalise the load among the officers who may review it.
 *  - Everyone with `kyc:review` sees the whole waiting list; only the assignee (or someone with `kyc:assign`) decides an assigned case.
 *  - Every step is an event on the case (the timeline) and a row in the audit log; the officer reports are computed from the events.
 */
export const EVENT_ACTIONS = ['CREATED', 'SUBMITTED', 'ASSIGNED', 'REASSIGNED', 'UNASSIGNED', 'CLAIMED', 'RELEASED', 'OPENED', 'NOTE', 'ESCALATED', 'RECOMMENDED', 'SECOND_REVIEW_DECIDED', 'DECIDED', 'RETURNED', 'REOPENED', 'SLA_BREACHED', 'QA_SAMPLED', 'QA_DONE'] as const;
export type EventAction = (typeof EVENT_ACTIONS)[number];
/** What the caller of a review action may do beyond reviewing. */
export interface ReviewActor { username: string; canAssign?: boolean; canSenior?: boolean }

const LOCK = 727060;
export const MAX_BATCH = 2000;

export const withTx = <T>(q: Queryable, fn: (q: Queryable) => Promise<T>): Promise<T> => (typeof (q as Db).tx === 'function' ? (q as Db).tx(fn) : fn(q));
/** One distribution decision at a time: the loads an officer is judged by must include what another transaction just assigned. Released with the transaction. */
const lockDistribution = (q: Queryable) => q.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);

export async function logEvent(q: Queryable, caseId: string, actor: string, action: EventAction, detail: Record<string, unknown> = {}, target: string | null = null): Promise<void> {
  await q.query('INSERT INTO kyc_case_events (case_id, actor, action, target, detail) VALUES ($1,$2,$3,$4,$5)', [caseId, actor, action, target, JSON.stringify(detail)]);
}

/** An alert that can never break the work that raised it: inside a transaction a failing insert would poison the whole transaction, so it runs under a savepoint. */
export async function safeNotify(q: Queryable, username: string, event: AlertEvent, a: { title: string; body: string; link?: string }): Promise<void> {
  const tx = TX_SCOPE.has(q);
  try {
    if (tx) await q.query('SAVEPOINT kyc_notify');
    await notifyUser(q, { username }, event, a);
    if (tx) await q.query('RELEASE SAVEPOINT kyc_notify');
  } catch {
    if (tx) { try { await q.query('ROLLBACK TO SAVEPOINT kyc_notify'); await q.query('RELEASE SAVEPOINT kyc_notify'); } catch { /* the transaction is lost anyway */ } }
  }
}
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// ───────────────────────── settings ─────────────────────────
export interface KycReviewSettings {
  /** Give every case that reaches the queue to an officer at once. Off: officers claim cases from the pool. */
  autoAssign: boolean;
  /** EQUAL: the officer with the fewest open cases (ties at random). ROUND_ROBIN: the next officer in a fixed rotation. OFF: nobody is chosen. */
  strategy: 'EQUAL' | 'ROUND_ROBIN' | 'OFF';
  /** Open cases one officer may be given automatically or claim; 0 = no limit. */
  maxOpenPerOfficer: number;
  /** A case sent back and submitted again, or reopened, returns to the officer who had it, while they are still eligible. */
  stickyOnResubmit: boolean;
  /** Open cases of an officer who goes away (or is disabled, or loses the permission) go back into the distribution. */
  redistributeAway: boolean;
  /** Hours after the review target at which a case still open is escalated to a senior officer; 0 = never. */
  escalateOverdueHours: number;
  /** A decision on a HIGH risk case is a recommendation until a different officer confirms it. */
  fourEyesHighRisk: boolean;
  /** Share of approvals (0 to 100) that another officer looks at again. */
  qaSamplePercent: number;
  /** Days after a decision during which a supervisor may reopen the case. */
  reopenDays: number;
  /** Approving needs every applicable check ticked, or a note that explains. */
  requireChecklist: boolean;
}
export const DEFAULT_REVIEW_SETTINGS: KycReviewSettings = { autoAssign: true, strategy: 'EQUAL', maxOpenPerOfficer: 0, stickyOnResubmit: true, redistributeAway: true, escalateOverdueHours: 12, fourEyesHighRisk: false, qaSamplePercent: 0, reopenDays: 14, requireChecklist: false };
const SETTINGS_KEY = 'kycReview';

export async function getKycReviewSettings(q: Queryable): Promise<KycReviewSettings> {
  const v = (await q.query(`SELECT value FROM settings WHERE key=$1`, [SETTINGS_KEY])).rows[0]?.value ?? {};
  const out = { ...DEFAULT_REVIEW_SETTINGS } as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_REVIEW_SETTINGS)) if (k in v && typeof v[k] === typeof out[k]) out[k] = v[k];
  return out as unknown as KycReviewSettings;
}

const INT_RANGES: Array<[keyof KycReviewSettings, number, number, string]> = [['maxOpenPerOfficer', 0, 1000, 'The most open cases per officer is 0 (no limit) to 1000.'], ['escalateOverdueHours', 0, 720, 'Overdue escalation is 0 (never) to 720 hours.'], ['reopenDays', 0, 365, 'Reopening is allowed for 0 to 365 days after a decision.']];
/** Validates and saves the settings. Only the fields given change. */
export async function setKycReviewSettings(q: Queryable, actor: string, input: Partial<KycReviewSettings>): Promise<KycReviewSettings> {
  const cur = await getKycReviewSettings(q);
  const next = { ...cur } as Record<string, unknown>;
  for (const [k, v] of Object.entries(input)) {
    if (!(k in DEFAULT_REVIEW_SETTINGS)) throw invalid(`unknown setting ${k}`);
    if (v === undefined) continue;
    if (typeof v !== typeof (DEFAULT_REVIEW_SETTINGS as unknown as Record<string, unknown>)[k] || (typeof v === 'number' && !Number.isFinite(v))) throw invalid(`${k} has the wrong type`);
    next[k] = v;
  }
  const s = next as unknown as KycReviewSettings;
  if (!['EQUAL', 'ROUND_ROBIN', 'OFF'].includes(s.strategy)) throw invalid('The distribution is EQUAL, ROUND_ROBIN or OFF.');
  for (const [k, lo, hi, msg] of INT_RANGES) if (!Number.isInteger(s[k]) || (s[k] as number) < lo || (s[k] as number) > hi) throw invalid(msg);
  if (s.qaSamplePercent < 0 || s.qaSamplePercent > 100) throw invalid('The quality check share is 0 to 100 percent.');
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [SETTINGS_KEY, JSON.stringify(s), actor]);
  await audit(q, actor, 'settings', SETTINGS_KEY, 'update', { from: cur, to: s });
  return s;
}

// ───────────────────────── risk and priority ─────────────────────────
export interface RiskInput {
  flags?: string[] | null; checks?: Record<string, any> | null; dateOfBirth?: string | null; idExpiry?: string | null; reasonCode?: string | null; fraudReported?: boolean | null;
  submittedAt?: string | null; createdAt?: string | null; escalatedAt?: string | null; waitingOrders?: number;
}
export type Risk = 'LOW' | 'MEDIUM' | 'HIGH';
export const PRIORITY = { overdue: 1000, escalated: 500, risk: { LOW: 100, MEDIUM: 200, HIGH: 300 } as Record<Risk, number>, waitingOrders: 50 };
const HIGH_FLAGS = ['DUPLICATE_IDENTITY', 'SUSPECTED_FRAUD', 'IMAGE_REUSED', 'PROVIDER_FAIL'];
const NEAR_EXPIRY_DAYS = 30;
const yearsOn = (dob: string, on: string) => { const [y, m, d] = dob.split('-').map(Number) as [number, number, number], [ty, tm, td] = on.split('-').map(Number) as [number, number, number]; return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0); };

/**
 * Risk and priority of a case, from what is known when it is queued. Pure.
 *  HIGH: a duplicate identity, a reused picture, a fraud report, the ID check service failing the case or reading a different name, birth date or number than was typed,
 *        an ID that is expired or about to expire, an applicant who has only just reached the minimum age.
 *  MEDIUM: any other flag (not live, identity used elsewhere, service unavailable or unsure). LOW: nothing flagged.
 * Priority (higher first): overdue 1000, escalated 500, then HIGH 300 / MEDIUM 200 / LOW 100, and 50 when an order is waiting on the case; ties go to the oldest.
 */
export function assessCase(c: RiskInput, s: { kycSlaHours: number; minAge: number }, now: Date): { risk: Risk; priority: number; overdue: boolean; dueAt: string; reasons: string[] } {
  const flags = c.flags ?? [], reasons: string[] = [];
  const today = now.toISOString().slice(0, 10);
  const pv = c.checks?.provider?.checks as Record<string, unknown> | undefined;
  if (flags.includes('DUPLICATE_IDENTITY')) reasons.push('The ID already belongs to another customer.');
  if (flags.includes('IMAGE_REUSED')) reasons.push('The same picture is on another case.');
  if (flags.includes('SUSPECTED_FRAUD') || c.fraudReported || c.reasonCode === 'SUSPECTED_FRAUD') reasons.push('Reported as suspected fraud before.');
  if (flags.includes('PROVIDER_FAIL')) reasons.push('The ID check service failed the documents.');
  if (flags.includes('PROVIDER_REVIEW') && pv && (pv.nameMatch === false || pv.dobMatch === false || pv.idNumberMatch === false)) reasons.push('The ID check service read different details from the ones typed.');
  if (c.idExpiry) {
    const days = (Date.parse(c.idExpiry.slice(0, 10)) - Date.parse(today)) / 86_400_000;
    if (days <= NEAR_EXPIRY_DAYS) reasons.push(days < 0 ? 'The ID has expired.' : 'The ID expires within 30 days.');
  }
  if (c.dateOfBirth && yearsOn(c.dateOfBirth.slice(0, 10), today) === s.minAge) reasons.push('The applicant has only just reached the minimum age.');
  const risk: Risk = reasons.length ? 'HIGH' : flags.length ? 'MEDIUM' : 'LOW';
  const since = Date.parse(c.submittedAt ?? c.createdAt ?? now.toISOString());
  const due = since + s.kycSlaHours * 3_600_000;
  const overdue = now.getTime() > due;
  const priority = (overdue ? PRIORITY.overdue : 0) + (c.escalatedAt ? PRIORITY.escalated : 0) + PRIORITY.risk[risk] + (c.waitingOrders ? PRIORITY.waitingOrders : 0);
  return { risk, priority, overdue, dueAt: new Date(due).toISOString(), reasons };
}

/** Recomputes risk and priority of the given case rows and stores them. */
async function assessRows(q: Queryable, rows: Row[]): Promise<void> {
  if (!rows.length) return;
  const s = await getStoreSettings(q);
  const waiting = await waitingCounts(q, rows.map((r) => r.customerId));
  const now = new Date();
  const ids: string[] = [], risks: string[] = [], prios: number[] = [];
  for (const r of rows) {
    const a = assessCase({ flags: r.flags, checks: r.checks, dateOfBirth: r.dateOfBirth, idExpiry: r.idExpiry, reasonCode: r.reasonCode, fraudReported: r.fraudReported, submittedAt: r.submittedAt, createdAt: r.createdAt, escalatedAt: r.escalatedAt, waitingOrders: waiting.get(r.customerId) ?? 0 }, s, now);
    ids.push(r.id); risks.push(a.risk); prios.push(a.priority);
  }
  await q.query(`UPDATE kyc_cases k SET risk=v.r, priority=v.p, risk_assessed_at=now() FROM unnest($1::uuid[], $2::text[], $3::int[]) AS v(id, r, p) WHERE k.id = v.id`, [ids, risks, prios]);
}

// ───────────────────────── who may review ─────────────────────────
export interface Reviewer {
  username: string; displayName: string; roles: string[]; isSuperuser: boolean; open: number; overdue: number; away: boolean; awayUntil: string | null;
  /** How many more cases automatic distribution may give them; null when there is no limit. */
  capacityLeft: number | null;
  /** Can be given cases automatically right now. A reviewer who is not eligible can still be assigned by hand (an away officer after a confirmation). */
  eligible: boolean; notEligibleReason: string | null;
}
export interface ReviewerX extends Reviewer { senior: boolean; assigner: boolean }

/** The ids of the roles (built-in and created, switched on, with any change applied) that hold a permission. */
const rolesHolding = (book: RoleBook, perm: 'kyc:review') => [...ROLE_IDS, ...Object.keys(book.custom)].filter((id) => rolePermissions(id, book).includes(perm));

export async function loadReviewers(q: Queryable, o: { search?: string; limit?: number; usernames?: string[] } = {}, rs?: KycReviewSettings, book?: RoleBook): Promise<ReviewerX[]> {
  const b = book ?? (await getRoleOverrides(q));
  const cfg = rs ?? (await getKycReviewSettings(q));
  const params: unknown[] = [rolesHolding(b, 'kyc:review')];
  const where = [`u.status = 'ACTIVE'`, `(u.is_superuser OR u.roles && $1::text[])`];
  const pat = wildcardPattern(o.search);
  if (pat) { params.push(pat); where.push(`(u.username ILIKE $${params.length} OR u.display_name ILIKE $${params.length})`); }
  if (o.usernames) { params.push(o.usernames.map((u) => u.toLowerCase())); where.push(`lower(u.username) = ANY($${params.length}::text[])`); }
  params.push(Math.min(Math.max(o.limit ?? 1000, 1), 1000));
  const users = (await q.query(`SELECT u.username, u.display_name, u.roles, u.is_superuser FROM users u WHERE ${where.join(' AND ')} ORDER BY lower(u.display_name), u.username LIMIT $${params.length}`, params)).rows;
  const names = users.map((u) => u.username as string);
  const [loads, away] = await Promise.all([openLoads(q, names), officerAway(q, names)]);
  const out: ReviewerX[] = [];
  for (const u of users) {
    const perms = permissionsOf({ isSuperuser: u.isSuperuser, roles: u.roles }, b);
    if (!perms.has('kyc:review')) continue;
    const load = loads.get(u.username) ?? { open: 0, overdue: 0 }, aw = away.get(u.username);
    const left = cfg.maxOpenPerOfficer > 0 ? Math.max(0, cfg.maxOpenPerOfficer - load.open) : null;
    const reason = u.isSuperuser ? 'Super user: assigned by hand only' : aw ? `Away${aw.until ? ` until ${aw.until.slice(0, 10)}` : ''}` : left === 0 ? `At the limit of ${cfg.maxOpenPerOfficer} open cases` : null;
    out.push({
      username: u.username, displayName: u.displayName, roles: u.isSuperuser ? ['Super user'] : (u.roles as string[]).filter((r) => rolePermissions(r, b).length).map((r) => roleDef(r, b)?.label ?? r),
      isSuperuser: u.isSuperuser, open: load.open, overdue: load.overdue, away: !!aw, awayUntil: aw?.until ?? null, capacityLeft: left, eligible: !reason, notEligibleReason: reason,
      senior: perms.has('kyc:senior'), assigner: perms.has('kyc:assign'),
    });
  }
  return out;
}
/** Eligible reviewers for the type-ahead and the assignment dialog: the people who hold `kyc:review` and are active, searchable with wildcards. */
export async function listReviewers(q: Queryable, o: { q?: string; limit?: number } = {}): Promise<Reviewer[]> {
  return (await loadReviewers(q, { search: o.q, limit: o.limit })).map(({ senior: _s, assigner: _a, ...r }) => r);
}
/** Does this person hold `kyc:review` right now (roles, overrides and created roles applied)? Active accounts only. */
export async function userCanReview(q: Queryable, username: string, book?: RoleBook): Promise<boolean> {
  const u = (await q.query(`SELECT roles, is_superuser FROM users WHERE lower(username)=lower($1) AND status='ACTIVE'`, [username])).rows[0];
  return !!u && permissionsOf({ isSuperuser: u.isSuperuser, roles: u.roles }, book ?? (await getRoleOverrides(q))).has('kyc:review');
}

async function openLoads(q: Queryable, names: string[]): Promise<Map<string, { open: number; overdue: number }>> {
  if (!names.length) return new Map();
  const sla = (await getStoreSettings(q)).kycSlaHours;
  const rows = (await q.query(
    `SELECT k.assigned_to AS u, count(*)::int AS open, count(*) FILTER (WHERE COALESCE(k.submitted_at, k.created_at) < now() - make_interval(hours => $2::int))::int AS overdue
       FROM ${CASES_FROM} WHERE k.status='PENDING' AND k.assigned_to = ANY($1::text[]) AND ${QUEUE_SQL} GROUP BY k.assigned_to`, [names, sla])).rows;
  return new Map(rows.map((r) => [r.u as string, { open: r.open as number, overdue: r.overdue as number }]));
}
async function officerAway(q: Queryable, names: string[]): Promise<Map<string, { until: string | null }>> {
  if (!names.length) return new Map();
  const rows = (await q.query(`SELECT username, away_until FROM kyc_officer_status WHERE username = ANY($1::text[]) AND away AND (away_until IS NULL OR away_until > now())`, [names])).rows;
  return new Map(rows.map((r) => [r.username as string, { until: (r.awayUntil as string | null) ?? null }]));
}

// ───────────────────────── choosing an officer ─────────────────────────
export interface PlanCase { id: string; exclude: ReadonlySet<string>; prefer?: string | null }
export interface PlanOfficer { username: string; open: number; capacityLeft: number | null }
export interface Planned { picks: Array<{ id: string; to: string }>; unassigned: string[] }
/**
 * Spreads cases over officers, one case at a time in the order given. EQUAL: the officer with the fewest open cases, ties broken at random (so no officer is
 * favoured and the loads stay within one of each other). ROUND_ROBIN: the next officer after `last` in username order. An officer the case excludes (they submitted
 * it) or who has no room left is skipped; a case nobody can take stays unassigned. `prefer` (the officer who had it before) wins when they are allowed. Pure.
 */
export function planAssignments(cases: PlanCase[], officers: PlanOfficer[], o: { strategy: 'EQUAL' | 'ROUND_ROBIN'; last?: string | null }, rnd: () => number = Math.random): Planned {
  const load = new Map(officers.map((x) => [x.username, x.open]));
  const room = new Map(officers.map((x) => [x.username, x.capacityLeft ?? Infinity]));
  const ring = officers.map((x) => x.username).sort();
  let last = o.last ?? null;
  const picks: Planned['picks'] = [], unassigned: string[] = [];
  for (const c of cases) {
    const ok = ring.filter((u) => !c.exclude.has(u) && room.get(u)! > 0);
    if (!ok.length) { unassigned.push(c.id); continue; }
    let to: string;
    if (c.prefer && ok.includes(c.prefer)) to = c.prefer;
    else if (o.strategy === 'ROUND_ROBIN') {
      const after = last === null ? 0 : ring.findIndex((u) => u > last!);
      const start = after < 0 ? 0 : after;
      to = ring.slice(start).concat(ring.slice(0, start)).find((u) => ok.includes(u))!;
    } else {
      const min = Math.min(...ok.map((u) => load.get(u)!));
      const ties = ok.filter((u) => load.get(u) === min);
      to = ties[Math.min(ties.length - 1, Math.floor(rnd() * ties.length))]!;
    }
    last = to; load.set(to, load.get(to)! + 1); room.set(to, room.get(to)! - 1);
    picks.push({ id: c.id, to });
  }
  return { picks, unassigned };
}
const unbiased = () => randomInt(0, 1_000_000) / 1_000_000;

/** Who may not review a case: whoever submitted or attested it, the first reviewer of a second review, and whoever just released it. */
const excludedFor = (c: Row): Set<string> => new Set([c.submittedBy, c.attestation?.by, c.secondReview?.status === 'AWAITING' ? c.secondReview.by : null, c.avoidAssignee].filter((x): x is string => !!x));

async function lastAutoAssignee(q: Queryable): Promise<string | null> {
  return (await q.query(`SELECT target FROM kyc_case_events WHERE action IN ('ASSIGNED','REASSIGNED') AND actor='system' AND target IS NOT NULL ORDER BY id DESC LIMIT 1`)).rows[0]?.target ?? null;
}

/** Plans automatic distribution for case rows. Takes the distribution lock, so the loads it reads are up to date. */
async function planAuto(q: Queryable, rows: Row[], rs: KycReviewSettings, o: { forced?: boolean; pool?: ReviewerX[] } = {}): Promise<Planned> {
  await lockDistribution(q);
  const pool = (o.pool ?? (await loadReviewers(q, {}, rs))).filter((r) => r.eligible);
  const sticky = rs.stickyOnResubmit || !!o.forced;
  return planAssignments(rows.map((c) => ({ id: c.id, exclude: excludedFor(c), prefer: sticky ? c.previousAssignee : null })), pool, { strategy: rs.strategy === 'ROUND_ROBIN' ? 'ROUND_ROBIN' : 'EQUAL', last: rs.strategy === 'ROUND_ROBIN' ? await lastAutoAssignee(q) : null }, unbiased);
}

interface Move { id: string; to: string; from: string | null }
/** Gives cases to officers in one set-based update, with an event and an audit row each. Only cases that are still waiting are touched. Returns the moves that happened. */
async function applyAssignments(q: Queryable, moves: Move[], o: { by: string; source: 'AUTO' | 'MANUAL' | 'CLAIMED' | 'ESCALATED'; reason?: string | null; action?: EventAction }): Promise<Move[]> {
  if (!moves.length) return [];
  const done = (await q.query(
    `UPDATE kyc_cases k SET assigned_to=v.u, assigned_at=now(), assigned_by=$3, assignment_source=$4, previous_assignee=NULL, avoid_assignee=NULL, first_opened_at=NULL, updated_at=now()
       FROM unnest($1::uuid[], $2::text[]) AS v(id, u) WHERE k.id = v.id AND k.status='PENDING' RETURNING k.id`, [moves.map((m) => m.id), moves.map((m) => m.to), o.by, o.source])).rows;
  const ok = new Set(done.map((r) => r.id as string));
  const applied = moves.filter((m) => ok.has(m.id));
  if (!applied.length) return [];
  const actions = applied.map((m) => o.action ?? (m.from && m.from !== m.to ? 'REASSIGNED' : 'ASSIGNED'));
  const arrays = [applied.map((m) => m.id), applied.map((m) => m.to), actions, applied.map((m) => m.from)];
  await q.query(
    `INSERT INTO kyc_case_events (case_id, actor, action, target, detail)
       SELECT v.id, $1, v.a, v.u, jsonb_build_object('from', v.f, 'to', v.u, 'source', $2::text, 'reason', $3::text) FROM unnest($4::uuid[], $5::text[], $6::text[], $7::text[]) AS v(id, u, a, f)`, [o.by, o.source, o.reason ?? null, ...arrays]);
  await q.query(
    `INSERT INTO audit_log (actor, entity, entity_id, action, detail)
       SELECT $1, 'kyc_case', v.id::text, v.a, jsonb_build_object('from', v.f, 'to', v.u, 'source', $2::text, 'reason', $3::text) FROM unnest($4::uuid[], $5::text[], $6::text[], $7::text[]) AS v(id, u, a, f)`, [o.by, o.source, o.reason ?? null, ...arrays]);
  return applied;
}

/** Puts cases back in the pool. `avoid` keeps the former holder from getting them straight back in the next distribution. */
async function applyUnassign(q: Queryable, rows: Array<{ id: string; from: string | null }>, o: { by: string; reason?: string | null; avoid?: boolean; action?: EventAction }): Promise<number> {
  if (!rows.length) return 0;
  const done = (await q.query(
    `UPDATE kyc_cases k SET assigned_to=NULL, assigned_at=NULL, assigned_by=NULL, assignment_source=NULL, first_opened_at=NULL, avoid_assignee = CASE WHEN $2 THEN v.f ELSE NULL END, updated_at=now()
       FROM unnest($1::uuid[], $3::text[]) AS v(id, f) WHERE k.id = v.id AND k.status='PENDING' RETURNING k.id`, [rows.map((r) => r.id), !!o.avoid, rows.map((r) => r.from)])).rows;
  const ok = new Set(done.map((r) => r.id as string));
  const applied = rows.filter((r) => ok.has(r.id));
  if (!applied.length) return 0;
  const action = o.action ?? 'UNASSIGNED';
  const arrays = [applied.map((r) => r.id), applied.map((r) => r.from)];
  await q.query(`INSERT INTO kyc_case_events (case_id, actor, action, target, detail) SELECT v.id, $1, $2, NULL, jsonb_build_object('from', v.f, 'reason', $3::text) FROM unnest($4::uuid[], $5::text[]) AS v(id, f)`, [o.by, action, o.reason ?? null, ...arrays]);
  await q.query(`INSERT INTO audit_log (actor, entity, entity_id, action, detail) SELECT $1, 'kyc_case', v.id::text, $2, jsonb_build_object('from', v.f, 'reason', $3::text) FROM unnest($4::uuid[], $5::text[]) AS v(id, f)`, [o.by, action, o.reason ?? null, ...arrays]);
  return applied.length;
}

// ───────────────────────── entering the queue ─────────────────────────
/**
 * A case has just become a review task (submitted, resubmitted, referred by the ID check service, attested with a flag, reopened). Assesses it, writes the
 * SUBMITTED event and, unless automatic assignment is off, gives it to an officer. Runs inside the caller's transaction: the case row is locked and the
 * distribution lock is held, so two cases queued at once never see the same loads.
 */
export async function enqueueForReview(q: Queryable, caseId: string, o: { actor?: string; forceSticky?: boolean } = {}): Promise<{ assignedTo: string | null }> {
  const c = (await q.query('SELECT * FROM kyc_cases WHERE id=$1 FOR UPDATE', [caseId])).rows[0];
  if (!c) throw notFound('KYC case', caseId);
  await assessRows(q, [c]);
  await logEvent(q, caseId, o.actor ?? c.submittedBy ?? 'system', 'SUBMITTED', { source: c.source, flags: c.flags, resubmitted: !!c.previousAssignee || c.reopenedCount > 0 });
  if (c.assignedTo) return { assignedTo: c.assignedTo };
  const rs = await getKycReviewSettings(q);
  if (!rs.autoAssign || rs.strategy === 'OFF') return { assignedTo: null };
  const plan = await planAuto(q, [c], rs, { forced: o.forceSticky });
  const moved = await applyAssignments(q, plan.picks.map((p) => ({ ...p, from: null })), { by: 'system', source: 'AUTO' });
  return { assignedTo: moved[0]?.to ?? null };
}

// ───────────────────────── manual assignment ─────────────────────────
export interface AssignInput { caseIds?: string[]; filter?: KycListFilter; mode: 'ASSIGN' | 'DISTRIBUTE' | 'UNASSIGN'; officer?: string; officers?: string[]; reason?: string; force?: boolean }
export interface AssignResult { requested: number; assigned: number; skipped: Array<{ caseId: string; caseNumber: string | null; reason: string }>; perOfficer: Record<string, number> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Batch assign, reassign, unassign or spread waiting cases. The caller must hold `kyc:assign`. Never fails half way: a case that cannot be moved is skipped with its
 * reason and the rest go through. Targets must be active holders of `kyc:review`; an away target needs `force`. Up to 2,000 cases per call.
 */
export async function assignCases(q: Queryable, actor: string, i: AssignInput): Promise<AssignResult> {
  return withTx(q, async (tx) => {
    const ids = i.caseIds ? [...new Set(i.caseIds)] : await listCaseIds(tx, { ...i.filter, status: 'PENDING', me: actor }, MAX_BATCH);
    if (!ids.length) throw invalid('Choose the cases to move.');
    if (ids.length > MAX_BATCH) throw invalid(`Move at most ${MAX_BATCH} cases at a time.`);
    if (ids.some((x) => !UUID.test(x))) throw invalid('A case id is not valid.');
    if (!['ASSIGN', 'DISTRIBUTE', 'UNASSIGN'].includes(i.mode)) throw invalid('The mode is ASSIGN, DISTRIBUTE or UNASSIGN.');
    const wanted = i.mode === 'ASSIGN' ? (i.officer ? [i.officer] : []) : i.mode === 'DISTRIBUTE' ? [...new Set(i.officers ?? [])] : [];
    if (i.mode !== 'UNASSIGN' && !wanted.length) throw invalid(i.mode === 'ASSIGN' ? 'Choose the officer.' : 'Choose the officers to spread the cases over.');
    const rs = await getKycReviewSettings(tx);
    const targets = wanted.length ? await loadReviewers(tx, { usernames: wanted }, rs) : [];
    for (const w of wanted) if (!targets.some((t) => t.username.toLowerCase() === w.toLowerCase())) throw invalid(`${w} is not an active user who may review KYC cases (it needs the "Review ID checks" permission).`);
    const away = targets.filter((t) => t.away);
    if (away.length && !i.force) throw rejected(`${away.map((t) => `${t.displayName} is away${t.awayUntil ? ` until ${t.awayUntil.slice(0, 10)}` : ''}`).join('; ')}. Confirm to assign anyway.`);

    await lockDistribution(tx);
    const rows = (await tx.query(
      `SELECT k.id, k.case_number, k.status, k.assigned_to, k.submitted_by, k.attestation, k.second_review, k.avoid_assignee, ${QUEUE_SQL} AS queued
         FROM ${CASES_FROM} WHERE k.id = ANY($1::uuid[]) ORDER BY k.id FOR UPDATE OF k`, [ids])).rows;
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    const skipped: AssignResult['skipped'] = [];
    const skip = (id: string, reason: string) => skipped.push({ caseId: id, caseNumber: byId.get(id)?.caseNumber ?? null, reason });
    const open: Row[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) skip(id, 'No such case.');
      else if (r.status !== 'PENDING') skip(id, `Already ${String(r.status).toLowerCase()}.`);
      else if (!r.queued) skip(id, 'Not waiting for review yet.');
      else open.push(r);
    }
    const holds = open.filter((r) => r.assignedTo);
    if (!i.reason?.trim() && holds.length && (i.mode === 'UNASSIGN' || holds.some((r) => !targets.some((t) => t.username === r.assignedTo)))) throw invalid('Give a reason for moving cases that an officer already holds.');
    const reason = i.reason?.trim() || null;
    const perOfficer: Record<string, number> = {};
    let assigned = 0;

    if (i.mode === 'UNASSIGN') {
      const todo = open.filter((r) => { if (!r.assignedTo) { skip(r.id, 'Not assigned to anyone.'); return false; } return true; });
      assigned = await applyUnassign(tx, todo.map((r) => ({ id: r.id, from: r.assignedTo })), { by: actor, reason });
    } else {
      const names = targets.map((t) => t.username);
      // Spreading counts each officer's load without the cases of this batch they already hold: those are being placed again.
      const base = targets.map((t) => ({ username: t.username, open: t.open - open.filter((r) => r.assignedTo === t.username).length, capacityLeft: null }));
      const plan = planAssignments(open.map((r) => ({ id: r.id, exclude: new Set([r.submittedBy, r.attestation?.by, r.secondReview?.status === 'AWAITING' ? r.secondReview.by : null].filter((x): x is string => !!x)) })), base, { strategy: 'EQUAL' }, unbiased);
      for (const id of plan.unassigned) skip(id, names.length === 1 ? `${names[0]} submitted this case or reviewed it first, so someone else must take it.` : 'None of the chosen officers may review this case (they submitted it).');
      const moves: Move[] = [];
      for (const p of plan.picks) {
        const r = byId.get(p.id)!;
        if (r.assignedTo === p.to) skip(p.id, `Already assigned to ${p.to}.`); else moves.push({ id: p.id, to: p.to, from: r.assignedTo ?? null });
      }
      const done = await applyAssignments(tx, moves, { by: actor, source: 'MANUAL', reason });
      for (const m of done) perOfficer[m.to] = (perOfficer[m.to] ?? 0) + 1;
      assigned = done.length;
      for (const [u, n] of Object.entries(perOfficer)) if (u.toLowerCase() !== actor.toLowerCase()) await safeNotify(tx, u, 'caseAssigned', { title: 'KYC reviews assigned to you', body: `${n} KYC ${plural(n, 'review was', 'reviews were')} assigned to you.`, link: '/kyc' });
    }
    return { requested: ids.length, assigned, skipped, perOfficer };
  });
}

async function lockedCase(q: Queryable, caseId: string): Promise<Row> {
  const c = (await q.query(`SELECT k.*, ${QUEUE_SQL} AS queued FROM ${CASES_FROM} WHERE k.id=$1 FOR UPDATE OF k`, [caseId])).rows[0];
  if (!c) throw notFound('KYC case', caseId);
  return c;
}
const waitingGuard = (c: Row) => {
  if (c.status !== 'PENDING') throw conflict(`This case was already ${String(c.status).toLowerCase()}${c.decidedBy ? ` by ${c.decidedBy}` : ''}.`);
  if (!c.queued) throw rejected('This case is not waiting for review.');
};
const mayNotReview = (c: Row, user: string): string | null =>
  c.submittedBy === user || c.attestation?.by === user ? 'You submitted this case, so a different officer must review it.' : c.secondReview?.status === 'AWAITING' && c.secondReview.by === user ? 'You made the first recommendation, so a different officer must confirm it.' : null;

/** How many open cases the officer has, against the limit. */
async function roomFor(q: Queryable, username: string, rs: KycReviewSettings): Promise<void> {
  if (rs.maxOpenPerOfficer <= 0) return;
  const n = (await openLoads(q, [username])).get(username)?.open ?? 0;
  if (n >= rs.maxOpenPerOfficer) throw rejected(`You already have ${n} open cases (the limit is ${rs.maxOpenPerOfficer}). Finish some first.`);
}

async function takeFor(q: Queryable, c: Row, user: string, source: 'CLAIMED' | 'MANUAL', reason?: string | null): Promise<Row> {
  const moved = await applyAssignments(q, [{ id: c.id, to: user, from: c.assignedTo ?? null }], { by: user, source, reason, action: source === 'CLAIMED' ? 'CLAIMED' : undefined });
  if (!moved.length) throw conflict('This case is no longer waiting.');
  return { id: c.id, caseNumber: c.caseNumber, assignedTo: user };
}

/** A reviewer takes an unassigned case. */
export async function claimCase(q: Queryable, user: string, caseId: string): Promise<Row> {
  return withTx(q, async (tx) => {
    const c = await lockedCase(tx, caseId);
    waitingGuard(c);
    if (c.assignedTo) throw conflict(c.assignedTo === user ? 'This case is already yours.' : `This case is already assigned to ${c.assignedTo}.`);
    const no = mayNotReview(c, user); if (no) throw rejected(no);
    await roomFor(tx, user, await getKycReviewSettings(tx));
    return takeFor(tx, c, user, 'CLAIMED');
  });
}

/** The best case nobody holds, for this person: highest priority, then oldest, never one they submitted. Null when the pool is empty. */
export async function nextCase(q: Queryable, user: string): Promise<{ caseId: string | null }> {
  return withTx(q, async (tx) => {
    await roomFor(tx, user, await getKycReviewSettings(tx));
    const c = (await tx.query(
      `SELECT k.*, true AS queued FROM ${CASES_FROM}
        WHERE k.status='PENDING' AND k.assigned_to IS NULL AND ${QUEUE_SQL} AND k.submitted_by IS DISTINCT FROM $1 AND k.attestation->>'by' IS DISTINCT FROM $1
          AND k.avoid_assignee IS DISTINCT FROM $1 AND NOT (k.second_review->>'status' = 'AWAITING' AND k.second_review->>'by' = $1)
        ORDER BY k.priority DESC, COALESCE(k.submitted_at, k.created_at), k.id LIMIT 1 FOR UPDATE OF k SKIP LOCKED`, [user])).rows[0];
    if (!c) return { caseId: null };
    await takeFor(tx, c, user, 'CLAIMED');
    return { caseId: c.id as string };
  });
}

/** The assignee returns a case to the pool; someone with `kyc:assign` may release anyone's. */
export async function releaseCase(q: Queryable, actor: ReviewActor, caseId: string, reason: string): Promise<Row> {
  if (!reason?.trim()) throw invalid('Say why the case goes back to the pool.');
  return withTx(q, async (tx) => {
    const c = await lockedCase(tx, caseId);
    waitingGuard(c);
    if (!c.assignedTo) throw conflict('This case is not assigned to anyone.');
    if (c.assignedTo !== actor.username && !actor.canAssign) throw rejected(`This case is assigned to ${c.assignedTo}. Only they, or a supervisor who assigns cases, can release it.`);
    await applyUnassign(tx, [{ id: c.id, from: c.assignedTo }], { by: actor.username, reason: reason.trim(), avoid: true, action: 'RELEASED' });
    return { id: c.id, caseNumber: c.caseNumber, assignedTo: null };
  });
}

/** An assigner takes a case that someone else holds. */
export async function takeOver(q: Queryable, actor: ReviewActor, caseId: string, reason: string): Promise<Row> {
  if (!actor.canAssign) throw rejected('Taking over a case needs the permission to assign cases.');
  if (!reason?.trim()) throw invalid('Say why you take the case over.');
  return withTx(q, async (tx) => {
    const c = await lockedCase(tx, caseId);
    waitingGuard(c);
    if (c.assignedTo === actor.username) throw conflict('This case is already yours.');
    const no = mayNotReview(c, actor.username); if (no) throw rejected(no);
    return takeFor(tx, c, actor.username, 'MANUAL', reason.trim());
  });
}

// ───────────────────────── notes, escalation ─────────────────────────
export async function addKycNote(q: Queryable, actor: string, caseId: string, text: string): Promise<{ ok: true }> {
  const t = (text ?? '').trim();
  if (!t) throw invalid('Write the note.');
  if (t.length > 2000) throw invalid('A note is at most 2,000 characters.');
  if (!(await q.query('SELECT 1 FROM kyc_cases WHERE id=$1', [caseId])).rows.length) throw notFound('KYC case', caseId);
  await logEvent(q, caseId, actor, 'NOTE', { text: t });
  await audit(q, actor, 'kyc_case', caseId, 'NOTE', { length: t.length });
  return { ok: true };
}

/** Senior officers: those who hold `kyc:review` and `kyc:senior`; failing that `kyc:assign`. Away officers are left out. */
function seniorPool(all: ReviewerX[]): ReviewerX[] {
  const ok = all.filter((r) => !r.isSuperuser && !r.away);
  const seniors = ok.filter((r) => r.senior);
  return seniors.length ? seniors : ok.filter((r) => r.assigner);
}

/**
 * Sends a case to a senior officer (or the named reviewer) with a note. It stays waiting. With nobody senior to send it to, it is flagged and stays with its holder.
 * Whoever holds the case, a supervisor, a senior, or any reviewer for a case nobody holds, may escalate.
 */
export async function escalateCase(q: Queryable, actor: ReviewActor, caseId: string, b: { note: string; to?: string }): Promise<Row> {
  const note = (b.note ?? '').trim();
  if (!note) throw invalid('Say why the case needs a senior officer.');
  return withTx(q, async (tx) => {
    const c = await lockedCase(tx, caseId);
    waitingGuard(c);
    if (c.assignedTo && c.assignedTo !== actor.username && !actor.canAssign && !actor.canSenior) throw rejected(`This case is assigned to ${c.assignedTo}. Only they, or a supervisor, can escalate it.`);
    await lockDistribution(tx);
    const rs = await getKycReviewSettings(tx);
    const all = await loadReviewers(tx, {}, rs);
    const exclude = new Set([...excludedFor(c), actor.username]);
    let to: string | null = null;
    if (b.to) {
      const t = all.find((r) => r.username.toLowerCase() === b.to!.toLowerCase());
      if (!t) throw invalid(`${b.to} is not an active user who may review KYC cases.`);
      if (exclude.has(t.username)) throw rejected(`${t.displayName} cannot take this case (they submitted it, or it is theirs already).`);
      to = t.username;
    } else to = planAssignments([{ id: c.id, exclude }], seniorPool(all), { strategy: 'EQUAL' }, unbiased).picks[0]?.to ?? null;
    return escalateRow(tx, c, actor.username, note, to);
  });
}

/** Marks a case escalated and, when there is somebody to send it to, moves it there. */
async function escalateRow(q: Queryable, c: Row, by: string, note: string, to: string | null): Promise<Row> {
  await q.query(`UPDATE kyc_cases SET escalated_at=now(), escalated_by=$2, escalation_note=$3, priority = priority + CASE WHEN escalated_at IS NULL THEN $4::int ELSE 0 END, updated_at=now() WHERE id=$1`, [c.id, by, note, PRIORITY.escalated]);
  if (to && to !== c.assignedTo) await applyAssignments(q, [{ id: c.id, to, from: c.assignedTo ?? null }], { by, source: 'ESCALATED', reason: note, action: 'ESCALATED' });
  else await logEvent(q, c.id, by, 'ESCALATED', { reason: note, from: c.assignedTo ?? null, to: null });
  await audit(q, by, 'kyc_case', c.id, 'ESCALATED', { note, from: c.assignedTo ?? null, to });
  if (to) await safeNotify(q, to, 'caseAssigned', { title: 'KYC case escalated to you', body: `${c.caseNumber}: ${note}`.slice(0, 300), link: `/kyc/${c.id}` });
  return { id: c.id, caseNumber: c.caseNumber, escalatedTo: to };
}

// ───────────────────────── availability ─────────────────────────
export interface OfficerStatus { username: string; away: boolean; awayUntil: string | null; note: string | null }
export async function getOfficerStatus(q: Queryable, username: string): Promise<OfficerStatus> {
  const r = (await q.query(`SELECT username, (away AND (away_until IS NULL OR away_until > now())) AS away, away_until, note FROM kyc_officer_status WHERE username=$1`, [username])).rows[0];
  return { username, away: !!r?.away, awayUntil: r?.away ? r.awayUntil ?? null : null, note: r?.note ?? null };
}

/** An officer sets their own status; someone with `kyc:assign` sets anyone's. Going away hands the open cases back to the distribution (by setting). */
export async function setOfficerStatus(q: Queryable, actor: ReviewActor, username: string, b: { away: boolean; awayUntil?: string | null; note?: string | null }): Promise<OfficerStatus> {
  if (username.toLowerCase() !== actor.username.toLowerCase() && !actor.canAssign) throw rejected('You can set your own availability; changing someone else’s needs the permission to assign cases.');
  const u = (await q.query(`SELECT username FROM users WHERE lower(username)=lower($1) AND status='ACTIVE'`, [username])).rows[0];
  if (!u) throw notFound('user', username);
  let until: string | null = null;
  if (b.away && b.awayUntil) {
    const t = Date.parse(b.awayUntil);
    if (Number.isNaN(t)) throw invalid('Enter when they are back.');
    if (t <= Date.now()) throw invalid('The return time must be in the future.');
    until = new Date(t).toISOString();
  }
  const note = b.note?.trim().slice(0, 200) || null;
  return withTx(q, async (tx) => {
    await tx.query(
      `INSERT INTO kyc_officer_status (username, away, away_until, note, updated_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (username) DO UPDATE SET away=EXCLUDED.away, away_until=EXCLUDED.away_until, note=EXCLUDED.note, updated_at=now(), updated_by=EXCLUDED.updated_by`, [u.username, !!b.away, until, note, actor.username]);
    await audit(tx, actor.username, 'kyc_officer', u.username, b.away ? 'AWAY' : 'BACK', { until, note });
    if (b.away) await redistributeFrom(tx, await getKycReviewSettings(tx), [u.username]);
    return getOfficerStatus(tx, u.username);
  });
}

// ───────────────────────── the sweep ─────────────────────────
export interface KycSweepResult { assigned: number; redistributed: number; escalated: number; breached: number; refreshed: number }
const SWEEP_BATCH = 500;

/** Moves what an officer holds back into the distribution: because they are away (by setting), disabled, or no longer hold the permission. */
async function redistributeFrom(q: Queryable, rs: KycReviewSettings, only?: string[]): Promise<{ moved: number; pooled: number }> {
  const reviewers = await loadReviewers(q, {}, rs);
  const active = new Set(reviewers.map((r) => r.username));
  const away = new Set(reviewers.filter((r) => r.away).map((r) => r.username));
  const holders = (await q.query(`SELECT DISTINCT k.assigned_to AS u FROM ${CASES_FROM} WHERE k.status='PENDING' AND k.assigned_to IS NOT NULL AND ${QUEUE_SQL}`)).rows.map((r) => r.u as string);
  const gone = holders.filter((u) => (!active.has(u) || (rs.redistributeAway && away.has(u))) && (!only || only.includes(u)));
  if (!gone.length) return { moved: 0, pooled: 0 };
  const rows = (await q.query(
    `SELECT k.* FROM ${CASES_FROM} WHERE k.status='PENDING' AND k.assigned_to = ANY($1::text[]) AND ${QUEUE_SQL} ORDER BY k.priority DESC, COALESCE(k.submitted_at, k.created_at), k.id LIMIT ${MAX_BATCH} FOR UPDATE OF k`, [gone])).rows;
  const why = (u: string) => (!active.has(u) ? 'The officer can no longer review KYC cases.' : 'The officer is away.');
  const plan = rs.autoAssign && rs.strategy !== 'OFF' ? await planAuto(q, rows, rs, { pool: reviewers }) : { picks: [] as Planned['picks'], unassigned: rows.map((r) => r.id as string) };
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const moved = await applyAssignments(q, plan.picks.map((p) => ({ ...p, from: byId.get(p.id)!.assignedTo })), { by: 'system', source: 'AUTO', reason: 'The officer is away or can no longer review.' });
  const movedIds = new Set(moved.map((m) => m.id));
  const pool = rows.filter((r) => !movedIds.has(r.id));
  let pooled = 0;
  for (const u of gone) pooled += await applyUnassign(q, pool.filter((r) => r.assignedTo === u).map((r) => ({ id: r.id, from: u })), { by: 'system', reason: why(u) });
  const lost = new Map<string, number>();
  for (const r of rows) lost.set(r.assignedTo, (lost.get(r.assignedTo) ?? 0) + 1);
  for (const [u, n] of lost) await safeNotify(q, u, 'caseAssigned', { title: 'KYC reviews moved away from you', body: `${n} open KYC ${plural(n, 'review was', 'reviews were')} handed back because you are ${active.has(u) ? 'away' : 'no longer a reviewer'}.`, link: '/kyc' });
  return { moved: moved.length, pooled };
}

/**
 * The periodic job (idempotent, safe every minute, safe on several servers at once):
 *  (d) risk and priority are brought up to date (overdue cases jump the queue);
 *  (b) cases held by an away, disabled or no longer qualified officer go back into the distribution;
 *  (a) cases nobody holds are given out, most urgent first, up to 500 per run;
 *  (c) cases past the review target get an SLA_BREACHED event, and assigned ones still open `escalateOverdueHours` later are escalated to a senior officer.
 */
export async function sweepKycReview(db: Queryable): Promise<KycSweepResult> {
  const out: KycSweepResult = { assigned: 0, redistributed: 0, escalated: 0, breached: 0, refreshed: 0 };
  const rs = await getKycReviewSettings(db);
  const sla = (await getStoreSettings(db)).kycSlaHours;
  // The sweep is one unit of work per step; a second server that finds the lock taken does nothing this minute.
  const lock = async (tx: Queryable) => (await tx.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [LOCK + 1])).rows[0]?.ok === true;

  out.refreshed = await withTx(db, async (tx) => {
    if (!(await lock(tx))) return 0;
    await tx.query(`UPDATE kyc_cases SET priority = priority + $2::int WHERE status='PENDING' AND risk_assessed_at IS NOT NULL AND priority < $2::int AND COALESCE(submitted_at, created_at) < now() - make_interval(hours => $1::int)`, [sla, PRIORITY.overdue]);
    const stale = (await tx.query(
      `SELECT k.* FROM ${CASES_FROM} WHERE k.status='PENDING' AND ${QUEUE_SQL} AND (k.risk_assessed_at IS NULL OR k.risk_assessed_at < now() - interval '1 hour')
        ORDER BY k.risk_assessed_at NULLS FIRST LIMIT ${SWEEP_BATCH} FOR UPDATE OF k SKIP LOCKED`)).rows;
    await assessRows(tx, stale);
    return stale.length;
  });

  out.redistributed = await withTx(db, async (tx) => ((await lock(tx)) ? (await redistributeFrom(tx, rs)).moved : 0));

  if (rs.autoAssign && rs.strategy !== 'OFF') {
    out.assigned = await withTx(db, async (tx) => {
      if (!(await lock(tx))) return 0;
      const rows = (await tx.query(
        `SELECT k.* FROM ${CASES_FROM} WHERE k.status='PENDING' AND k.assigned_to IS NULL AND ${QUEUE_SQL} ORDER BY k.priority DESC, COALESCE(k.submitted_at, k.created_at), k.id LIMIT ${SWEEP_BATCH} FOR UPDATE OF k SKIP LOCKED`)).rows;
      if (!rows.length) return 0;
      const plan = await planAuto(tx, rows, rs);
      const moved = await applyAssignments(tx, plan.picks.map((p) => ({ ...p, from: null })), { by: 'system', source: 'AUTO' });
      const per = new Map<string, number>();
      for (const m of moved) per.set(m.to, (per.get(m.to) ?? 0) + 1);
      for (const [u, n] of per) await safeNotify(tx, u, 'caseAssigned', { title: 'KYC reviews assigned to you', body: `${n} KYC ${plural(n, 'review was', 'reviews were')} assigned to you.`, link: '/kyc' });
      return moved.length;
    });
  }

  const tail = await withTx(db, async (tx) => {
    if (!(await lock(tx))) return { breached: 0, escalated: 0 };
    const late = (await tx.query(
      `WITH due AS (SELECT k.id FROM ${CASES_FROM} WHERE k.status='PENDING' AND k.sla_breached_at IS NULL AND ${QUEUE_SQL} AND COALESCE(k.submitted_at, k.created_at) < now() - make_interval(hours => $1::int) ORDER BY k.id LIMIT 1000 FOR UPDATE OF k SKIP LOCKED)
       UPDATE kyc_cases k SET sla_breached_at = now() FROM due WHERE k.id = due.id RETURNING k.id, k.assigned_to, k.case_number`, [sla])).rows;
    if (late.length) {
      await tx.query(`INSERT INTO kyc_case_events (case_id, actor, action, target, detail) SELECT v.id, 'system', 'SLA_BREACHED', v.u, jsonb_build_object('slaHours', $3::int) FROM unnest($1::uuid[], $2::text[]) AS v(id, u)`, [late.map((r) => r.id), late.map((r) => r.assignedTo ?? null), sla]);
      const mine = new Map<string, number>();
      for (const r of late) if (r.assignedTo) mine.set(r.assignedTo, (mine.get(r.assignedTo) ?? 0) + 1);
      for (const [u, n] of mine) await safeNotify(tx, u, 'caseUpdates', { title: 'KYC reviews past their target', body: `${n} of your KYC ${plural(n, 'review is', 'reviews are')} past the ${sla} hour target.`, link: '/kyc?overdue=1' });
    }
    let escalated = 0;
    if (rs.escalateOverdueHours > 0) {
      const rows = (await tx.query(
        `SELECT k.* FROM ${CASES_FROM} WHERE k.status='PENDING' AND k.assigned_to IS NOT NULL AND k.escalated_at IS NULL AND ${QUEUE_SQL}
            AND COALESCE(k.submitted_at, k.created_at) < now() - make_interval(hours => $1::int) ORDER BY k.priority DESC, k.id LIMIT ${SWEEP_BATCH} FOR UPDATE OF k SKIP LOCKED`, [sla + rs.escalateOverdueHours])).rows;
      if (rows.length) {
        await lockDistribution(tx);
        const seniors = seniorPool(await loadReviewers(tx, {}, rs));
        const plan = planAssignments(rows.map((c) => ({ id: c.id, exclude: new Set([...excludedFor(c), c.assignedTo]) })), seniors, { strategy: 'EQUAL' }, unbiased);
        const to = new Map(plan.picks.map((p) => [p.id, p.to]));
        for (const c of rows) await escalateRow(tx, c, 'system', `Still open ${rs.escalateOverdueHours} hours after the ${sla} hour target.`, to.get(c.id) ?? null);
        escalated = rows.length;
      }
    }
    return { breached: late.length, escalated };
  });
  out.breached = tail.breached; out.escalated = tail.escalated;
  return out;
}

// ───────────────────────── used by the decision flow ─────────────────────────
/** The decider takes a case nobody holds. */
export async function autoClaim(q: Queryable, c: Row, user: string): Promise<void> {
  if (!(await applyAssignments(q, [{ id: c.id, to: user, from: null }], { by: user, source: 'CLAIMED', action: 'CLAIMED' })).length) throw conflict('This case is no longer waiting.');
}

/**
 * Four eyes on a high risk case: the first officer's decision becomes a recommendation, kept on the case, and the case goes to a different eligible officer (failing that
 * a senior one; failing that back to the pool, where anyone but the first officer may take it).
 */
export async function routeToSecondReview(q: Queryable, c: Row, first: string, d: { decision: string; reason?: string; reasonCode?: string; reportFraud?: boolean; checklist?: unknown }): Promise<string | null> {
  const rs = await getKycReviewSettings(q);
  await lockDistribution(q);
  const all = await loadReviewers(q, {}, rs);
  const exclude = new Set([...excludedFor(c), first]);
  const pick = (pool: ReviewerX[]) => planAssignments([{ id: c.id, exclude }], pool, { strategy: 'EQUAL' }, unbiased).picks[0]?.to ?? null;
  const to = pick(all.filter((r) => r.eligible)) ?? pick(seniorPool(all));
  const sr = { status: 'AWAITING', recommended: d.decision, by: first, at: new Date().toISOString(), note: d.reason ?? null, reasonCode: d.reasonCode ?? null, reportFraud: !!d.reportFraud, checklist: d.checklist ?? null };
  await q.query('UPDATE kyc_cases SET second_review=$2, updated_at=now() WHERE id=$1', [c.id, JSON.stringify(sr)]);
  if (to) await applyAssignments(q, [{ id: c.id, to, from: c.assignedTo ?? null }], { by: 'system', source: 'AUTO', reason: 'Second review of a high risk case' });
  else await applyUnassign(q, [{ id: c.id, from: c.assignedTo ?? null }], { by: 'system', reason: 'Second review: no other officer is available' });
  await logEvent(q, c.id, first, 'RECOMMENDED', { decision: d.decision, reason: d.reason ?? null, to }, to);
  await audit(q, first, 'kyc_case', c.id, 'RECOMMENDED', { decision: d.decision, secondReviewer: to });
  if (to) await safeNotify(q, to, 'caseAssigned', { title: 'Second review requested', body: `${c.caseNumber} is high risk: ${first} recommends ${d.decision.toLowerCase()}. Please confirm or decide differently.`, link: `/kyc/${c.id}` });
  return to;
}

/** After an approval, with the configured probability, another officer is asked to look at the case again. */
export async function maybeSampleQa(q: Queryable, c: Row, decider: string, rs: KycReviewSettings): Promise<string | null> {
  if (rs.qaSamplePercent <= 0 || randomInt(0, 10_000) >= Math.round(rs.qaSamplePercent * 100)) return null;
  const pool = (await loadReviewers(q, {}, rs)).filter((r) => !r.isSuperuser && !r.away);
  const to = planAssignments([{ id: c.id, exclude: new Set([decider, c.submittedBy, c.attestation?.by].filter((x): x is string => !!x)) }], pool, { strategy: 'EQUAL' }, unbiased).picks[0]?.to ?? null;
  if (!to) return null;
  await q.query('UPDATE kyc_cases SET qa_assigned_to=$2, qa_sampled_at=now(), qa_result=NULL, qa_note=NULL, qa_by=NULL, qa_at=NULL WHERE id=$1', [c.id, to]);
  await logEvent(q, c.id, 'system', 'QA_SAMPLED', { decider }, to);
  await safeNotify(q, to, 'caseAssigned', { title: 'Quality check', body: `${c.caseNumber}: please look again at ${decider}'s approval.`, link: `/kyc/${c.id}` });
  return to;
}

/** The officer asked to check a sampled approval says whether they agree. A disagreement needs a note. */
export async function qaReview(q: Queryable, actor: string, caseId: string, b: { result: 'AGREE' | 'DISAGREE'; note?: string }): Promise<Row> {
  if (!['AGREE', 'DISAGREE'].includes(b.result)) throw invalid('The result is AGREE or DISAGREE.');
  const note = b.note?.trim() || null;
  if (b.result === 'DISAGREE' && !note) throw invalid('Say what you disagree with.');
  const c = (await q.query('SELECT id, case_number, qa_assigned_to, qa_result, decided_by FROM kyc_cases WHERE id=$1 FOR UPDATE', [caseId])).rows[0];
  if (!c) throw notFound('KYC case', caseId);
  if (!c.qaAssignedTo || c.qaAssignedTo.toLowerCase() !== actor.toLowerCase()) throw rejected('This case is not waiting for your quality check.');
  if (c.qaResult) throw conflict('The quality check is already done.');
  await q.query('UPDATE kyc_cases SET qa_result=$2, qa_note=$3, qa_by=$4, qa_at=now() WHERE id=$1', [caseId, b.result, note, actor]);
  await logEvent(q, caseId, actor, 'QA_DONE', { result: b.result, note }, c.decidedBy ?? null);
  await audit(q, actor, 'kyc_case', caseId, 'QA_DONE', { result: b.result });
  if (b.result === 'DISAGREE' && c.decidedBy) await safeNotify(q, c.decidedBy, 'caseUpdates', { title: 'Quality check disagrees', body: `${c.caseNumber}: ${note}`.slice(0, 300), link: `/kyc/${caseId}` });
  return { id: caseId, qaResult: b.result };
}

/** Why a decided case cannot be reopened now, or null when it can. */
export async function reopenProblem(q: Queryable, c: Row, rs: KycReviewSettings): Promise<string | null> {
  if (!['APPROVED', 'REJECTED', 'RETURNED'].includes(c.status)) return 'Only a decided case can be reopened.';
  if (Date.now() - Date.parse(c.decidedAt ?? c.updatedAt) > rs.reopenDays * 86_400_000) return `A case can be reopened for ${rs.reopenDays} days after the decision.`;
  if (c.fraudReported || c.reasonCode === 'SUSPECTED_FRAUD') return 'This case was rejected as suspected fraud. Look at the fraud register entry first; the case cannot be reopened.';
  if (c.status === 'APPROVED' && c.customerId && (await q.query('SELECT 1 FROM services WHERE customer_id=$1 AND activated_at >= $2 LIMIT 1', [c.customerId, c.decidedAt])).rows.length) return 'A service was activated after this approval, so it cannot be reopened.';
  return null;
}
