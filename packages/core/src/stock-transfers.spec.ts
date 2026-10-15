import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { adjustStock, listMovements, stockAt } from './inventory.js';
import { allocateSimTx, importImsis, importSims, listSims } from './nrm-pools.js';
import { cancelTransfer, dispatchTransfer, getTransfer, listTransfers, receiveTransfer, requestTransfer } from './stock-transfers.js';
import { freshDb } from './test-helpers.js';

let db: Db;
const ic = (n: number) => `8960${String(1_000_000_000_000_000 + n * 7).slice(1)}`;
beforeAll(async () => {
  db = await freshDb();
  await importImsis(db, { csv: Array.from({ length: 30 }, (_, i) => `52501${String(2_000_000_000 + i * 13)}`).join('\n') }, { apply: true, actor: 'ops' });
  await importSims(db, { csv: `iccid\n${Array.from({ length: 10 }, (_, i) => ic(i + 1)).join('\n')}\n` }, { apply: true, actor: 'ops', locationId: 'WH-MAIN' });
  await importSims(db, { csv: `iccid\n${Array.from({ length: 4 }, (_, i) => ic(i + 50)).join('\n')}\n` }, { apply: true, actor: 'ops', locationId: 'STORE-SG-001' });
  await db.tx(async (q) => { await adjustStock(q, 'WH-MAIN', 'WATCH-L1', 20); });
});
afterAll(async () => { await db.close(); });
const on = async (loc: string, sku: string) => (await db.query('SELECT on_hand, reserved FROM inventory_stock WHERE location_id=$1 AND sku=$2', [loc, sku])).rows[0];

