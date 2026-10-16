import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCase } from './cases.js';
import type { Db } from './db.js';
import { advanceOrder, cancelOrder, getOrder, placeOrder } from './orders.js';
import { freshDb, newCustomer } from './test-helpers.js';
import { parseWfmEvent, processWfmEvent } from './wfm-webhook.js';
import { findOrderSlots, listAppointments, orderBookingAvailable, orderVisitsFor, rescheduleAppointment, setWfmSettings } from './workforce.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const ADDRESS = '12 Fibre Lane, Singapore 238801';
const wfm = (o: { bookAtOrder?: boolean; mode?: string } = {}) => setWfmSettings(db, 'root', { vendor: 'simulator', enabled: true, bookAtOrder: o.bookAtOrder ?? true, config: { mode: o.mode ?? 'OK', capacity: 5 } });
let n = 0;
const send = (jobRef: string, type: string) => { const e = { eventId: `ov-${++n}`, jobRef, type, occurredAt: new Date().toISOString() }; return processWfmEvent(db, parseWfmEvent(JSON.stringify(e)), e); };
const order = async (slot: { id: string; start: string; end: string }, customerId?: string) => {
  const id = customerId ?? (await newCustomer(db)).customer.id;
  return placeOrder(db, { customerId: id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, deliveryAddress: ADDRESS, lines: [{ offerId: 'fiber-1g' }], installationSlotRef: slot });
};
const caseOf = async (orderId: string) => (await db.query(`SELECT * FROM cases WHERE order_id=$1`, [orderId])).rows[0]!;

describe('installation times taken with the order', () => {
  it('are only offered when the setting is on', async () => {
    await wfm({ bookAtOrder: false });
    expect(await orderBookingAvailable(db)).toBe(false);
    await expect(findOrderSlots(db, { address: ADDRESS })).rejects.toThrow(/not switched on/);
    await expect(order({ id: 'x', start: new Date(Date.now() + 86_400_000).toISOString(), end: new Date(Date.now() + 90_000_000).toISOString() })).rejects.toThrow(/not switched on/);
    await wfm();
    expect(await orderBookingAvailable(db)).toBe(true);
    await expect(findOrderSlots(db, { address: '' })).rejects.toThrow(/address/);
  });

  it('are held for the order, booked when it is paid, and block a manual date', async () => {
    await wfm();
    const { slots } = await findOrderSlots(db, { address: ADDRESS });
    expect(slots.length).toBeGreaterThan(0);
    const o = await order(slots[0]!);
    const c = await caseOf(o.id);
    expect(c.subject).toContain(o.number);
    const [a] = await listAppointments(db, c.id);
    expect(['SCHEDULED', 'REQUESTED']).toContain(a!.status);
    expect(a!.address.postcode).toBe('238801');                                   // the visit goes to the address on the order
    const fresh = await getOrder(db, o.id);
    expect(new Date(fresh.fulfilment.slot).toISOString()).toBe(new Date(slots[0]!.start).toISOString());
    expect((await db.query(`SELECT status FROM installation_appointments WHERE order_id=$1`, [o.id])).rows.map((r) => r.status)).toEqual(['BOOKED']);
    await expect(advanceOrder(db, o.id, { type: 'schedule_installation', slot: slots[1]!.start })).rejects.toThrow(/field-service system/);
  });

  it('are moved from the installation case, and the order follows', async () => {
    await wfm();
    const { slots } = await findOrderSlots(db, { address: ADDRESS });
    const k = (await newCustomer(db)).customer;
    const o = await order(slots[0]!, k.id);
    const c = await caseOf(o.id);
    const [a] = await listAppointments(db, c.id);
    await rescheduleAppointment(db, a!.id, { slot: slots[3]! }, 'agent1');
    const fresh = await getOrder(db, o.id);
    expect(new Date(fresh.fulfilment.slot).toISOString()).toBe(new Date(slots[3]!.start).toISOString());
    expect((await db.query(`SELECT status FROM installation_appointments WHERE order_id=$1 AND status='BOOKED'`, [o.id])).rows).toHaveLength(1);
    // an agent working any other case of this customer can see and move the visit too
    const other = (await db.query(`INSERT INTO cases (number, customer_id, type, priority, subject, severity, tier, sla_first_response_minutes, sla_resolution_minutes, sla_warn_percent, first_response_due, resolution_due)
      VALUES ('CS-OTHER1',$1,'GENERAL','LOW','Asks about install','MINOR_INQUIRY','STANDARD',60,60,80,now(),now()) RETURNING id`, [k.id])).rows[0]!;
    const visits = await orderVisitsFor(db, other.id);
    expect(visits).toHaveLength(1);
    expect(visits[0]!.orderNumber).toBe(o.number);
  });

  it('follow the technician: on the way ends cancellation, finished completes the installation', async () => {
    await wfm();
    const { slots } = await findOrderSlots(db, { address: ADDRESS });
    const o = await order(slots[0]!);
    const [a] = await listAppointments(db, (await caseOf(o.id)).id);
    await send(a!.externalRef, 'EN_ROUTE');
    await expect(cancelOrder(db, o.id, 'x')).rejects.toThrow(/point of no return/);
    await send(a!.externalRef, 'JOB_COMPLETED');
    expect((await getOrder(db, o.id)).state).toBe('COMPLETED');
    expect((await getCase(db, (await caseOf(o.id)).id)).status).toBe('RESOLVED');
  });

  it('are released when the installation is cancelled', async () => {
    await wfm();
    const { slots } = await findOrderSlots(db, { address: ADDRESS });
    const o = await order(slots[0]!);
    const c = await caseOf(o.id);
    await cancelOrder(db, o.id, 'changed my mind');
    expect((await listAppointments(db, c.id))[0]!.status).toBe('CANCELLED');
    expect((await getCase(db, c.id)).status).toBe('RESOLVED');
  });

  it('are released when the order fails after the window was held', async () => {
    await wfm();
    const { slots } = await findOrderSlots(db, { address: ADDRESS });
    await db.query(`UPDATE inventory_stock SET on_hand = 0, reserved = 0 WHERE sku='ONT-ROUTER'`);   // no equipment: the order fails after paying
    const o = await order(slots[0]!);
    expect(o.state).toBe('FAILED');
    const c = await caseOf(o.id);
    expect((await listAppointments(db, c.id))[0]!.status).toBe('CANCELLED');
    expect((await getCase(db, c.id)).status).toBe('RESOLVED');
  });

  it('refuse the order when the field-service system will not hold the window', async () => {
    await wfm();
    const { slots } = await findOrderSlots(db, { address: ADDRESS });
    await wfm({ mode: 'FAIL' });
    await expect(order(slots[0]!)).rejects.toThrow(/could not be held/);
    expect((await db.query(`SELECT count(*)::int AS n FROM cases WHERE order_id IS NOT NULL AND subject LIKE '%FAIL%'`)).rows[0]!.n).toBe(0);
  });
});
