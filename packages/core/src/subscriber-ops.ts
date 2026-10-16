import { agreementsFor, planChangeValues, queueDocumentDelivery, signAgreements, type SignatureInput } from './agreements.js';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { assertNotBlacklisted } from './fraud.js';
import { behaviourOf, type OfferNode } from '@meridian/types';
import { audit } from './audit.js';
import { issueInvoice, type DraftLine } from './billing.js';
import { resolveService, simulatePlanChange } from './billing-simulation.js';
import { monthlyFee } from './catalog.js';
import { GL } from './config.js';
import { addDays, today } from './dates.js';
import type { Db, Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { getLifecycleSettings } from './lifecycle-config.js';
import { closingStatement, resumeService, suspendService, suspendVoluntary, terminateService } from './lifecycle.js';
import { logLifecycle, queueOutbox, setBarLevel } from './lifecycle-state.js';
import { assertIccidTransition, assertImsiTransition, assertMsisdnTransition, auditIdentifier, type IccidState } from './nrm.js';
import { consumeMsisdnTx, reserveMsisdnTx } from './number-reservation.js';
import { enqueueOcs } from './ocs.js';
import { createAccount } from './customers.js';
import { releaseFromGroup } from './groups.js';
import { marketFor } from './settings.js';

/**
 * Subscriber operations for the northbound API: SIM swap, number change, transfer of ownership, status, plan change and value-added services. Each runs in one
 * transaction, leaves an audit trail, tells the network and charging system through the outbox, and records a domain event (`SIM_SWAPPED`, `PLAN_CHANGED`, …)
 * for the event bus and subscribers.
 */

// ───────────────────────── settings ─────────────────────────
export interface NorthSettings { simSwapOtpRequired: boolean; otpTtlMinutes: number; simSwapFeeMinor: number; numberChangeFeeMinor: number; ownershipTransferFeeMinor: number; planChangeFeeMinor: number }
export const DEFAULT_NORTH: NorthSettings = { simSwapOtpRequired: true, otpTtlMinutes: 10, simSwapFeeMinor: 0, numberChangeFeeMinor: 0, ownershipTransferFeeMinor: 0, planChangeFeeMinor: 0 };
export async function getNorthSettings(q: Queryable): Promise<NorthSettings> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='northbound'`)).rows[0]?.value as Partial<NorthSettings> | undefined;
  return { ...DEFAULT_NORTH, ...(v ?? {}) };
}
export async function setNorthSettings(q: Queryable, actor: string, i: Partial<NorthSettings>): Promise<NorthSettings> {
  const next = { ...(await getNorthSettings(q)), ...i };
  if (typeof next.simSwapOtpRequired !== 'boolean') throw invalid('Say whether a one-time password is needed for a SIM swap.');
  if (!Number.isInteger(next.otpTtlMinutes) || next.otpTtlMinutes < 1 || next.otpTtlMinutes > 60) throw invalid('A one-time password lasts 1 to 60 minutes.');
  for (const k of ['simSwapFeeMinor', 'numberChangeFeeMinor', 'ownershipTransferFeeMinor', 'planChangeFeeMinor'] as const) if (!Number.isInteger(next[k]) || next[k] < 0 || next[k] > 100_000_000) throw invalid('A fee is a whole amount of zero or more.');
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('northbound', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(next), actor]);
  await audit(q, actor, 'settings', 'northbound', 'update', next as unknown as Record<string, unknown>);
  return next;
}

// ───────────────────────── helpers ─────────────────────────
async function lock(q: Queryable, ref: string): Promise<Row> {
  const found = await resolveService(q, ref);
  const s = (await q.query('SELECT * FROM services WHERE id=$1 FOR UPDATE', [found.id])).rows[0];
  if (!s) throw notFound('service', ref);
  return s;
}
/** The domain event for the event bus; the dispatcher (webhooks, TMF 688, topics) picks these up from the outbox. */
export async function emitEvent(q: Queryable, type: string, s: Row, payload: Record<string, unknown> = {}) {
  await queueOutbox(q, { kind: 'EVENT', instruction: type, serviceId: s.id as string, accountId: s.accountId as string, payload: { eventType: type, serviceId: s.id, accountId: s.accountId, customerId: s.customerId, identifier: s.identifier, occurredAt: new Date().toISOString(), ...payload } });
}
/** A one-off fee billed at once as its own invoice. */
async function chargeFee(q: Queryable, s: Row, amountMinor: number, description: string): Promise<{ invoiceNumber: string | null; amountMinor: number }> {
  if (amountMinor <= 0) return { invoiceNumber: null, amountMinor: 0 };
  const acct = (await q.query('SELECT * FROM accounts WHERE id=$1', [s.accountId])).rows[0]!;
  const d = today();
  const line: DraftLine = { serviceId: s.id, kind: 'ADJUSTMENT', revenueAccount: GL.SERVICE_REVENUE, description: `${description} ${s.identifier}`, amountMinor, taxInclusive: true };
  const inv = await issueInvoice(q, acct, { kind: 'ADJUSTMENT', periodStart: d, periodEnd: d, issueDate: d, lines: [line] });
  return { invoiceNumber: inv?.number ?? null, amountMinor };
}
const hashOtp = (serviceId: string, code: string) => createHash('sha256').update(`${serviceId}:${code}`).digest('hex');
const maskMsisdn = (m: string) => (m.length > 6 ? `${m.slice(0, 4)}${'•'.repeat(m.length - 6)}${m.slice(-2)}` : m);

export interface TmfServiceView { id: string; '@type': 'Service'; href: string; name: string; state: string; serviceType: string; startDate: string | null; serviceCharacteristic: Array<{ name: string; value: unknown }>; relatedParty: Array<{ id: string; role: string; '@referredType': string }>; supportingService?: Array<{ id: string; name: string }> }
/** A service in TM Forum 638 shape. */
export async function tmfService(q: Queryable, id: string): Promise<TmfServiceView> {
  const s = (await q.query('SELECT * FROM services WHERE id=$1', [id])).rows[0];
  if (!s) throw notFound('service', id);
  const vas = (await q.query(`SELECT id, identifier, offer_id FROM services WHERE parent_service_id=$1 AND status <> 'TERMINATED'`, [id])).rows;
  const state = s.status === 'ACTIVE' ? 'active' : s.status === 'SUSPENDED' ? 'inactive' : s.status === 'PENDING' ? 'feasibilityChecked' : s.status === 'TERMINATED' ? 'terminated' : String(s.status).toLowerCase();
  return {
    id: s.id, '@type': 'Service', href: `/api/v1/services/${s.id}`, name: s.identifier, state, serviceType: s.type, startDate: s.activatedAt ? new Date(s.activatedAt).toISOString() : null,
    serviceCharacteristic: [{ name: 'msisdn', value: s.identifier }, { name: 'iccid', value: s.iccid ?? null }, { name: 'offerId', value: s.offerId }, { name: 'barLevel', value: s.barLevel }, { name: 'restriction', value: s.suspensionKind ?? null }],
    relatedParty: [{ id: s.customerId, role: 'owner', '@referredType': 'Customer' }, { id: s.accountId, role: 'payer', '@referredType': 'BillingAccount' }],
    ...(vas.length ? { supportingService: vas.map((v) => ({ id: v.id, name: v.offerId })) } : {}),
  };
}

// ───────────────────────── one-time passwords ─────────────────────────
/** Sends a one-time password to the number being changed. Returns the challenge; the code only travels by SMS. */
export async function issueOtp(db: Db, ref: string, actor: string, purpose: 'SIM_SWAP' = 'SIM_SWAP'): Promise<{ challengeId: string; expiresAt: string; sentTo: string }> {
  return db.tx(async (q) => {
    const s = await lock(q, ref);
    if (s.type !== 'MOBILE' || s.status === 'TERMINATED') throw rejected('A one-time password can be sent only to a live mobile number.');
    const cfg = await getNorthSettings(q);
    const recent = Number((await q.query(`SELECT count(*) AS n FROM subscriber_otps WHERE service_id=$1 AND created_at > now() - interval '10 minutes'`, [s.id])).rows[0]!.n);
    if (recent >= 3) throw new (await import('./errors.js')).DomainError('RATE_LIMITED', 'Too many one-time passwords were requested for this number. Try again in a few minutes.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expires = new Date(Date.now() + cfg.otpTtlMinutes * 60_000);
    const id = randomUUID();
    await q.query(`INSERT INTO subscriber_otps (id, service_id, purpose, code_hash, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, s.id, purpose, hashOtp(s.id, code), expires.toISOString(), actor]);
    await queueOutbox(q, { kind: 'NOTIFY', instruction: 'OTP', serviceId: s.id, accountId: s.accountId, payload: { channel: 'SMS', to: s.identifier, purpose, ttlMinutes: cfg.otpTtlMinutes, message: `Your verification code is ${code}. It is valid for ${cfg.otpTtlMinutes} minutes. Never share it.` } });
    await audit(q, actor, 'service', s.id, 'OTP_ISSUED', { purpose, challengeId: id });
    return { challengeId: id, expiresAt: expires.toISOString(), sentTo: maskMsisdn(s.identifier) };
  });
}
/** Checks `challengeId.code`; the password works once, for the number it was sent to, and only five wrong tries are allowed. */
async function consumeOtp(q: Queryable, s: Row, token: string, purpose: 'SIM_SWAP') {
  const m = /^([0-9a-f-]{36})\.(\d{6})$/i.exec(token.trim());
  if (!m) throw invalid('The verification token is the challenge id, a dot and the six-digit code.');
  const r = (await q.query(`SELECT * FROM subscriber_otps WHERE id=$1 AND service_id=$2 AND purpose=$3 FOR UPDATE`, [m[1]!.toLowerCase(), s.id, purpose])).rows[0];
  if (!r || r.consumedAt) throw rejected('The verification code is not valid.');
  if (new Date(r.expiresAt) < new Date()) throw rejected('The verification code has expired.');
  if (r.attempts >= 5) throw rejected('Too many wrong attempts. Ask for a new code.');
  if (r.codeHash !== hashOtp(s.id, m[2]!)) {
    await q.query('UPDATE subscriber_otps SET attempts = attempts + 1 WHERE id=$1', [r.id]);
    throw rejected('The verification code is not valid.');
  }
  await q.query('UPDATE subscriber_otps SET consumed_at = now() WHERE id=$1', [r.id]);
}

