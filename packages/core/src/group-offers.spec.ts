import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNode, setStatus } from './catalog.js';
import type { Db } from './db.js';
import { createDonorOperator, deleteDonorOperator, listDonorOperators, updateDonorOperator } from './donor-operators.js';
import { getGroup, addGroupMember } from './groups.js';
import { GroupOrderService } from './group-orders.js';
import { importImsis, importMsisdns, importSims } from './nrm-pools.js';
import { getOrder, placeOrder } from './orders.js';
import { cancelPortIn, completePortIn, decidePortIn, expireStalePortIns, getPortIn, listPortIns } from './port-in.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
let OTHERTEL = '';
beforeAll(async () => {
  db = await freshDb();
  OTHERTEL = (await createDonorOperator(db, 'admin', { name: 'OtherTel', routingCode: 'ot-01' })).id as string;
  await importMsisdns(db, { range: { from: '60125000001', to: '60125000060' } }, { apply: true, actor: 'ops' });
  await importImsis(db, { range: { from: '525010000009000', to: '525010000009040' } }, { apply: true, actor: 'ops' });
  const esims = Array.from({ length: 12 }, (_, i) => `8960777${String(1_000_000_000_000 + i).slice(1)},,ESIM`);
  await importSims(db, { csv: `${esims.join('\n')}\n` }, { apply: true, actor: 'ops', locationId: 'WH-MAIN', kind: 'ESIM' });
});
afterAll(async () => { await db.close(); });

const retail = { storeId: 'STORE-SG-001', salespersonId: 'a1' };
const order = (customerId: string, lines: object[], accountId?: string) =>
  placeOrder(db, { customerId, accountId, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: lines as never });
const servicesOf = async (orderId: string) => (await db.query('SELECT * FROM services WHERE order_id=$1 ORDER BY identifier', [orderId])).rows;
const donor = (n: number) => ({ donorOperatorId: OTHERTEL, donorMsisdn: `6012${String(8000000 + n)}`, holderName: 'Aisha Rahman', holderIdType: 'NATIONAL_ID', holderIdNumber: 'S1234567D' });

describe('group plans in the catalog', () => {
  it('keeps the group terms on the offer and refuses nonsense', async () => {
    const seeded = (await db.query(`SELECT data->'group' AS g FROM catalog_nodes WHERE id='plan-family-100'`)).rows[0]!.g;
    expect(seeded).toMatchObject({ isGroupOffer: true, maxGroupMembers: 3, sharedPoolQuotaGb: 100, allowedMemberOfferIds: ['plan-family-member'] });
    const base = { level: 'OFFER', parentId: 'grp-family', kind: 'SIM_ONLY', prices: [{ type: 'RECURRING', amount: { amountMinor: 5000, currency: 'SGD' }, periodMonths: 1, taxInclusive: true }], contract: { termMonths: 0 },
      fulfilment: { requiresShipping: false, requiresInstallation: false, requiresSimActivation: true, inventorySkus: [] }, characteristics: {}, requires: [], excludes: [], markets: [] };
    const mk = (id: string, group: object) => createNode(db, { ...base, id, code: id, name: id, path: '', group } as never);
    await expect(mk('bad-max', { isGroupOffer: true, maxGroupMembers: 0, allowedMemberOfferIds: [] })).rejects.toThrow(/1 to 20/);
    await expect(mk('bad-self', { isGroupOffer: true, maxGroupMembers: 2, allowedMemberOfferIds: ['bad-self'] })).rejects.toThrow(/own member/);
    await expect(mk('bad-nest', { isGroupOffer: true, maxGroupMembers: 2, allowedMemberOfferIds: ['plan-family-100'] })).rejects.toThrow(/group plan/);
    await expect(mk('bad-ghost', { isGroupOffer: true, maxGroupMembers: 2, allowedMemberOfferIds: ['nope'] })).rejects.toThrow(/not an offer/);
    const ok = await mk('family-small', { isGroupOffer: true, maxGroupMembers: 2, allowedMemberOfferIds: ['plan-sim-5g'], sharedPoolQuotaGb: 50 });
    expect((ok as never as { group: { maxGroupMembers: number } }).group.maxGroupMembers).toBe(2);
    await setStatus(db, 'family-small', 'ACTIVE');
  });
});