describe('stock transfers', () => {
  it('moves goods in three steps: nothing moves on request, the stock leaves on dispatch and arrives on receipt', async () => {
    const before = Number((await on('WH-MAIN', 'WATCH-L1'))!.onHand), storeBefore = Number((await on('STORE-SG-002', 'WATCH-L1'))?.onHand ?? 0);
    await expect(requestTransfer(db, 'ops', { from: 'WH-MAIN', to: 'WH-MAIN', lines: [{ sku: 'WATCH-L1', quantity: 1 }] })).rejects.toThrow(/same place/);
    await expect(requestTransfer(db, 'ops', { from: 'WH-MAIN', to: 'NOWHERE', lines: [{ sku: 'WATCH-L1', quantity: 1 }] })).rejects.toThrow(/Unknown location/);
    await expect(requestTransfer(db, 'ops', { from: 'WH-MAIN', to: 'STORE-SG-002', lines: [{ sku: 'WATCH-L1', quantity: 9999 }] })).rejects.toThrow(/free to move/);
    await expect(requestTransfer(db, 'ops', { from: 'WH-MAIN', to: 'STORE-SG-002' })).rejects.toThrow(/at least one product/);
    const t = await requestTransfer(db, 'ops', { from: 'WH-MAIN', to: 'STORE-SG-002', lines: [{ sku: 'watch-l1', quantity: 8 }], note: 'Launch stock' });
    expect(t).toMatchObject({ status: 'REQUESTED', number: expect.stringMatching(/^TRF-\d{8}-\d{4}$/) });
    expect(Number((await on('WH-MAIN', 'WATCH-L1'))!.onHand)).toBe(before);                            // asking moves nothing
    await expect(receiveTransfer(db, 'ops', t.id)).rejects.toThrow(/only a transfer on the road/);
    await dispatchTransfer(db, 'ops', t.id);
    expect(Number((await on('WH-MAIN', 'WATCH-L1'))!.onHand)).toBe(before - 8);                        // gone from the sender,
    expect(Number((await on('STORE-SG-002', 'WATCH-L1'))?.onHand ?? 0)).toBe(storeBefore);             // not yet at the receiver
    await expect(dispatchTransfer(db, 'ops', t.id)).rejects.toThrow(/only a requested transfer/);
    const done = await receiveTransfer(db, 'ops', t.id, { received: { 'WATCH-L1': 6 } });                // two went missing
    expect(done).toMatchObject({ status: 'RECEIVED', discrepancy: true });
    expect(Number((await on('STORE-SG-002', 'WATCH-L1'))!.onHand)).toBe(storeBefore + 6);
    const moves = (await listMovements(db, { sku: 'WATCH-L1' })).items.map((m) => [m.locationId, m.kind, m.delta]);
    expect(moves).toEqual(expect.arrayContaining([['WH-MAIN', 'TRANSFER_OUT', -8], ['STORE-SG-002', 'TRANSFER_IN', 6], ['STORE-SG-002', 'TRANSFER_SHORT', 0]]));
    expect((await getTransfer(db, t.number)).lines[0]).toMatchObject({ quantity: 8, received: 6 });
  });

  it('will not move stock reserved for orders, and sends a transfer on the road back with the stock', async () => {
    await db.query(`UPDATE inventory_stock SET reserved = on_hand - 2 WHERE location_id='WH-MAIN' AND sku='WATCH-L1'`);
    await expect(requestTransfer(db, 'ops', { from: 'WH-MAIN', to: 'STORE-SG-001', lines: [{ sku: 'WATCH-L1', quantity: 3 }] })).rejects.toThrow(/reserved for orders/);
    await db.query(`UPDATE inventory_stock SET reserved = 0 WHERE location_id='WH-MAIN' AND sku='WATCH-L1'`);
    const before = Number((await on('WH-MAIN', 'WATCH-L1'))!.onHand);
    const t = await requestTransfer(db, 'ops', { from: 'WH-MAIN', to: 'STORE-SG-001', lines: [{ sku: 'WATCH-L1', quantity: 4 }] });
    expect((await cancelTransfer(db, 'ops', t.id)).status).toBe('CANCELLED');
    const t2 = await requestTransfer(db, 'ops', { from: 'WH-MAIN', to: 'STORE-SG-001', lines: [{ sku: 'WATCH-L1', quantity: 4 }] });
    await dispatchTransfer(db, 'ops', t2.id);
    expect(Number((await on('WH-MAIN', 'WATCH-L1'))!.onHand)).toBe(before - 4);
    expect((await cancelTransfer(db, 'ops', t2.id)).status).toBe('RETURNED');
    expect(Number((await on('WH-MAIN', 'WATCH-L1'))!.onHand)).toBe(before);                             // back where it was
    await expect(cancelTransfer(db, 'ops', t2.id)).rejects.toThrow(/no longer be cancelled/);
  });

  it('keeps a store user to their own store’s side of a transfer', async () => {
    const mine = { storeId: 'STORE-SG-001' };
    await expect(requestTransfer(db, 'clerk', { from: 'WH-MAIN', to: 'STORE-SG-002', lines: [{ sku: 'WATCH-L1', quantity: 1 }] }, mine)).rejects.toThrow(/does not involve your store/);
    const t = await requestTransfer(db, 'clerk', { from: 'STORE-SG-001', to: 'STORE-SG-002', lines: [{ sku: 'WATCH-L1', quantity: 2 }] }, mine);     // a store to a store
    await expect(dispatchTransfer(db, 'other-clerk', t.id, { storeId: 'STORE-SG-002' })).rejects.toThrow(/Only the sending location/);   // the receiver cannot dispatch
    await dispatchTransfer(db, 'clerk', t.id, mine);
    await expect(receiveTransfer(db, 'clerk', t.id, {}, mine)).rejects.toThrow(/Only the receiving location/);       // the sender cannot receive its own shipment
    await receiveTransfer(db, 'other-clerk', t.id, {}, { storeId: 'STORE-SG-002' });
    expect((await getTransfer(db, t.id)).status).toBe('RECEIVED');
    expect((await listTransfers(db, { location: 'STORE-SG-002' })).items.length).toBeGreaterThanOrEqual(2);
  });
});

