import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { importStock } from './inventory-import.js';
import { listMovements, listStock, receiveStock, writeOffStock } from './inventory.js';
import { createWarehouse, deleteWarehouse, listWarehouses, updateWarehouse } from './warehouses.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

describe('warehouse locations', () => {
  it('starts with the main warehouse, adds, renames, switches off and removes', async () => {
    expect((await listWarehouses(db)).map((w) => w.id)).toContain('WH-MAIN');
    const w = await createWarehouse(db, 'ops', { name: 'Penang DC', address: '1 Bayan Lepas' });
    expect(w.id).toMatch(/^WH-\d{5}$/);
    await expect(createWarehouse(db, 'ops', { name: 'penang dc' })).rejects.toThrow(/already a warehouse/);
    expect((await updateWarehouse(db, 'ops', w.id as string, { name: 'Penang distribution centre' })).name).toBe('Penang distribution centre');

    await receiveStock(db, 'ops', { locationId: w.id as string, sku: 'phone-x1-128', quantity: 12, note: 'PO 77' });
    await expect(deleteWarehouse(db, 'ops', w.id as string)).rejects.toThrow(/still holds 12 units/);
    await updateWarehouse(db, 'ops', w.id as string, { status: 'INACTIVE' });
    await expect(receiveStock(db, 'ops', { locationId: w.id as string, sku: 'PHONE-X1-128', quantity: 1 })).rejects.toThrow(/switched off/);
    await updateWarehouse(db, 'ops', w.id as string, { status: 'ACTIVE' });

    await writeOffStock(db, 'ops', { locationId: w.id as string, sku: 'PHONE-X1-128', quantity: 12, reason: 'DAMAGED' });
    expect((await deleteWarehouse(db, 'ops', w.id as string)).deleted).toBe(w.id);
    expect((await listWarehouses(db)).map((x) => x.id)).not.toContain(w.id);
    expect((await listMovements(db, { locationId: w.id as string })).items).toHaveLength(2); // the history outlives the warehouse

    await expect(deleteWarehouse(db, 'ops', 'WH-MAIN')).rejects.toThrow(/main warehouse/);
    await expect(updateWarehouse(db, 'ops', 'WH-MAIN', { status: 'INACTIVE' })).rejects.toThrow(/main warehouse/);
  });
});

describe('receipts, write-offs and the history', () => {
  it('writes stock off with a reason, never below what is reserved, and keeps the history', async () => {
    await receiveStock(db, 'ops', { locationId: 'WH-MAIN', sku: 'WO-1', quantity: 10 });
    await expect(writeOffStock(db, 'ops', { locationId: 'WH-MAIN', sku: 'WO-1', quantity: 3, reason: 'WHIM' })).rejects.toThrow(/Choose why/);
    await expect(writeOffStock(db, 'ops', { locationId: 'WH-MAIN', sku: 'WO-1', quantity: 3, reason: 'OTHER' })).rejects.toThrow(/what happened/);
    await expect(writeOffStock(db, 'ops', { locationId: 'WH-MAIN', sku: 'WO-1', quantity: 11, reason: 'LOST' })).rejects.toThrow(/Only 10/);
    await expect(writeOffStock(db, 'ops', { locationId: 'WH-MAIN', sku: 'NOPE', quantity: 1, reason: 'LOST' })).rejects.toThrow(/not found|NOT_FOUND|stock record/i);
    await expect(receiveStock(db, 'ops', { locationId: 'NOWHERE', sku: 'WO-1', quantity: 1 })).rejects.toThrow(/Unknown location/);
    await db.query(`UPDATE inventory_stock SET reserved = 4 WHERE location_id='WH-MAIN' AND sku='WO-1'`);
    await expect(writeOffStock(db, 'ops', { locationId: 'WH-MAIN', sku: 'WO-1', quantity: 7, reason: 'EXPIRED' })).rejects.toThrow(/reserved/);
    const r = await writeOffStock(db, 'ops', { locationId: 'WH-MAIN', sku: 'wo-1', quantity: 6, reason: 'THEFT', note: 'police report 123' });
    expect(Number(r?.onHand)).toBe(4);
    const hist = (await listMovements(db, { sku: 'WO-1' })).items;
    expect(hist.map((m) => [m.kind, m.delta, m.onHand])).toEqual([['WRITE_OFF', -6, 4], ['RECEIPT', 10, 10]]);
    expect(hist[0]).toMatchObject({ reason: 'THEFT', note: 'police report 123', actor: 'ops' });
    const stock = (await listStock(db, { locationId: 'WH-MAIN', sku: 'WO-1' })).items[0]!;
    expect([stock.onHand, stock.available]).toEqual([4, 0]);
  });

  it('records CSV loads in the history and refuses unknown or switched-off warehouses', async () => {
    const off = await createWarehouse(db, 'ops', { name: 'Closed depot' });
    await updateWarehouse(db, 'ops', off.id as string, { status: 'INACTIVE' });
    const check = await importStock(db, `location_id,sku,quantity\n${off.id},CSV-1,5\nWH-GHOST,CSV-1,5\nWH-MAIN,CSV-1,5\n`, { apply: false, actor: 'ops' });
    expect(check.rows.map((r) => r.status)).toEqual(['ERROR', 'ERROR', 'WARNING']);
    expect(check.rows[0]!.message).toMatch(/switched off/);
    expect(check.rows[1]!.message).toMatch(/Unknown location/);
    await importStock(db, 'location_id,sku,quantity\nWH-MAIN,CSV-1,5\n', { apply: true, actor: 'ops' });
    expect((await listMovements(db, { sku: 'CSV-1' })).items[0]).toMatchObject({ kind: 'IMPORT', delta: 5, actor: 'ops' });
  });
});