describe('Vector A: a group is made by the order that sells a group plan', () => {
  it('opens the group with the buyer as family head, takes the members in the same order, and enforces the limit', async () => {
    const c = await newCustomer(db);
    const head = { offerId: 'plan-family-100', simType: 'ESIM' };
    await expect(order(c.customer.id, [{ ...head, members: Array.from({ length: 4 }, () => ({ offerId: 'plan-family-member' })) }])).rejects.toThrow(/up to 3/);
    await expect(order(c.customer.id, [{ ...head, members: [{ offerId: 'plan-sim-5g' }] }])).rejects.toThrow(/not one of the plans/);
    await expect(order(c.customer.id, [{ offerId: 'plan-sim-5g', members: [{ offerId: 'plan-family-member' }] }])).rejects.toThrow(/not a group plan/);

    const o = await order(c.customer.id, [{ ...head, members: [
      { offerId: 'plan-family-member', simType: 'ESIM' },
      { offerId: 'plan-family-member', portIn: { ...donor(1), temporaryNumber: true } },
    ] }]);
    expect(o.state).toBe('COMPLETED');
    const lines = (await db.query('SELECT position, offer_id, group_head_position, port_in FROM order_lines WHERE order_id=$1 ORDER BY position', [o.id])).rows;
    expect(lines.map((l) => [l.offerId, l.groupHeadPosition])).toEqual([['plan-family-100', null], ['plan-family-member', 0], ['plan-family-member', 0]]);
    const svcs = await servicesOf(o.id);
    expect(svcs).toHaveLength(3);
    const g = (await db.query(`SELECT g.id FROM service_groups g JOIN service_group_members m ON m.group_id=g.id JOIN services s ON s.id=m.service_id WHERE s.order_id=$1 LIMIT 1`, [o.id])).rows[0]!;
    const group = await getGroup(db, g.id);
    expect(group).toMatchObject({ origin: 'CHECKOUT', offerId: 'plan-family-100', maxSupplementary: 3, slots: { max: 3, used: 2, remaining: 1 }, accountId: o.accountId });
    expect(group.benefits).toMatchObject({ allowances: { dataGb: 100 } });
    const roles = (group.members as Array<{ role: string; offerId: string }>).map((m) => `${m.role}:${m.offerId}`).sort();
    expect(roles).toEqual(['PRINCIPAL:plan-family-100', 'SUPPLEMENTARY:plan-family-member', 'SUPPLEMENTARY:plan-family-member']);
    // the ported-in line has a temporary number from our pool and a pending request
    const ported = svcs.find((s) => s.portInId)!;
    expect([ported.numberStatus, ported.status]).toEqual(['TEMPORARY', 'ACTIVE']);
    expect(ported.identifier).toMatch(/^\+60125/);
    const req = await getPortIn(db, ported.portInId);
    expect([req.status, req.donorMsisdn, req.temporaryMsisdn]).toEqual(['PENDING', '+6012' + '8000001', ported.identifier]);
    expect((await getOrder(db, o.id)).number).toMatch(/^\d{8}-\d{5}$/);
  });
});

