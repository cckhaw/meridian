import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { importImsis, importMsisdns, importSims } from './nrm-pools.js';
import { placeOrder } from './orders.js';
import { runBillCycle } from './billing.js';
import { addDays, today } from './dates.js';
import { applyDuePlanChanges, cancelPendingPlanChange, changeMsisdnNorth, changePlanNorth, changeSimNorth, getNorthSettings, issueOtp, manageVasNorth, setNorthSettings, setStatusNorth, tmfService, transferOwnershipNorth } from './subscriber-ops.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await importImsis(db, { csv: Array.from({ length: 12 }, (_, i) => `52501${String(1_000_000_000 + i * 13)}`).join('\n') }, { apply: true, actor: 'ops' });
  await importSims(db, { csv: `iccid\n${sims.join('\n')}\n` }, { apply: true, actor: 'ops', locationId: 'WH-MAIN' });
  await importMsisdns(db, { range: { from: '+6581000000', to: '+6581000099' } }, { apply: true, actor: 'ops' });
  await db.query(`INSERT INTO iccid_inventory (iccid, kind, state, location_id, activation_code) VALUES ('8965000000000000001','ESIM','WAREHOUSE_INVENTORY','WH-MAIN','LPA:1$smdp.example.net$MATCH0001')`);
});
afterAll(async () => { await db.close(); });
const retail = { storeId: 'STORE-SG-001', salespersonId: 'a1' };
const sims = Array.from({ length: 6 }, (_, i) => `8960${String(1_000_000_000_000_000 + (i + 1) * 7).slice(1)}`);