// ───────────────────────── SIM swap ─────────────────────────
export const SIM_SWAP_REASONS = ['LOST', 'STOLEN', 'DAMAGED', 'UPGRADE', 'ESIM_CONVERSION', 'OTHER'] as const;
export interface SimSwapInput { newIccid?: string; esim?: boolean; reason: (typeof SIM_SWAP_REASONS)[number]; otpToken?: string }

export async function changeSimNorth(db: Db, ref: string, i: SimSwapInput, actor: string) {
  if (!(SIM_SWAP_REASONS as readonly string[]).includes(i.reason)) throw invalid(`The reason is one of ${SIM_SWAP_REASONS.join(', ')}.`);
  if (!!i.newIccid === !!i.esim) throw invalid('Give either the new ICCID (a physical SIM or a prepared eSIM) or ask for a new eSIM profile, not both.');
  if (i.newIccid && !/^89\d{17,18}$/.test(i.newIccid)) throw invalid('An ICCID is 19 or 20 digits starting with 89.');
  return db.tx(async (q) => {
    const cfg = await getNorthSettings(q);
    const s = await lock(q, ref);
    if (s.type !== 'MOBILE') throw rejected('A SIM swap applies to mobile services.');
    if (!['ACTIVE', 'SUSPENDED'].includes(s.status)) throw rejected(`The service is ${String(s.status).toLowerCase()}, so its SIM cannot be swapped.`);
    if (cfg.simSwapOtpRequired) { if (!i.otpToken) throw invalid('A verification token (from POST …/otp) is required for a SIM swap.'); await consumeOtp(q, s, i.otpToken, 'SIM_SWAP'); }
    // the new SIM must be in stock
    const sim = i.newIccid
      ? (await q.query('SELECT * FROM iccid_inventory WHERE iccid=$1 FOR UPDATE', [i.newIccid])).rows[0]
      : (await q.query(`SELECT * FROM iccid_inventory WHERE kind='ESIM' AND state IN ('WAREHOUSE_INVENTORY','DISTRIBUTED_DEALER') ORDER BY created_at, iccid LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
    if (!sim) throw i.newIccid ? notFound('SIM in inventory', i.newIccid) : rejected('No eSIM profile is available. Replenish the eSIM pool.');
    if (sim.iccid === s.iccid) throw invalid('The service already uses this SIM.');
    if (!['WAREHOUSE_INVENTORY', 'DISTRIBUTED_DEALER', 'RESERVED'].includes(sim.state) || sim.transferId || (sim.serviceId && sim.serviceId !== s.id)) throw conflict(`SIM ${sim.iccid} is ${String(sim.state).toLowerCase().replace(/_/g, ' ')} and cannot be issued.`);
    if (i.reason === 'ESIM_CONVERSION' && sim.kind !== 'ESIM') throw invalid('Converting to eSIM needs an eSIM profile.');
    // retire the old SIM (lost, stolen or damaged ones are scrapped), quarantine its identity, and bring the new SIM in
    const old = s.iccid ? (await q.query('SELECT * FROM iccid_inventory WHERE iccid=$1 FOR UPDATE', [s.iccid])).rows[0] : null;
    if (old && old.state === 'ACTIVE') {
      const to: IccidState = old.kind === 'ESIM' ? 'WAREHOUSE_INVENTORY' : ['LOST', 'STOLEN', 'DAMAGED'].includes(i.reason) ? 'DAMAGED_SCRAPPED' : 'DECOMMISSIONED';
      assertIccidTransition(old.iccid, old.state, to);
      await q.query(`UPDATE iccid_inventory SET state=$2, service_id=NULL, imsi=${old.kind === 'ESIM' ? 'NULL' : 'imsi'}, updated_at=now() WHERE iccid=$1`, [old.iccid, to]);
      await auditIdentifier(q, { type: 'ICCID', id: old.iccid, from: old.state, to, actor, reason: `SIM swap: ${i.reason}`, detail: { service: s.id, replacedBy: sim.iccid } });
      const oldImsi = (await q.query('SELECT * FROM imsi_inventory WHERE service_id=$1 OR iccid=$2 FOR UPDATE', [s.id, old.iccid])).rows[0];
      if (oldImsi && oldImsi.state === 'ACTIVE') {
        const days = (await getLifecycleSettings(q)).termination.quarantineDays;
        assertImsiTransition(oldImsi.imsi, oldImsi.state, 'QUARANTINED');
        await q.query(`UPDATE imsi_inventory SET state='QUARANTINED', iccid=NULL, service_id=NULL, previous_msisdn=$2, quarantine_until=$3, updated_at=now() WHERE imsi=$1`, [oldImsi.imsi, s.identifier, addDays(today(), days)]);
        await auditIdentifier(q, { type: 'IMSI', id: oldImsi.imsi, from: oldImsi.state, to: 'QUARANTINED', actor, reason: `SIM swap: ${i.reason}` });
      }
    }
    await assertNotBlacklisted(q, { iccid: sim.iccid });
    if (sim.state !== 'RESERVED') { assertIccidTransition(sim.iccid, sim.state, 'RESERVED'); await q.query(`UPDATE iccid_inventory SET state='RESERVED', previous_state=$2, updated_at=now() WHERE iccid=$1`, [sim.iccid, sim.state]); }
    assertIccidTransition(sim.iccid, 'RESERVED', 'ACTIVE');
    await q.query(`UPDATE iccid_inventory SET state='ACTIVE', service_id=$2, reserved_until=NULL, previous_state=NULL, updated_at=now() WHERE iccid=$1`, [sim.iccid, s.id]);
    await auditIdentifier(q, { type: 'ICCID', id: sim.iccid, from: sim.state, to: 'ACTIVE', actor, reason: `SIM swap: ${i.reason}`, detail: { service: s.id, replaces: old?.iccid ?? s.iccid ?? null } });
    let imsi = (sim.imsi as string | null) ?? null;
    if (imsi) {
      const im = (await q.query('SELECT * FROM imsi_inventory WHERE imsi=$1 FOR UPDATE', [imsi])).rows[0];
      if (im && im.state !== 'ACTIVE') { assertImsiTransition(imsi, im.state, 'ACTIVE'); await q.query(`UPDATE imsi_inventory SET state='ACTIVE', iccid=$3, service_id=$2, updated_at=now() WHERE imsi=$1`, [imsi, s.id, sim.iccid]); await auditIdentifier(q, { type: 'IMSI', id: imsi, from: im.state, to: 'ACTIVE', actor, detail: { service: s.id, iccid: sim.iccid } }); }
    }
    await q.query('UPDATE services SET iccid=$2, imsi=$3, sim_swapped_at=now(), version=version+1, updated_at=now() WHERE id=$1', [s.id, sim.iccid, imsi]);
    // the network and the charging system learn the new identity
    await queueOutbox(q, { kind: 'NETWORK', instruction: 'SIM_SWAP', serviceId: s.id, accountId: s.accountId, payload: { identifier: s.identifier, from: { iccid: s.iccid ?? null, imsi: s.imsi ?? null }, to: { iccid: sim.iccid, imsi }, kind: sim.kind, reason: i.reason, targets: ['HLR_HSS', 'UDM', 'OCS'] } });
    await enqueueOcs(q, 'CHANGE_IDENTITY', s.id, { identity: { from: { identifier: null, iccid: (s.iccid as string | null) ?? null }, to: { identifier: null, iccid: sim.iccid } } });
    if (sim.kind === 'ESIM') await queueOutbox(q, { kind: 'NETWORK', instruction: 'ESIM_PROFILE_DOWNLOAD', serviceId: s.id, accountId: s.accountId, payload: { iccid: sim.iccid, matchingId: sim.iccid.slice(-12), activationCode: sim.activationCode ?? null, target: 'SMDP_PLUS' } });
    await audit(q, actor, 'service', s.id, 'SIM_SWAP', { reason: i.reason, from: s.iccid ?? null, to: sim.iccid, kind: sim.kind, otpChecked: cfg.simSwapOtpRequired, security: true });
    await logLifecycle(q, { serviceId: s.id, accountId: s.accountId, action: 'SIM_SWAP', from: s.status, to: s.status, kind: null, actor, detail: { reason: i.reason, to: sim.iccid } });
    await queueOutbox(q, { kind: 'NOTIFY', instruction: 'SIM_SWAP_NOTICE', serviceId: s.id, accountId: s.accountId, payload: { to: s.identifier, message: 'Your SIM was changed. If this was not you, contact us at once.' } });
    const fee = await chargeFee(q, s, cfg.simSwapFeeMinor, 'SIM replacement fee');
    await emitEvent(q, 'SIM_SWAPPED', s, { reason: i.reason, from: s.iccid ?? null, to: sim.iccid, kind: sim.kind });
    return { service: await tmfService(q, s.id), result: { iccid: sim.iccid, kind: sim.kind, previousIccid: s.iccid ?? null, ...(sim.kind === 'ESIM' ? { activationCode: sim.activationCode ?? null } : {}), fee } };
  });
}

// ───────────────────────── number change ─────────────────────────
export async function changeMsisdnNorth(db: Db, ref: string, i: { targetMsisdn?: string; acceptCharge?: boolean }, actor: string) {
  if (i.targetMsisdn !== undefined && !/^\+\d{8,15}$/.test(i.targetMsisdn)) throw invalid('The target number is in E.164 form, for example +6591234567.');
  return db.tx(async (q) => {
    const cfg = await getNorthSettings(q);
    const s = await lock(q, ref);
    if (s.type !== 'MOBILE') throw rejected('A number change applies to mobile services.');
    if (s.status !== 'ACTIVE') throw rejected(`The service must be active (it is ${String(s.status).toLowerCase()}).`);
    const target = i.targetMsisdn ?? (await q.query(`SELECT msisdn FROM msisdn_inventory WHERE state='AVAILABLE' AND tier='STANDARD' ORDER BY msisdn LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0]?.msisdn as string | undefined;
    if (!target) throw rejected('No standard number is free in the pool.');
    if (target === s.identifier) throw invalid('The service already has this number.');
    const holder = `svc:${s.id}`;
    const res = await reserveMsisdnTx(q, target, holder, randomUUID(), 5 * 60_000, { actor });
    const feeMinor = res.oneTimeFeeMinor + cfg.numberChangeFeeMinor;
    if (feeMinor > 0 && !i.acceptCharge) throw rejected(`This change costs ${feeMinor} (minor units). Send acceptCharge: true to confirm.`);
    const cust = (await q.query('SELECT market_code FROM customers WHERE id=$1', [s.customerId])).rows[0]!;
    await marketFor(q, cust.marketCode);
    try { await q.query(`INSERT INTO identifier_registry (type, identifier, service_id) VALUES ('MOBILE', $1, $2)`, [target, s.id]); }
    catch (e) { if (/duplicate key/.test((e as Error).message)) throw conflict(`${target} is already in service`); throw e; }
    await consumeMsisdnTx(q, target, s.id, actor);
    // the old number cools off before it can be sold again
    const old = (await q.query('SELECT * FROM msisdn_inventory WHERE msisdn=$1 FOR UPDATE', [s.identifier])).rows[0];
    const days = (await getLifecycleSettings(q)).termination.quarantineDays;
    if (old) {
      assertMsisdnTransition(old.msisdn, old.state, 'QUARANTINE_COOLING');
      await q.query(`UPDATE msisdn_inventory SET state='QUARANTINE_COOLING', service_id=NULL, quarantine_until=$2, updated_at=now() WHERE msisdn=$1`, [old.msisdn, addDays(today(), days)]);
      await auditIdentifier(q, { type: 'MSISDN', id: old.msisdn, from: old.state, to: 'QUARANTINE_COOLING', actor, reason: 'number change', detail: { until: addDays(today(), days), replacedBy: target } });
    }
    await q.query('UPDATE services SET identifier=$2, version=version+1, updated_at=now() WHERE id=$1', [s.id, target]);
    await queueOutbox(q, { kind: 'NETWORK', instruction: 'MSISDN_CHANGE', serviceId: s.id, accountId: s.accountId, payload: { from: s.identifier, to: target, iccid: s.iccid ?? null, targets: ['HLR_HSS', 'UDM', 'OCS'] } });
    await enqueueOcs(q, 'CHANGE_IDENTITY', s.id, { identity: { from: { identifier: s.identifier as string, iccid: null }, to: { identifier: target, iccid: null } } });
    await queueOutbox(q, { kind: 'NOTIFY', instruction: 'MSISDN_CHANGED_NOTICE', serviceId: s.id, accountId: s.accountId, payload: { to: target, previous: s.identifier } });
    await audit(q, actor, 'service', s.id, 'MSISDN_CHANGE', { from: s.identifier, to: target, feeMinor });
    const fee = await chargeFee(q, s, feeMinor, 'Number change fee');
    await emitEvent(q, 'MSISDN_CHANGED', { ...s, identifier: target }, { from: s.identifier, to: target, quarantineDays: days });
    return { service: await tmfService(q, s.id), result: { previousMsisdn: s.identifier, msisdn: target, previousNumberAvailableFrom: addDays(today(), days), fee } };
  });
}

// ───────────────────────── transfer of ownership ─────────────────────────
export interface TransferInput { toCustomerId: string; toAccountId?: string; creditCheckAuthorised: boolean }
export async function transferOwnershipNorth(db: Db, ref: string, i: TransferInput, actor: string) {
  if (!i.creditCheckAuthorised) throw invalid('The new owner must authorise a credit check (creditCheckAuthorised: true).');
  return db.tx(async (q) => {
    const cfg = await getNorthSettings(q);
    const s = await lock(q, ref);
    if (s.status !== 'ACTIVE') throw rejected(`The service must be active (it is ${String(s.status).toLowerCase()}).`);
    if (s.customerId === i.toCustomerId) throw invalid('The service already belongs to this customer.');
    const to = (await q.query('SELECT * FROM customers WHERE id=$1', [i.toCustomerId])).rows[0];
    if (!to) throw notFound('customer', i.toCustomerId);
    // identity and credit of the new owner
    if (to.status !== 'ACTIVE') throw rejected('The receiving customer is not active.');
    if (to.kycStatus !== 'VERIFIED') throw rejected('The receiving customer has not been identity-verified (KYC).');
    if (to.creditRisk === 'HIGH') throw rejected('The credit check on the receiving customer was declined.');
    const owed = Number((await q.query(`SELECT COALESCE(sum(total_minor - paid_minor - credited_minor),0) AS d FROM invoices WHERE customer_id=$1 AND status='OVERDUE'`, [to.id])).rows[0]!.d);
    if (owed > 0) throw rejected('The credit check on the receiving customer was declined: they have an overdue balance.');
    const from = (await q.query('SELECT * FROM accounts WHERE id=$1', [s.accountId])).rows[0]!;
    const overdue = Number((await q.query(`SELECT COALESCE(sum(total_minor - paid_minor - credited_minor),0) AS d FROM invoices WHERE account_id=$1 AND status='OVERDUE'`, [s.accountId])).rows[0]!.d);
    if (overdue > 0) throw rejected('The transfer is blocked: the current owner has an overdue balance.');
    if (to.shardId !== s.shardId) throw rejected('Cross-shard transfers go through the shard migration job.');
    // the departing owner's closing bill: what has not been billed yet (the contract continues with the new owner, so no early-termination charge)
    const when = new Date();
    const closing = await closingStatement(q, s, { scenario: 'OWNERSHIP_TRANSFER', etcAdjust: { waive: true, reason: 'Ownership transfer: the contract continues with the new owner' } }, await getLifecycleSettings(q), actor, when);
    const d = today();
    const fee = cfg.ownershipTransferFeeMinor;
    const lines = [...closing.lines, ...(fee > 0 ? [{ serviceId: s.id, kind: 'ADJUSTMENT', revenueAccount: GL.SERVICE_REVENUE, description: `Ownership transfer fee ${s.identifier}`, amountMinor: fee, taxInclusive: true } as DraftLine] : [])];
    const invoice = lines.length ? await issueInvoice(q, from, { kind: 'FINAL', periodStart: d, periodEnd: d, issueDate: d, lines }) : null;
    await releaseFromGroup(q, actor, s.id);
    let acct = i.toAccountId;
    if (acct) { const a = (await q.query('SELECT customer_id FROM accounts WHERE id=$1', [acct])).rows[0]; if (!a || a.customerId !== to.id) throw invalid('toAccountId does not belong to the receiving customer.'); }
    else acct = (await q.query(`SELECT id FROM accounts WHERE customer_id=$1 AND status='ACTIVE' ORDER BY created_at LIMIT 1`, [to.id])).rows[0]?.id ?? (await createAccount(q, to.id, {})).id;
    await q.query('UPDATE services SET customer_id=$2, account_id=$3, version=version+1, updated_at=now() WHERE id=$1', [s.id, to.id, acct]);
    await q.query('UPDATE service_charges SET account_id=$2 WHERE service_id=$1 AND remaining_cycles>0', [s.id, acct]);     // active contracts and instalments follow the service
    await queueOutbox(q, { kind: 'NETWORK', instruction: 'OWNER_CHANGE', serviceId: s.id, accountId: acct, payload: { identifier: s.identifier, fromCustomer: s.customerId, toCustomer: to.id, targets: ['OCS'] } });
    await audit(q, actor, 'service', s.id, 'OWNERSHIP_TRANSFER', { from: s.customerId, to: to.id, closingInvoice: invoice?.number ?? null, creditChecked: true });
    await emitEvent(q, 'OWNERSHIP_TRANSFERRED', { ...s, customerId: to.id, accountId: acct }, { fromCustomerId: s.customerId, toCustomerId: to.id, fromAccountId: s.accountId, toAccountId: acct });
    return { service: await tmfService(q, s.id), result: { fromCustomerId: s.customerId, toCustomerId: to.id, toAccountId: acct, closingInvoice: invoice ? { id: invoice.id, number: invoice.number, totalMinor: Number(invoice.totalMinor) } : null, contractContinues: s.contractTermMonths > 0 } };
  });
}

// ───────────────────────── status ─────────────────────────
export const STATUS_ACTIONS = ['SUSPEND', 'RESUME', 'SOFT_BAR', 'HARD_BAR', 'TERMINATE'] as const;
export interface StatusInput { action: (typeof STATUS_ACTIONS)[number]; /** For TERMINATE: why the contract ends (an early termination scenario). */ scenario?: string; reason?: string; months?: number; until?: string; unbilledUsageMinor?: number }

export async function setStatusNorth(db: Db, ref: string, i: StatusInput, actor: string, channel: 'STAFF' | 'SELF_SERVE' = 'STAFF') {
  if (!(STATUS_ACTIONS as readonly string[]).includes(i.action)) throw invalid(`The action is one of ${STATUS_ACTIONS.join(', ')}.`);
  const found = await resolveService(db, ref);
  const id = found.id as string;
  let event: string;
  switch (i.action) {
    case 'SUSPEND':
      // a customer-requested (voluntary) suspension is capped by the lifecycle settings; a reason of FRAUD or ADMIN is an operator restriction
      if (!i.reason || i.reason === 'VOLUNTARY' || i.reason === 'CUSTOMER_REQUEST') await suspendVoluntary(db, id, { months: i.months, until: i.until, channel }, actor);
      else await suspendService(db, id, i.reason === 'FRAUD' ? 'FRAUD' : 'ADMIN', actor, { kind: i.reason === 'FRAUD' ? 'FRAUD' : 'ADMIN' });
      event = 'SERVICE_SUSPENDED'; break;
    case 'RESUME': {
      const s = (await db.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!;
      if (s.status === 'ACTIVE' && s.barLevel !== 'NONE') {          // a soft bar lifts without a suspension to end
        await db.tx(async (q) => {
          const t = await lock(q, id);
          if (!['ADMIN', 'FRAUD'].includes(t.suspensionKind)) throw rejected('That bar was put on by billing and lifts when the balance is paid.');
          await q.query(`UPDATE services SET suspension_kind=NULL, suspended_reason=NULL, suspended_at=NULL, version=version+1, updated_at=now() WHERE id=$1`, [id]);
          await setBarLevel(q, t, 'NONE', { kind: t.suspensionKind, actor });
          await logLifecycle(q, { serviceId: id, accountId: t.accountId, action: 'UNBAR', from: 'ACTIVE', to: 'ACTIVE', kind: t.suspensionKind, actor, detail: { via: 'northbound' } });
        });
      } else await resumeService(db, id, actor, { channel });
      event = 'SERVICE_RESUMED'; break;
    }
    case 'SOFT_BAR': case 'HARD_BAR': {
      const level = i.action === 'SOFT_BAR' ? 'SOFT' : 'HARD';
      if (level === 'HARD') await suspendService(db, id, i.reason === 'FRAUD' ? 'FRAUD' : 'ADMIN', actor, { kind: i.reason === 'FRAUD' ? 'FRAUD' : 'ADMIN' });
      else await db.tx(async (q) => {
        const t = await lock(q, id);
        if (t.status !== 'ACTIVE') throw rejected(`Only an active service can be soft-barred (it is ${String(t.status).toLowerCase()}).`);
        if (t.barLevel !== 'NONE') throw rejected(`The service already has a ${String(t.barLevel).toLowerCase()} bar.`);
        const kind = i.reason === 'FRAUD' ? 'FRAUD' : 'ADMIN';
        await q.query(`UPDATE services SET suspension_kind=$2, suspended_reason=$2, suspended_at=now(), version=version+1, updated_at=now() WHERE id=$1`, [id, kind]);
        await setBarLevel(q, t, 'SOFT', { kind, actor });
        await logLifecycle(q, { serviceId: id, accountId: t.accountId, action: 'BAR', from: 'ACTIVE', to: 'ACTIVE', kind, actor, detail: { bar: 'SOFT', via: 'northbound', reason: i.reason ?? null } });
      });
      event = 'SERVICE_BARRED'; break;
    }
    case 'TERMINATE':
      await terminateService(db, id, { reason: i.reason ?? 'CUSTOMER_REQUEST', scenario: i.scenario as never, unbilledUsageMinor: i.unbilledUsageMinor }, actor);
      event = 'SERVICE_TERMINATED'; break;
  }
  await db.tx(async (q) => { const s = (await q.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!; await emitEvent(q, event, s, { action: i.action, reason: i.reason ?? null, status: s.status, barLevel: s.barLevel }); });
  return { service: await tmfService(db, id), result: { action: i.action } };
}

// ───────────────────────── plan change ─────────────────────────
export interface NorthPlanChange { targetOfferId: string; effective: 'IMMEDIATE' | 'NEXT_BILL_CYCLE'; addOns?: string[]; acceptContractTerms?: boolean;
  /** The customer's signature on the plan change agreement (required when Settings → Documents says so). `ip`/`userAgent` are of the device they signed on. */
  agreement?: { signature: SignatureInput; versionIds?: string[]; ip?: string | null; userAgent?: string | null; agentName?: string | null } }
const offerNode = (r: Row): OfferNode => ({ id: r.id, name: r.name, kind: r.kind, ...r.data }) as unknown as OfferNode;

export async function changePlanNorth(db: Db, ref: string, i: NorthPlanChange, actor: string) {
  if (!['IMMEDIATE', 'NEXT_BILL_CYCLE'].includes(i.effective)) throw invalid('Effective date is IMMEDIATE or NEXT_BILL_CYCLE.');
  const found = await resolveService(db, ref);
  const out = await db.tx(async (q) => {
    const cfg = await getNorthSettings(q);
    const s = await lock(q, found.id as string);
    if (!['ACTIVE', 'SUSPENDED'].includes(s.status)) throw rejected(`The service is ${String(s.status).toLowerCase()}, so its plan cannot be changed.`);
    if (s.type === 'SUBSCRIPTION') throw rejected('Value-added services are changed through the vas endpoint.');
    if (i.targetOfferId === s.offerId) throw invalid('The service is already on that plan.');
    const [oldRow, newRow] = await Promise.all([q.query(`SELECT * FROM catalog_nodes WHERE id=$1 AND level='OFFER'`, [s.offerId]), q.query(`SELECT * FROM catalog_nodes WHERE id=$1 AND level='OFFER'`, [i.targetOfferId])]).then((r) => r.map((x) => x.rows[0]));
    if (!newRow) throw notFound('plan', i.targetOfferId);
    if (newRow.status !== 'ACTIVE') throw rejected(`${newRow.name} is not on sale.`);
    const oldO = offerNode(oldRow!), newO = offerNode(newRow);
    // compatibility: a plan replaces a plan of the same kind of service, with no device or goods of its own
    const nb = behaviourOf(newO), ob = behaviourOf(oldO);
    if (nb.role !== 'PLAN' || nb.goods) throw rejected(`${newRow.name} is not a plan that can be moved to.`);
    if ((nb.service ?? 'MOBILE') !== (ob.service ?? s.type)) throw rejected(`${newRow.name} is a ${nb.service ?? 'MOBILE'} plan; this service is ${ob.service ?? s.type}.`);
    const oldFee = monthlyFee(oldO), newFee = monthlyFee(newO);
    if (!newFee) throw invalid(`${newRow.name} has no monthly fee.`);
    const downgrade = newFee.amount.amountMinor < (oldFee?.amount.amountMinor ?? 0);
    if (s.contractTermMonths > 0 && s.contractStart && downgrade && !i.acceptContractTerms) throw rejected('This service is on a contract and the new plan is cheaper. Send acceptContractTerms: true to confirm the contract terms apply.');
    for (const a of i.addOns ?? []) {
      const ao = (await q.query(`SELECT kind, status, name FROM catalog_nodes WHERE id=$1 AND level='OFFER'`, [a])).rows[0];
      if (!ao || ao.kind !== 'VAS') throw invalid(`${a} is not a value-added service.`);
      if (ao.status !== 'ACTIVE') throw rejected(`${ao.name} is not on sale.`);
    }
    const sim = await simulatePlanChange(q, s.id, { newOfferId: i.targetOfferId });
    const adjustMinor = i.effective === 'IMMEDIATE' ? (sim.withChange as Row).netMinor - (sim.followingStatement as Row).netMinor : 0;
    const summary = { from: sim.from, to: sim.to, statementDate: sim.statementDate, prorationMinor: adjustMinor, notes: sim.notes };
    // The customer agrees to the change in writing: the plan change agreement is signed, sealed and stored with the service before anything moves.
    const effDate = i.effective === 'NEXT_BILL_CYCLE' ? (sim.statementDate as string) : today();
    const signed = await signAgreements(q, { context: 'PLAN_CHANGE', offerKinds: [String(newRow.kind)], customerId: s.customerId as string, serviceId: s.id as string, reference: String(s.identifier ?? s.id), signature: i.agreement?.signature, versionIds: i.agreement?.versionIds,
      values: await planChangeValues(q, s.customerId as string, { from: oldRow!.name as string, to: newRow.name as string, effectiveDate: effDate, monthlyMinor: newFee.amount.amountMinor, msisdn: s.identifier as string }),
      ctx: { who: { username: actor, ip: i.agreement?.ip ?? null, userAgent: i.agreement?.userAgent ?? null }, method: 'PLAN_CHANGE', agentName: i.agreement?.agentName ?? (actor.startsWith('api:') ? null : actor) } });
    if (signed.length) await queueDocumentDelivery(q, { customerId: s.customerId as string, documentIds: signed.map((d) => d.documentId), reference: `your plan change on ${s.identifier}` });
    if (i.effective === 'NEXT_BILL_CYCLE') {
      const eff = sim.statementDate as string;
      await q.query(`UPDATE pending_plan_changes SET status='CANCELLED' WHERE service_id=$1 AND status='PENDING'`, [s.id]);
      await q.query(`INSERT INTO pending_plan_changes (service_id, account_id, from_offer_id, offer_id, effective_on, add_ons, detail, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [s.id, s.accountId, s.offerId, i.targetOfferId, eff, JSON.stringify(i.addOns ?? []), JSON.stringify({ acceptContractTerms: !!i.acceptContractTerms }), actor]);
      await audit(q, actor, 'service', s.id, 'PLAN_CHANGE_SCHEDULED', { to: i.targetOfferId, effectiveOn: eff });
      return { status: 'SCHEDULED' as const, effectiveOn: eff, summary, serviceId: s.id as string, applied: null as null | Row };
    }
    const applied = await applyPlanChange(q, s, newRow, i.addOns ?? [], actor, { prorationMinor: adjustMinor, feeMinor: cfg.planChangeFeeMinor, effective: today() });
    return { status: 'APPLIED' as const, effectiveOn: today(), summary, serviceId: s.id as string, applied };
  });
  return { service: await tmfService(db, out.serviceId), result: { status: out.status, effectiveOn: out.effectiveOn, ...out.summary, ...(out.applied ?? {}) } };
}

/** What the plan change agreement says for this customer and change, and whether it must be signed: for the screen that asks them. Changes nothing. */
export async function previewPlanChangeAgreements(db: Db, ref: string, i: { targetOfferId: string; effective: 'IMMEDIATE' | 'NEXT_BILL_CYCLE' }) {
  const found = await resolveService(db, ref);
  const s = (await db.query('SELECT * FROM services WHERE id=$1', [found.id])).rows[0]!;
  const [oldRow, newRow] = await Promise.all([db.query(`SELECT * FROM catalog_nodes WHERE id=$1 AND level='OFFER'`, [s.offerId]), db.query(`SELECT * FROM catalog_nodes WHERE id=$1 AND level='OFFER'`, [i.targetOfferId])]).then((r) => r.map((x) => x.rows[0] as Row | undefined));
  if (!newRow) throw notFound('plan', i.targetOfferId);
  const fee = monthlyFee(offerNode(newRow));
  const sim = await simulatePlanChange(db, s.id, { newOfferId: i.targetOfferId });
  const values = await planChangeValues(db, s.customerId as string, { from: (oldRow?.name as string) ?? String(s.offerId), to: newRow.name as string, effectiveDate: i.effective === 'NEXT_BILL_CYCLE' ? (sim.statementDate as string) : today(), monthlyMinor: fee?.amount.amountMinor ?? 0, msisdn: s.identifier as string });
  return agreementsFor(db, { context: 'PLAN_CHANGE', offerKinds: [String(newRow.kind)], values });
}

/** Moves the service to the new plan: contract, charging system buckets, the proration of this period, any plan-change fee, and the add-ons chosen with it. */
async function applyPlanChange(q: Queryable, s: Row, newRow: Row, addOns: string[], actor: string, o: { prorationMinor: number; feeMinor: number; effective: string }): Promise<Row> {
  const term = Number(newRow.data?.contract?.termMonths ?? 0);
  await q.query(`UPDATE services SET offer_id=$2, contract_term_months=$3::int, contract_start=CASE WHEN $3::int > 0 THEN $4::date ELSE NULL END, version=version+1, updated_at=now() WHERE id=$1`, [s.id, newRow.id, term > 0 ? term : null, o.effective]);
  if (o.prorationMinor !== 0) await q.query(`INSERT INTO service_charges (shard_id, service_id, account_id, kind, description, amount_minor, tax_inclusive, remaining_cycles) VALUES ($1,$2,$3,'ADJUSTMENT',$4,$5,false,1)`, [s.shardId, s.id, s.accountId, `Plan change to ${newRow.name}: pro-rating for this period`, o.prorationMinor]);
  const fee = await chargeFee(q, s, o.feeMinor, 'Plan change fee');
  await enqueueOcs(q, 'CHANGE_PLAN', s.id);
  await queueOutbox(q, { kind: 'NETWORK', instruction: 'PLAN_CHANGE', serviceId: s.id, accountId: s.accountId, payload: { identifier: s.identifier, fromOffer: s.offerId, toOffer: newRow.id, targets: ['OCS', 'PCRF'] } });
  await audit(q, actor, 'service', s.id, 'PLAN_CHANGE', { from: s.offerId, to: newRow.id, prorationMinor: o.prorationMinor, feeMinor: o.feeMinor });
  const added: string[] = [];
  for (const a of addOns) added.push((await addVasTx(q, { ...s, offerId: newRow.id }, a, actor)).vasServiceId);
  await emitEvent(q, 'PLAN_CHANGED', { ...s, offerId: newRow.id }, { fromOffer: s.offerId, toOffer: newRow.id, effective: o.effective });
  return { fee, addOns: added, contractTermMonths: term || null } as unknown as Row;
}

/** Plan changes scheduled for the next bill take effect the day after the bill date, once that bill has been issued for the old plan. */
export async function applyDuePlanChanges(db: Db, asOf: string = today(), actor = 'system'): Promise<{ applied: number; failed: number }> {
  const due = (await db.query(`SELECT * FROM pending_plan_changes WHERE status='PENDING' AND effective_on < $1::date ORDER BY effective_on, created_at LIMIT 1000`, [asOf])).rows;
  const out = { applied: 0, failed: 0 };
  for (const p of due) {
    try {
      await db.tx(async (q) => {
        const s = await lock(q, p.serviceId);
        const newRow = (await q.query(`SELECT * FROM catalog_nodes WHERE id=$1 AND level='OFFER'`, [p.offerId])).rows[0];
        if (!newRow || newRow.status !== 'ACTIVE' || s.status === 'TERMINATED' || s.offerId !== p.fromOfferId) throw new Error('the service or the plan changed since it was scheduled');
        const cfg = await getNorthSettings(q);
        await applyPlanChange(q, s, newRow, p.addOns ?? [], p.createdBy, { prorationMinor: 0, feeMinor: cfg.planChangeFeeMinor, effective: p.effectiveOn.toString().slice(0, 10) });
        await q.query(`UPDATE pending_plan_changes SET status='APPLIED', applied_at=now() WHERE id=$1`, [p.id]);
      });
      out.applied++;
    } catch (e) {
      await db.query(`UPDATE pending_plan_changes SET status='FAILED', detail = detail || $2::jsonb WHERE id=$1`, [p.id, JSON.stringify({ error: (e as Error).message })]);
      out.failed++;
    }
  }
  return out;
}

export async function cancelPendingPlanChange(db: Db, ref: string, actor: string) {
  const s = await resolveService(db, ref);
  const r = await db.query(`UPDATE pending_plan_changes SET status='CANCELLED' WHERE service_id=$1 AND status='PENDING'`, [s.id]);
  if (!r.rowCount) throw notFound('scheduled plan change', s.id);
  await audit(db, actor, 'service', s.id, 'PLAN_CHANGE_CANCELLED');
  return { ok: true };
}

// ───────────────────────── value-added services and passes ─────────────────────────
export const VAS_ACTIONS = ['ADD', 'REMOVE'] as const;
async function addVasTx(q: Queryable, parent: Row, vasOfferId: string, actor: string): Promise<{ vasServiceId: string; identifier: string }> {
  const o = (await q.query(`SELECT * FROM catalog_nodes WHERE id=$1 AND level='OFFER'`, [vasOfferId])).rows[0];
  if (!o || o.kind !== 'VAS') throw invalid(`${vasOfferId} is not a value-added service.`);
  if (o.status !== 'ACTIVE') throw rejected(`${o.name} is not on sale.`);
  const dup = (await q.query(`SELECT 1 FROM services WHERE parent_service_id=$1 AND offer_id=$2 AND status <> 'TERMINATED'`, [parent.id, vasOfferId])).rows.length;
  if (dup) throw conflict(`${o.name} is already on this service.`);
  const requires = (o.data?.requires ?? []) as string[];
  if (requires.length) {
    const have = (await q.query(`SELECT 1 FROM services WHERE id=$1 AND deal IS NOT NULL`, [parent.id])).rows.length;
    if (requires.includes('grp-device') && !have) throw rejected(`${o.name} needs a plan with a device on a contract.`);
  }
  const id = randomUUID();
  const identifier = `VAS-${(await q.query(`SELECT nextval('circuit_seq') AS n`)).rows[0]!.n}`;
  await q.query(`INSERT INTO services (id, shard_id, account_id, customer_id, type, identifier, offer_id, status, activated_at, contract_term_months, parent_service_id) VALUES ($1,$2,$3,$4,'SUBSCRIPTION',$5,$6,'ACTIVE',now(),NULL,$7)`, [id, parent.shardId, parent.accountId, parent.customerId, identifier, vasOfferId, parent.id]);
  await q.query(`INSERT INTO identifier_registry (type, identifier, service_id) VALUES ('SUBSCRIPTION', $1, $2)`, [identifier, id]).catch(() => undefined);
  const partner = o.data?.partnerCode ? { partner: String(o.data.partnerCode) } : {};
  await queueOutbox(q, { kind: 'NETWORK', instruction: 'VAS_PROVISION', serviceId: parent.id, accountId: parent.accountId, payload: { identifier: parent.identifier, vasServiceId: id, offerId: vasOfferId, name: o.name, targets: ['PCRF', 'OCS'], ...partner } });
  if (partner.partner) await emitEvent(q, 'VAS_CHANGED', parent, { action: 'ADD', offerId: vasOfferId, partner: partner.partner, forPartnerWebhook: true });
  await audit(q, actor, 'service', parent.id, 'VAS_ADD', { offerId: vasOfferId, vasServiceId: id });
  return { vasServiceId: id, identifier };
}

export async function manageVasNorth(db: Db, ref: string, i: { action: (typeof VAS_ACTIONS)[number]; offerId: string }, actor: string) {
  if (!(VAS_ACTIONS as readonly string[]).includes(i.action)) throw invalid('The action is ADD or REMOVE.');
  return db.tx(async (q) => {
    const s = await lock(q, ref);
    if (s.type === 'SUBSCRIPTION' || s.status !== 'ACTIVE') throw rejected('Value-added services can be added to an active mobile, fibre or IoT service.');
    let result: Record<string, unknown>;
    if (i.action === 'ADD') {
      const r = await addVasTx(q, s, i.offerId, actor);
      result = { action: 'ADD', offerId: i.offerId, ...r };
    } else {
      const v = (await q.query(`SELECT * FROM services WHERE parent_service_id=$1 AND offer_id=$2 AND status <> 'TERMINATED' FOR UPDATE`, [s.id, i.offerId])).rows[0];
      if (!v) throw notFound('value-added service on this service', i.offerId);
      await q.query(`UPDATE services SET status='TERMINATED', terminated_at=now(), version=version+1, updated_at=now() WHERE id=$1`, [v.id]);
      await q.query(`DELETE FROM identifier_registry WHERE service_id=$1`, [v.id]);
      await q.query(`UPDATE service_charges SET remaining_cycles=0 WHERE service_id=$1`, [v.id]);
      await queueOutbox(q, { kind: 'NETWORK', instruction: 'VAS_DEPROVISION', serviceId: s.id, accountId: s.accountId, payload: { identifier: s.identifier, vasServiceId: v.id, offerId: i.offerId, targets: ['PCRF', 'OCS'] } });
      await audit(q, actor, 'service', s.id, 'VAS_REMOVE', { offerId: i.offerId, vasServiceId: v.id });
      result = { action: 'REMOVE', offerId: i.offerId, vasServiceId: v.id };
    }
    await emitEvent(q, 'VAS_CHANGED', s, { action: i.action, offerId: i.offerId });
    return { service: await tmfService(q, s.id), result };
  });
}