describe('MNP port-in: temporary number, approval and the switch-over', () => {
  it('swaps the temporary number for the ported one without touching the group, and is safe to repeat', async () => {
    const c = await newCustomer(db);
    const o = await order(c.customer.id, [{ offerId: 'plan-family-100', members: [{ offerId: 'plan-family-member', portIn: { ...donor(2), temporaryNumber: true } }] }]);
    const svc = (await servicesOf(o.id)).find((s) => s.portInId)!;
    const temp = svc.identifier as string;
    const before = (await db.query('SELECT group_id, role FROM service_group_members WHERE service_id=$1', [svc.id])).rows[0]!;
    await expect(completePortIn(db, svc.portInId)).rejects.toThrow(/approved by the donor/);

    const ok = await decidePortIn(db, svc.portInId, { approved: true, reference: 'NCH-9001', actor: 'clearinghouse' });
    expect(ok.status).toBe('APPROVED');
    expect((await decidePortIn(db, svc.portInId, { approved: true, actor: 'clearinghouse' })).alreadyDone).toBe(true);
    const done = await completePortIn(db, svc.portInId, 'workflow');
    expect(done.status).toBe('COMPLETED');

    const after = (await db.query('SELECT * FROM services WHERE id=$1', [svc.id])).rows[0]!;
    expect([after.identifier, after.numberStatus, after.status]).toEqual([`+6012${8000002}`, 'PORTED_IN', 'ACTIVE']);
    expect((await db.query('SELECT group_id, role FROM service_group_members WHERE service_id=$1', [svc.id])).rows[0]).toEqual(before); // still in the same group, same role
    expect((await db.query(`SELECT state FROM msisdn_inventory WHERE msisdn=$1`, [temp])).rows[0]!.state).toBe('QUARANTINE_COOLING');
    expect((await db.query(`SELECT state, service_id FROM msisdn_inventory WHERE msisdn=$1`, [after.identifier])).rows[0]).toMatchObject({ state: 'ASSIGNED_ACTIVE', serviceId: svc.id });
    expect((await db.query(`SELECT service_id FROM identifier_registry WHERE identifier=$1`, [after.identifier])).rows[0]!.serviceId).toBe(svc.id);
    expect((await db.query(`SELECT 1 FROM identifier_registry WHERE identifier=$1`, [temp])).rows).toHaveLength(0);
    const swap = (await db.query(`SELECT payload FROM lifecycle_outbox WHERE service_id=$1 AND instruction='MSISDN_SWAP'`, [svc.id])).rows;
    expect(swap).toHaveLength(1);
    expect(swap[0]!.payload).toMatchObject({ from: temp, to: after.identifier });
    expect((await listPortIns(db, { status: 'COMPLETED' })).items.some((r) => r.id === svc.portInId)).toBe(true);
  });

  it('without a temporary number the line waits PENDING, then starts when the number arrives', async () => {
    const c = await newCustomer(db);
    const o = await order(c.customer.id, [{ offerId: 'plan-sim-5g', simType: 'ESIM', portIn: donor(3) }]);
    const svc = (await servicesOf(o.id))[0]!;
    expect([svc.status, svc.identifier, svc.iccid]).toEqual(['PENDING', `+6012${8000003}`, null]);
    expect((await db.query(`SELECT state FROM msisdn_inventory WHERE reserved_by=$1`, [`order:${o.id}`])).rows).toHaveLength(0); // no pool number was taken
    await decidePortIn(db, svc.portInId, { approved: true, actor: 'clearinghouse', complete: true });
    const after = (await db.query('SELECT * FROM services WHERE id=$1', [svc.id])).rows[0]!;
    expect([after.status, after.numberStatus]).toEqual(['ACTIVE', 'PORTED_IN']);
    expect(after.iccid).toBeTruthy();
    expect((await db.query('SELECT state FROM iccid_inventory WHERE iccid=$1', [after.iccid])).rows[0]!.state).toBe('ACTIVE');
    expect((await db.query(`SELECT instruction FROM lifecycle_outbox WHERE service_id=$1 AND kind='NETWORK' ORDER BY id`, [svc.id])).rows.map((r) => r.instruction)).toEqual(['PORT_IN_REQUEST', 'ACTIVATE_PORTED_IN']);
  });

  it('a refused port-in lets the customer keep the temporary number; an unanswered one expires; a number is only ported once', async () => {
    const c = await newCustomer(db);
    const o = await order(c.customer.id, [{ offerId: 'plan-sim-5g', portIn: { ...donor(4), temporaryNumber: true } }]);
    const svc = (await servicesOf(o.id))[0]!;
    await expect(order(c.customer.id, [{ offerId: 'plan-sim-5g', portIn: donor(4) }])).rejects.toThrow(/in progress/);
    const r = await decidePortIn(db, svc.portInId, { approved: false, reason: 'ID did not match', actor: 'clearinghouse' });
    expect([r.status, r.failureReason]).toEqual(['REJECTED', 'ID did not match']);
    const kept = (await db.query('SELECT identifier, number_status, status FROM services WHERE id=$1', [svc.id])).rows[0]!;
    expect([kept.identifier, kept.numberStatus, kept.status]).toEqual([svc.identifier, null, 'ACTIVE']);
    await order(c.customer.id, [{ offerId: 'plan-sim-5g', portIn: donor(4) }]); // the number can be tried again after a refusal

    const o2 = await order(c.customer.id, [{ offerId: 'plan-sim-5g', portIn: { ...donor(5), temporaryNumber: true } }]);
    const s2 = (await servicesOf(o2.id))[0]!;
    await db.query(`UPDATE port_in_requests SET created_at = now() - interval '20 days' WHERE id=$1`, [s2.portInId]);
    expect(await expireStalePortIns(db, 14)).toBeGreaterThanOrEqual(1);
    expect((await getPortIn(db, s2.portInId)).status).toBe('EXPIRED');
    const o3 = await order(c.customer.id, [{ offerId: 'plan-sim-5g', portIn: donor(6) }]);
    const s3 = (await servicesOf(o3.id))[0]!;
    expect((await cancelPortIn(db, s3.portInId, 'customer changed their mind', 'agent')).status).toBe('CANCELLED');
  });

  it('refuses details that are not enough, or a number that is already ours', async () => {
    const c = await newCustomer(db);
    await expect(order(c.customer.id, [{ offerId: 'plan-sim-5g', portIn: { ...donor(7), holderName: '' } }])).rejects.toThrow(/account holder/);
    await expect(order(c.customer.id, [{ offerId: 'plan-sim-5g', portIn: { ...donor(7), donorMsisdn: '0128001234' } }])).rejects.toThrow(/country code/);
    await expect(order(c.customer.id, [{ offerId: 'plan-sim-5g', portIn: { ...donor(7), donorMsisdn: '60125000010' } }])).rejects.toThrow(/already one of our numbers/);
    await expect(order(c.customer.id, [{ offerId: 'plan-sim-5g', portIn: donor(7), msisdn: '+60125000011' }])).rejects.toThrow(/cannot also choose/);
  });
});