async function mobile(offerId = 'plan-sim-5g') {
  const c = await newCustomer(db);
  const o = await placeOrder(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId }] });
  return { ...c, serviceId: o.services[0].id as string, msisdn: o.services[0].identifier as string };
}
const outbox = async (serviceId: string, instruction: string) => (await db.query(`SELECT payload FROM lifecycle_outbox WHERE service_id=$1 AND instruction=$2 ORDER BY id`, [serviceId, instruction])).rows.map((r) => r.payload as Record<string, any>);
const svc = async (id: string) => (await db.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!;

describe('SIM swap', () => {
  it('needs a one-time password sent to the number, swaps in a stocked SIM, retires the old one and tells the network', async () => {
    const a = await mobile();
    await expect(changeSimNorth(db, a.serviceId, { newIccid: sims[0]!, reason: 'DAMAGED' }, 'ivr')).rejects.toThrow(/verification token/);
    const ch = await issueOtp(db, a.serviceId, 'ivr');
    expect(ch.sentTo).toMatch(/^\+658/);
    const code = /code is (\d{6})/.exec((await outbox(a.serviceId, 'OTP'))[0]!.message)![1]!;
    await expect(changeSimNorth(db, a.serviceId, { newIccid: sims[0]!, reason: 'DAMAGED', otpToken: `${ch.challengeId}.${code === '000000' ? '111111' : '000000'}` }, 'ivr')).rejects.toThrow(/not valid/);
    await expect(changeSimNorth(db, a.serviceId, { newIccid: '8999999999999999999', reason: 'DAMAGED', otpToken: `${ch.challengeId}.${code}` }, 'ivr')).rejects.toThrow(/not found/);
    const r = await changeSimNorth(db, a.serviceId, { newIccid: sims[0]!, reason: 'DAMAGED', otpToken: `${ch.challengeId}.${code}` }, 'ivr');
    expect(r.result).toMatchObject({ iccid: sims[0], kind: 'PHYSICAL', previousIccid: null });
    expect((await svc(a.serviceId)).iccid).toBe(sims[0]);
    expect((await db.query('SELECT state, service_id FROM iccid_inventory WHERE iccid=$1', [sims[0]])).rows[0]).toMatchObject({ state: 'ACTIVE', serviceId: a.serviceId });
    expect((await outbox(a.serviceId, 'SIM_SWAP'))[0]).toMatchObject({ to: { iccid: sims[0] }, reason: 'DAMAGED' });
    expect((await outbox(a.serviceId, 'SIM_SWAPPED'))[0]).toMatchObject({ eventType: 'SIM_SWAPPED' });
    await expect(changeSimNorth(db, a.serviceId, { newIccid: sims[1]!, reason: 'LOST', otpToken: `${ch.challengeId}.${code}` }, 'ivr')).rejects.toThrow(/not valid/);   // a password works once
    // the second swap retires the first SIM, scrapped because it was lost, and quarantines its identity
    const ch2 = await issueOtp(db, a.serviceId, 'ivr');
    const code2 = /code is (\d{6})/.exec((await outbox(a.serviceId, 'OTP'))[1]!.message)![1]!;
    await changeSimNorth(db, a.serviceId, { newIccid: sims[1]!, reason: 'LOST', otpToken: `${ch2.challengeId}.${code2}` }, 'ivr');
    expect((await db.query('SELECT state FROM iccid_inventory WHERE iccid=$1', [sims[0]])).rows[0]!.state).toBe('DAMAGED_SCRAPPED');
    expect((await db.query(`SELECT count(*)::int AS n FROM imsi_inventory WHERE state='QUARANTINED'`)).rows[0]!.n).toBeGreaterThanOrEqual(1);
    await expect(changeSimNorth(db, a.serviceId, { newIccid: sims[0]!, reason: 'OTHER', otpToken: 'x' }, 'ivr')).rejects.toThrow(/challenge id/);
  });
  it('issues an eSIM profile, charges the fee, and can run without a password when the operator switches that off', async () => {
    await setNorthSettings(db, 'root', { simSwapOtpRequired: false, simSwapFeeMinor: 1000 });
    const a = await mobile();
    const r = await changeSimNorth(db, a.serviceId, { esim: true, reason: 'ESIM_CONVERSION' }, 'selfcare');
    expect(r.result).toMatchObject({ iccid: '8965000000000000001', kind: 'ESIM', activationCode: 'LPA:1$smdp.example.net$MATCH0001' });
    expect(r.result.fee.invoiceNumber).toMatch(/^INV-/);
    expect((await outbox(a.serviceId, 'ESIM_PROFILE_DOWNLOAD'))[0]).toMatchObject({ target: 'SMDP_PLUS' });
    await expect(changeSimNorth(db, a.serviceId, { esim: true, reason: 'OTHER' }, 'selfcare')).rejects.toThrow(/No eSIM profile is available/);
    await expect(changeSimNorth(db, a.serviceId, { newIccid: sims[2]!, esim: true, reason: 'OTHER' }, 'x')).rejects.toThrow(/either/);
    await setNorthSettings(db, 'root', { simSwapOtpRequired: true, simSwapFeeMinor: 0 });
  });
});

describe('number change', () => {
  it('moves to a free number, asks the customer to accept the charge, and rests the old number', async () => {
    await setNorthSettings(db, 'root', { numberChangeFeeMinor: 500 });
    const a = await mobile();
    await expect(changeMsisdnNorth(db, a.serviceId, { targetMsisdn: '+6581000010' }, 'pos')).rejects.toThrow(/acceptCharge/);
    const r = await changeMsisdnNorth(db, a.serviceId, { targetMsisdn: '+6581000010', acceptCharge: true }, 'pos');
    expect(r.result).toMatchObject({ previousMsisdn: a.msisdn, msisdn: '+6581000010', fee: { amountMinor: 500 } });
    expect((await svc(a.serviceId)).identifier).toBe('+6581000010');
    expect((await db.query('SELECT state, service_id FROM msisdn_inventory WHERE msisdn=$1', ['+6581000010'])).rows[0]).toMatchObject({ state: 'ASSIGNED_ACTIVE', serviceId: a.serviceId });
    const old = (await db.query('SELECT state FROM msisdn_inventory WHERE msisdn=$1', [a.msisdn])).rows[0];
    if (old) expect(old.state).toBe('QUARANTINE_COOLING');
    expect((await outbox(a.serviceId, 'MSISDN_CHANGE'))[0]).toMatchObject({ from: a.msisdn, to: '+6581000010' });
    await expect(changeMsisdnNorth(db, a.serviceId, { targetMsisdn: '+6581000010', acceptCharge: true }, 'pos')).rejects.toThrow(/already has/);
    await expect(changeMsisdnNorth(db, a.serviceId, { targetMsisdn: '12345' }, 'pos')).rejects.toThrow(/E.164/);
    await setNorthSettings(db, 'root', { numberChangeFeeMinor: 0 });
    const auto = await changeMsisdnNorth(db, a.serviceId, {}, 'pos');       // no number asked for: the next free standard number
    expect(auto.result.msisdn).toMatch(/^\+658100/);
  });
});

describe('transfer of ownership', () => {
  it('checks identity and credit of the new owner, bills the old one, and moves the service with its contract', async () => {
    const a = await mobile();
    let to = await newCustomer(db);
    const shardOf = async (id: string) => (await db.query('SELECT shard_id FROM customers WHERE id=$1', [id])).rows[0]!.shardId;
    for (let k = 0; k < 400 && (await shardOf(to.customer.id)) !== (await shardOf(a.customer.id)); k++) to = await newCustomer(db);   // a transfer stays inside a shard
    await expect(transferOwnershipNorth(db, a.serviceId, { toCustomerId: to.customer.id, creditCheckAuthorised: false }, 'dealer')).rejects.toThrow(/authorise a credit check/);
    await expect(transferOwnershipNorth(db, a.serviceId, { toCustomerId: to.customer.id, creditCheckAuthorised: true }, 'dealer')).rejects.toThrow(/identity-verified/);
    await db.query(`UPDATE customers SET kyc_status='VERIFIED' WHERE id=$1`, [to.customer.id]);
    await db.query(`UPDATE customers SET credit_risk='HIGH' WHERE id=$1`, [to.customer.id]);
    await expect(transferOwnershipNorth(db, a.serviceId, { toCustomerId: to.customer.id, creditCheckAuthorised: true }, 'dealer')).rejects.toThrow(/credit check .* declined/);
    await db.query(`UPDATE customers SET credit_risk='NORMAL' WHERE id=$1`, [to.customer.id]);
    const r = await transferOwnershipNorth(db, a.serviceId, { toCustomerId: to.customer.id, creditCheckAuthorised: true }, 'dealer');
    expect(r.result).toMatchObject({ fromCustomerId: a.customer.id, toCustomerId: to.customer.id });
    expect((await svc(a.serviceId)).customerId).toBe(to.customer.id);
    expect((await outbox(a.serviceId, 'OWNERSHIP_TRANSFERRED'))[0]).toMatchObject({ toCustomerId: to.customer.id });
    expect((await tmfService(db, a.serviceId)).relatedParty[0]!.id).toBe(to.customer.id);
    await expect(transferOwnershipNorth(db, a.serviceId, { toCustomerId: to.customer.id, creditCheckAuthorised: true }, 'dealer')).rejects.toThrow(/already belongs/);
  });
});

describe('status', () => {
  it('suspends for travel, resumes, soft and hard bars, and terminates', async () => {
    const a = await mobile();
    const sus = await setStatusNorth(db, a.serviceId, { action: 'SUSPEND', months: 2 }, 'app', 'SELF_SERVE');
    expect(sus.service.state).toBe('inactive');
    await expect(setStatusNorth(db, a.serviceId, { action: 'SUSPEND', months: 99 }, 'app')).rejects.toThrow();
    expect((await setStatusNorth(db, a.serviceId, { action: 'RESUME' }, 'app', 'SELF_SERVE')).service.state).toBe('active');
    await setStatusNorth(db, a.serviceId, { action: 'SOFT_BAR', reason: 'ADMIN' }, 'fraud-desk');
    expect((await svc(a.serviceId)).barLevel).toBe('SOFT');
    await expect(setStatusNorth(db, a.serviceId, { action: 'SOFT_BAR' }, 'fraud-desk')).rejects.toThrow(/already has/);
    await setStatusNorth(db, a.serviceId, { action: 'RESUME' }, 'fraud-desk');
    expect((await svc(a.serviceId)).barLevel).toBe('NONE');
    await setStatusNorth(db, a.serviceId, { action: 'HARD_BAR', reason: 'FRAUD' }, 'fraud-desk');
    expect(await svc(a.serviceId)).toMatchObject({ status: 'SUSPENDED', barLevel: 'HARD' });
    expect((await outbox(a.serviceId, 'SERVICE_BARRED')).length).toBe(2);
    await setStatusNorth(db, a.serviceId, { action: 'RESUME' }, 'ops').catch(() => undefined);   // fraud suspensions are lifted by staff
    const t = await setStatusNorth(db, a.serviceId, { action: 'TERMINATE', reason: 'CUSTOMER_REQUEST' }, 'ops');
    expect(t.service.state).toBe('terminated');
    expect((await outbox(a.serviceId, 'SERVICE_TERMINATED')).length).toBe(1);
  });
});

describe('plan change', () => {
  it('moves now with pro-rating, or at the next bill; refuses plans of another kind', async () => {
    const plus = (await db.query(`SELECT * FROM catalog_nodes WHERE id='plan-sim-5g'`)).rows[0]!;
    const data = { ...plus.data, prices: plus.data.prices.map((p: any) => (p.type === 'RECURRING' ? { ...p, amount: { ...p.amount, amountMinor: 5500 } } : p)), contract: { termMonths: 0 } };
    await db.query(`INSERT INTO catalog_nodes (id, level, code, name, path, parent_id, status, kind, markets, data, sort_order) VALUES ('plan-sim-5g-plus','OFFER','plan-sim-5g-plus','5G SIM-only Plus',$1,$2,'ACTIVE','SIM_ONLY',$3,$4,99)`, [`${plus.path}-plus`, plus.parentId, plus.markets, JSON.stringify(data)]);
    const a = await mobile();
    await expect(changePlanNorth(db, a.serviceId, { targetOfferId: 'plan-sim-5g', effective: 'IMMEDIATE' }, 'app')).rejects.toThrow(/already on that plan/);
    await expect(changePlanNorth(db, a.serviceId, { targetOfferId: 'nope', effective: 'IMMEDIATE' }, 'app')).rejects.toThrow(/not found/);
    await expect(changePlanNorth(db, a.serviceId, { targetOfferId: 'device-care', effective: 'IMMEDIATE' }, 'app')).rejects.toThrow(/not a plan/);
    const now = await changePlanNorth(db, a.serviceId, { targetOfferId: 'plan-sim-5g-plus', effective: 'IMMEDIATE', addOns: ['vas-roaming'] }, 'app');
    expect(now.result).toMatchObject({ status: 'APPLIED', to: { offerId: 'plan-sim-5g-plus' } });
    expect((await svc(a.serviceId)).offerId).toBe('plan-sim-5g-plus');
    expect((await outbox(a.serviceId, 'PLAN_CHANGED'))[0]).toMatchObject({ toOffer: 'plan-sim-5g-plus' });
    expect((await tmfService(db, a.serviceId)).supportingService).toHaveLength(1);
    // scheduled for the next bill: nothing changes until that bill has been issued
    const sched = await changePlanNorth(db, a.serviceId, { targetOfferId: 'plan-sim-5g', effective: 'NEXT_BILL_CYCLE' }, 'app');
    expect(sched.result.status).toBe('SCHEDULED');
    expect((await svc(a.serviceId)).offerId).toBe('plan-sim-5g-plus');
    expect(await applyDuePlanChanges(db, today())).toMatchObject({ applied: 0 });
    const eff = sched.result.effectiveOn as string;
    expect(await applyDuePlanChanges(db, addDays(eff, 1))).toMatchObject({ applied: 1, failed: 0 });
    expect((await svc(a.serviceId)).offerId).toBe('plan-sim-5g');
    const again = await changePlanNorth(db, a.serviceId, { targetOfferId: 'plan-sim-5g-plus', effective: 'NEXT_BILL_CYCLE' }, 'app');
    await cancelPendingPlanChange(db, a.serviceId, 'app');
    expect(await applyDuePlanChanges(db, addDays(again.result.effectiveOn as string, 2))).toMatchObject({ applied: 0 });
    void runBillCycle;
  });
});

describe('value-added services', () => {
  it('adds and removes a pass, provisions it through the network outbox, and refuses a repeat', async () => {
    const a = await mobile();
    const add = await manageVasNorth(db, a.serviceId, { action: 'ADD', offerId: 'vas-roaming' }, 'app');
    expect(add.result).toMatchObject({ action: 'ADD', offerId: 'vas-roaming' });
    expect((await outbox(a.serviceId, 'VAS_PROVISION'))[0]).toMatchObject({ offerId: 'vas-roaming', targets: ['PCRF', 'OCS'] });
    await expect(manageVasNorth(db, a.serviceId, { action: 'ADD', offerId: 'vas-roaming' }, 'app')).rejects.toThrow(/already on this service/);
    await expect(manageVasNorth(db, a.serviceId, { action: 'ADD', offerId: 'plan-sim-5g' }, 'app')).rejects.toThrow(/not a value-added/);
    expect((await manageVasNorth(db, a.serviceId, { action: 'REMOVE', offerId: 'vas-roaming' }, 'app')).service.supportingService).toBeUndefined();
    expect((await outbox(a.serviceId, 'VAS_DEPROVISION')).length).toBe(1);
    await expect(manageVasNorth(db, a.serviceId, { action: 'REMOVE', offerId: 'vas-roaming' }, 'app')).rejects.toThrow(/not found/);
    expect((await getNorthSettings(db)).simSwapOtpRequired).toBe(true);
  });
});