describe('SIM cards in transfers', () => {
  it('moves cards from the warehouse to a store, holds them on the road, loses the ones that do not arrive, and moves store to store', async () => {
    const t = await requestTransfer(db, 'ops', { from: 'WH-MAIN', to: 'STORE-SG-002', sims: { count: 3 } });
    expect(t.simCount).toBe(3);
    const cards = t.sims.map((s: any) => s.iccid as string);
    // requested cards are held: they cannot be sold or picked meanwhile
    expect((await listSims(db, { state: 'AVAILABLE', locationId: 'WH-MAIN', limit: 50 })).items.map((s) => s.iccid)).not.toContain(cards[0]);
    await expect(db.tx((q) => allocateSimTx(q, { iccid: cards[0] }, { orderId: '00000000-0000-4000-8000-000000000001', actor: 'x' }))).rejects.toThrow(/stock transfer/);
    await dispatchTransfer(db, 'ops', t.id);
    expect((await db.query('SELECT location_id FROM iccid_inventory WHERE iccid=$1', [cards[0]])).rows[0]!.locationId).toBeNull();     // at no place
    await receiveTransfer(db, 'rcv', t.id, { iccids: [cards[0]!, cards[1]!] });                                                          // the third never arrived
    expect((await db.query('SELECT location_id, state FROM iccid_inventory WHERE iccid=$1', [cards[0]])).rows[0]).toMatchObject({ locationId: 'STORE-SG-002', state: 'DISTRIBUTED_DEALER' });
    expect((await db.query('SELECT state FROM iccid_inventory WHERE iccid=$1', [cards[2]])).rows[0]!.state).toBe('DAMAGED_SCRAPPED');
    expect((await getTransfer(db, t.id)).discrepancy).toBe(true);
    // a store to a store, naming the card
    const t2 = await requestTransfer(db, 'ops', { from: 'STORE-SG-002', to: 'STORE-SG-001', sims: { iccids: [cards[0]!] } });
    await dispatchTransfer(db, 'ops', t2.id); await receiveTransfer(db, 'ops', t2.id);
    expect((await db.query('SELECT location_id FROM iccid_inventory WHERE iccid=$1', [cards[0]])).rows[0]!.locationId).toBe('STORE-SG-001');
    await expect(requestTransfer(db, 'ops', { from: 'WH-MAIN', to: 'STORE-SG-001', sims: { iccids: [cards[0]!] } })).rejects.toThrow(/not at WH-MAIN/);
    await expect(requestTransfer(db, 'ops', { from: 'WH-MAIN', to: 'STORE-SG-001', sims: { count: 500 } })).rejects.toThrow(/only \d+ free SIM cards/);
  });
});

describe('where an order takes its SIM from', () => {
  it('uses the selling store’s cards for a store sale, the warehouse for a remote sale, and refuses a store’s card for a remote sale', async () => {
    const o = (n: number) => `00000000-0000-4000-8000-00000000010${n}`;
    const store = await db.tx((q) => allocateSimTx(q, { simType: 'PHYSICAL' }, { orderId: o(1), storeId: 'STORE-SG-001', actor: 'x' }));
    expect((await db.query('SELECT location_id FROM iccid_inventory WHERE iccid=$1', [store.iccid])).rows[0]!.locationId).toBe('STORE-SG-001');
    const remote = await db.tx((q) => allocateSimTx(q, { simType: 'PHYSICAL' }, { orderId: o(2), actor: 'x' }));
    expect((await db.query('SELECT location_id FROM iccid_inventory WHERE iccid=$1', [remote.iccid])).rows[0]!.locationId).toMatch(/^WH-/);
    const shelf = (await db.query(`SELECT iccid FROM iccid_inventory WHERE location_id='STORE-SG-001' AND state='DISTRIBUTED_DEALER' AND transfer_id IS NULL LIMIT 1`)).rows[0]!.iccid as string;
    await expect(db.tx((q) => allocateSimTx(q, { iccid: shelf }, { orderId: o(3), actor: 'x' }))).rejects.toThrow(/Remote sales use warehouse stock/);
    await expect(db.tx((q) => allocateSimTx(q, { iccid: shelf }, { orderId: o(4), storeId: 'STORE-SG-002', actor: 'x' }))).rejects.toThrow(/not at your store/);
    expect((await listSims(db, { state: 'AVAILABLE', warehousesOnly: true, limit: 200 })).items.every((s) => String(s.locationId).startsWith('WH-'))).toBe(true);
    void stockAt;
  });
});