describe('Vector B: an existing single line moves to a group plan', () => {
  it('makes the line the family head, opens the remaining slots, and members can be added later by order or by staff', async () => {
    const c = await newCustomer(db);
    const single = await order(c.customer.id, [{ offerId: 'plan-sim-5g' }]);
    const svc = (await servicesOf(single.id))[0]!;
    const svcApi = new GroupOrderService(db);
    await expect(svcApi.upgrade(svc.id, 'plan-sim-5g', 'agent')).rejects.toThrow(/not a group plan/);
    const g = await svcApi.upgrade(svc.id, 'plan-family-100', 'agent');
    expect(g).toMatchObject({ origin: 'PLAN_CHANGE', offerId: 'plan-family-100', slots: { max: 3, used: 0, remaining: 3 } });
    expect((await db.query('SELECT offer_id FROM services WHERE id=$1', [svc.id])).rows[0]!.offerId).toBe('plan-family-100');
    expect((g.members as Array<{ role: string; serviceId: string }>)).toEqual([expect.objectContaining({ role: 'PRINCIPAL', serviceId: svc.id })]);
    await expect(svcApi.upgrade(svc.id, 'family-small', 'agent')).rejects.toThrow(/already in a group/);

    // a member joins by order (self-serve or store), one with a ported-in number
    const add = await order(c.customer.id, [{ offerId: 'plan-family-member', joinGroupId: g.id, portIn: { ...donor(8), temporaryNumber: true } }, { offerId: 'plan-family-member', joinGroupId: g.id }], single.accountId);
    expect(add.state).toBe('COMPLETED');
    expect((await getGroup(db, g.id)).slots).toMatchObject({ used: 2, remaining: 1 });
    // a plan the group does not allow, and a full group
    await expect(order(c.customer.id, [{ offerId: 'plan-sim-5g', joinGroupId: g.id }], single.accountId)).rejects.toThrow(/not one of the plans/);
    await order(c.customer.id, [{ offerId: 'plan-family-member', joinGroupId: g.id }], single.accountId);
    await expect(order(c.customer.id, [{ offerId: 'plan-family-member', joinGroupId: g.id }], single.accountId)).rejects.toThrow(/no free slot/);
    const other = await newCustomer(db);
    await expect(order(other.customer.id, [{ offerId: 'plan-family-member', joinGroupId: g.id }])).rejects.toThrow(/different customer/);
    // staff adding a line by hand obeys the same limit and the same allowed plans
    const extra = (await servicesOf((await order(c.customer.id, [{ offerId: 'plan-family-member' }], single.accountId)).id))[0]!;
    await expect(addGroupMember(db, 'agent', g.id, extra.id)).rejects.toThrow(/slot/);
  });
});

