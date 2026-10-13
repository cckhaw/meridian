import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { importStock, parseCsv, stockTemplate } from './inventory-import.js';
import { stockAt } from './inventory.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
const csv = (...lines: string[]) => ['location_id,sku,quantity,action', ...lines].join('\r\n');
const check = (text: string, o: { storeId?: string | null } = {}) => importStock(db, text, { apply: false, actor: 'admin', ...o });
const load = (text: string, o: { storeId?: string | null } = {}) => importStock(db, text, { apply: true, actor: 'admin', ...o });

describe('reading the file', () => {
  it('handles quotes, commas and line breaks inside cells, CRLF and a byte-order mark', () => {
    const rows = parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n"two\nlines",z\r\n');
    expect(rows.map((r) => r.cells)).toEqual([['a', 'b'], ['x,1', 'he said "hi"'], ['two\nlines', 'z']]);
    expect(rows.map((r) => r.line)).toEqual([1, 2, 3]);
    expect(() => parseCsv('a,"b')).toThrow(/never closed/);
  });
});

describe('the template', () => {
  it('is a header plus instructions, and can list every SKU the catalog uses', async () => {
    const blank = await stockTemplate(db);
    expect(blank).toContain('location_id,sku,quantity,action');
    const full = await stockTemplate(db, { withSkus: true, locationId: 'WH-MAIN' });
    expect(full).toContain('WH-MAIN,PHONE-X1-128,,RECEIVE');
    // filled in, the template loads: rows without a quantity are skipped, comment lines ignored
    const r = await check(full.replace('WH-MAIN,PHONE-X1-128,,RECEIVE', 'WH-MAIN,PHONE-X1-128,5,RECEIVE'));
    expect(r.summary.errors).toBe(0);
    expect(r.summary.ok).toBe(1);
    expect(r.summary.skipped).toBeGreaterThan(5);
  });
});