describe('donor operators', () => {
  it('are kept in a list with a routing code, and a port-in must choose one from it', async () => {
    const op = (await listDonorOperators(db)).find((o) => o.id === OTHERTEL)!;
    expect([op.name, op.routingCode, op.status]).toEqual(['OtherTel', 'OT-01', 'ACTIVE']); // codes are kept in capitals
    await expect(createDonorOperator(db, 'admin', { name: 'othertel', routingCode: 'X1' })).rejects.toThrow(/already an operator/);
    await expect(createDonorOperator(db, 'admin', { name: 'Another', routingCode: 'ot-01' })).rejects.toThrow(/belongs to another/);
    await expect(createDonorOperator(db, 'admin', { name: 'Bad', routingCode: 'no spaces' })).rejects.toThrow(/routing code/);

    const c = await newCustomer(db);
    await expect(order(c.customer.id, [{ offerId: 'plan-sim-5g', portIn: { ...donor(20), donorOperatorId: undefined } }])).rejects.toThrow(/Choose the donor operator/);
    await expect(order(c.customer.id, [{ offerId: 'plan-sim-5g', portIn: { ...donor(20), donorOperatorId: '00000000-0000-4000-8000-000000000000' } }])).rejects.toThrow(/not in the list/);
    const o = await order(c.customer.id, [{ offerId: 'plan-sim-5g', portIn: { ...donor(20), temporaryNumber: true } }]);
    const svc = (await servicesOf(o.id))[0]!;
    const req = await getPortIn(db, svc.portInId);
    expect([req.donorOperator, req.donorRoutingCode, req.donorOperatorId]).toEqual(['OtherTel', 'OT-01', OTHERTEL]);
    expect((await db.query(`SELECT payload FROM lifecycle_outbox WHERE service_id=$1 AND instruction='PORT_IN_REQUEST'`, [svc.id])).rows[0]!.payload).toMatchObject({ donorRoutingCode: 'OT-01' });

    // renaming later does not rewrite what a request was raised with; switching off stops new requests
    await updateDonorOperator(db, 'admin', OTHERTEL, { name: 'OtherTel Berhad' });
    expect((await getPortIn(db, svc.portInId)).donorOperator).toBe('OtherTel');
    await updateDonorOperator(db, 'admin', OTHERTEL, { status: 'INACTIVE' });
    expect((await listDonorOperators(db, { activeOnly: true })).some((o) => o.id === OTHERTEL)).toBe(false);
    await expect(order(c.customer.id, [{ offerId: 'plan-sim-5g', portIn: donor(21) }])).rejects.toThrow(/switched off/);
    // one that was used is switched off, not deleted; an unused one is removed
    expect(await deleteDonorOperator(db, 'admin', OTHERTEL)).toEqual({ deleted: false, deactivated: true });
    const spare = await createDonorOperator(db, 'admin', { name: 'Spare Telco', routingCode: 'SP-9' });
    expect(await deleteDonorOperator(db, 'admin', spare.id as string)).toEqual({ deleted: true, deactivated: false });
    await updateDonorOperator(db, 'admin', OTHERTEL, { status: 'ACTIVE' });
  });
});