describe('checking a file', () => {
  it('shows what would change and changes nothing', async () => {
    const before = await stockAt(db, 'WH-MAIN', 'PHONE-X1-128');
    const r = await check(csv('WH-MAIN,PHONE-X1-128,25,RECEIVE', 'WH-MAIN,TOASTER-T1,2,remove'));
    expect(r.canApply).toBe(true);
    expect(r.rows[0]).toMatchObject({ status: 'OK', before: before.onHand, after: before.onHand + 25 });
    expect(r.rows[1]).toMatchObject({ action: 'REMOVE', after: r.rows[1]!.before! - 2 });
    expect((await stockAt(db, 'WH-MAIN', 'PHONE-X1-128')).onHand).toBe(before.onHand);
  });

  it('names every problem with its line, and refuses to load a file that has any', async () => {
    const text = csv('WH-MAIN,PHONE-X1-128,10', 'NOPE,SKU-1,5', 'WH-MAIN,bad sku,5', 'WH-MAIN,SKU-2,abc', 'WH-MAIN,SKU-3,0,RECEIVE', 'WH-MAIN,SKU-4,3,JUGGLE', 'WH-MAIN,PHONE-X1-128,1');
    const r = await check(text);
    const msgs = r.rows.map((x) => x.message ?? '');
    expect(r.rows.map((x) => x.status)).toEqual(['OK', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR']);
    expect(msgs[1]).toMatch(/Unknown location/);
    expect(msgs[2]).toMatch(/not a valid SKU/);
    expect(msgs[3]).toMatch(/not a whole number/);
    expect(msgs[4]).toMatch(/at least 1/);
    expect(msgs[5]).toMatch(/Unknown action/);
    expect(msgs[6]).toMatch(/already on line 2/);
    expect(r.rows[6]!.line).toBe(8); // the file's own line numbers, counting the header
    expect(r.canApply).toBe(false);
    const before = (await stockAt(db, 'WH-MAIN', 'PHONE-X1-128')).onHand;
    await expect(load(text)).rejects.toThrow(/nothing was loaded/);
    expect((await stockAt(db, 'WH-MAIN', 'PHONE-X1-128')).onHand).toBe(before); // even the good row stayed out
  });

  it('asks for the right columns, and warns about a SKU no offer uses', async () => {
    await expect(check('sku,qty\r\nA,1')).rejects.toThrow(/Missing: location_id/);
    await expect(check('')).rejects.toThrow(/empty/);
    const r = await check(csv('WH-MAIN,UNUSED-SKU-9,4'));
    expect(r.rows[0]).toMatchObject({ status: 'WARNING' });
    expect(r.canApply).toBe(true);
  });

  it('accepts part numbers with a slash as SKUs', async () => {
    const r = await check(csv('WH-MAIN,MJW44LL/A,5,RECEIVE'));
    expect(r.rows[0]).toMatchObject({ status: 'WARNING' }); // valid; no offer uses it yet
    expect(r.rows[0]!.message).toMatch(/No offer uses/);
  });

  it('lets the headers vary (Location, Qty) and defaults the action to RECEIVE', async () => {
    const r = await check('Location,SKU,Qty\r\nWH-MAIN,PHONE-X1-128,3');
    expect(r.rows[0]).toMatchObject({ action: 'RECEIVE', quantity: 3, status: 'OK' });
  });
});

describe('loading a file', () => {
  it('receives, writes off and counts in one go, and records it', async () => {
    const a = await stockAt(db, 'WH-MAIN', 'PHONE-X1-128');
    const out = await load(csv('WH-MAIN,PHONE-X1-128,40,RECEIVE', 'WH-MAIN,TOASTER-T1,1,REMOVE', 'WH-MAIN,NEW-SKU-1,12,SET', 'STORE-SG-001,PHONE-X1-128,6'));
    expect(out.applied).toBe(true);
    expect((await stockAt(db, 'WH-MAIN', 'PHONE-X1-128')).onHand).toBe(a.onHand + 40);
    expect((await stockAt(db, 'WH-MAIN', 'NEW-SKU-1')).onHand).toBe(12);
    expect((await stockAt(db, 'STORE-SG-001', 'PHONE-X1-128')).onHand).toBeGreaterThanOrEqual(6);
    expect((await db.query(`SELECT detail FROM audit_log WHERE action='STOCK_IMPORTED' ORDER BY id DESC LIMIT 1`)).rows[0]!.detail).toMatchObject({ rows: 4 });
  });

  it('never takes reserved stock away', async () => {
    await db.query(`UPDATE inventory_stock SET reserved = 5 WHERE location_id='WH-MAIN' AND sku='NEW-SKU-1'`);
    const r = await check(csv('WH-MAIN,NEW-SKU-1,10,REMOVE', 'WH-MAIN,NEW-SKU-1,3,SET'));
    expect(r.rows[0]!.message).toMatch(/5 units are reserved/);
    const ok = await load(csv('WH-MAIN,NEW-SKU-1,5,SET'));
    expect(ok.applied).toBe(true);
    expect((await stockAt(db, 'WH-MAIN', 'NEW-SKU-1')).onHand).toBe(5);
  });

  it('stops the same file being loaded twice, because receiving twice would count the delivery twice (a stock count is safe to repeat)', async () => {
    const text = csv('WH-MAIN,REPEAT-SKU-1,10,RECEIVE');
    expect((await check(text)).repeat).toBeNull();
    await load(text);
    const again = await check(`# a note\r\n${text}\r\n\r\n`); // comments and blank lines do not make it a different file
    expect(again.repeat).toMatchObject({ by: 'admin' });
    await expect(load(text)).rejects.toThrow(/already loaded/);
    expect((await stockAt(db, 'WH-MAIN', 'REPEAT-SKU-1')).onHand).toBe(10);
    await importStock(db, text, { apply: true, actor: 'admin', confirmRepeat: true });
    expect((await stockAt(db, 'WH-MAIN', 'REPEAT-SKU-1')).onHand).toBe(20); // only when someone says it is a new delivery
    const count = csv('WH-MAIN,REPEAT-SKU-1,7,SET');
    await load(count);
    expect((await check(count)).repeat).toBeNull();
    await load(count);
    expect((await stockAt(db, 'WH-MAIN', 'REPEAT-SKU-1')).onHand).toBe(7);
  });

  it('keeps a store user to their own store', async () => {
    const r = await check(csv('WH-MAIN,PHONE-X1-128,1', 'STORE-SG-001,PHONE-X1-128,1'), { storeId: 'STORE-SG-001' });
    expect(r.rows[0]).toMatchObject({ status: 'ERROR' });
    expect(r.rows[0]!.message).toMatch(/your own store/);
    expect(r.rows[1]).toMatchObject({ status: 'OK' });
  });

  it('refuses files with too many rows', async () => {
    await expect(check(csv(...Array.from({ length: 5001 }, (_, i) => `WH-MAIN,SKU-${i},1`)))).rejects.toThrow(/at most 5000/);
  });
});
