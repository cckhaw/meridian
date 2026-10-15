import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentsFile, dealersFile, importAgents, importDealers, importStores, storesFile } from './bulk-import.js';
import { parseCsv } from './csv.js';
import type { Db } from './db.js';
import { createDealer } from './dealers.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const H = 'dealer_id,name,contact_name,email,phone,status,tier,parent_dealer_id,bank_account_name,bank_account_no,bank_code,sap_vendor_no';
const dealer = (id: string) => db.query('SELECT * FROM dealers WHERE id=$1', [id]).then((r) => r.rows[0]);
const nextDealerSeq = async () => Number((await db.query(`SELECT last_value FROM dealer_id_seq`)).rows[0]!.lastValue);
const data = (csv: string) => parseCsv(csv).filter((r) => !(r.cells[0] ?? '').startsWith('#'));

describe('dealers in bulk', () => {
  it('gives a template with a header and examples that are only comments, and an export that reads back', async () => {
    const t = await dealersFile(db, { channel: true });
    expect(t).toContain(H);
    expect(data(t)).toHaveLength(1); // the header only: the example line is a comment, so loading the template as it is adds nothing
    await expect(importDealers(db, t, { apply: true, actor: 'ops', channel: true })).rejects.toThrow(/header but no rows/);
  });

  it('checks without changing anything or using up an id, then loads all together', async () => {
    const before = await nextDealerSeq();
    const file = `${H}\n,Metro Distribution,Alex Lim,alex@metro.example,+6591234567,,MASTER_DISTRIBUTOR,,Metro Pte Ltd,0011223344,DBS,V10001\n,Orchard Mobile,,,,INACTIVE,sub dealer,,,,,\n`;
    const check = await importDealers(db, file, { apply: false, actor: 'ops', channel: true });
    expect(check).toMatchObject({ applied: false, canApply: true, summary: { created: 2, updated: 0, errors: 0 } });
    expect((await db.query('SELECT count(*) AS n FROM dealers')).rows[0]!.n).toBe(0);
    expect(await nextDealerSeq()).toBe(before); // a check does not burn ids

    const done = await importDealers(db, file, { apply: true, actor: 'ops', channel: true });
    expect(done.applied).toBe(true);
    expect(done.rows.map((r) => r.id)).toEqual(['DLR-00001', 'DLR-00002']); // issued by the system, in order, with no gaps
    expect(await dealer('DLR-00001')).toMatchObject({ name: 'Metro Distribution', tier: 'MASTER_DISTRIBUTOR', bankAccountNo: '0011223344', sapVendorNo: 'V10001', email: 'alex@metro.example' });
    expect(await dealer('DLR-00002')).toMatchObject({ status: 'INACTIVE', tier: 'SUB_DEALER' });
    expect((await db.query(`SELECT action FROM audit_log WHERE entity='dealer' AND entity_id='import'`)).rows).toHaveLength(1);
  });

  it('updates by id: blank leaves a field, a dash clears it; the parent goes in after its dealer exists', async () => {
    const file = `${H}\nDLR-00001,,Sam Tan,-,,,,,,,,\nDLR-00002,,,,,ACTIVE,,DLR-00001,,,,\n`;
    const r = await importDealers(db, file, { apply: true, actor: 'ops', channel: true });
    expect(r.summary).toMatchObject({ created: 0, updated: 2 });
    expect(await dealer('DLR-00001')).toMatchObject({ name: 'Metro Distribution', contactName: 'Sam Tan', email: null, phone: '+6591234567' });
    expect(await dealer('DLR-00002')).toMatchObject({ status: 'ACTIVE', parentDealerId: 'DLR-00001', name: 'Orchard Mobile' });
  });

  it('exports what is there and the export loads straight back; bank details only for those who may see them', async () => {
    const full = await dealersFile(db, { withData: true, channel: true, actor: 'ops' });
    const rows = data(full);
    expect(rows).toHaveLength(3);
    expect(rows[1]!.cells.slice(0, 2)).toEqual(['DLR-00001', 'Metro Distribution']);
    expect(rows[1]!.cells[9]).toBe('0011223344');
    expect(await importDealers(db, full, { apply: false, actor: 'ops', channel: true })).toMatchObject({ canApply: true, summary: { created: 0, updated: 2, errors: 0 } });
    const limited = data(await dealersFile(db, { withData: true, channel: false }));
    expect(limited[1]!.cells.slice(8)).toEqual(['', '', '', '']);
    expect((await db.query(`SELECT detail FROM audit_log WHERE entity='dealer' AND entity_id='export'`)).rows[0]!.detail).toMatchObject({ rows: 2, bankDetails: true });
  });

  it('explains every problem by line, and loads nothing while any row is wrong', async () => {
    const file = `${H}\nDLR-99999,Ghost,,,,,,,,,,\n,,Only Contact,,,,,,,,,\n,Bad Mail,,not-an-email,,,,,,,,\n,Odd Tier,,,,,FRANCHISEE,,,,,\n,Loop,,,,,,DLR-00404,,,,\nDLR-00001,,,,,,,DLR-00002,,,,\nDLR-00001,,,,,,,,,,,\n,Good One,,,,,,,,,,\n`;
    const r = await importDealers(db, file, { apply: false, actor: 'ops', channel: true });
    const msg = (i: number) => r.rows[i]!.message ?? '';
    expect(r.canApply).toBe(false);
    expect(msg(0)).toMatch(/does not exist.*leave dealer_id empty/);
    expect(r.rows[1]).toMatchObject({ status: 'ERROR', message: expect.stringMatching(/needs a name/) });
    expect(msg(2)).toMatch(/not an email/);
    expect(msg(3)).toMatch(/tier is one of/);
    expect(msg(4)).toMatch(/Parent DLR-00404/);
    expect(msg(5)).toMatch(/under one of its own sub-dealers/); // DLR-00002 is already below DLR-00001
    expect(msg(6)).toMatch(/appears twice/);
    expect(r.rows[7]!.status).toBe('OK');
    await expect(importDealers(db, file, { apply: true, actor: 'ops', channel: true })).rejects.toThrow(/7 rows have a problem, so nothing was loaded/);
    expect((await db.query('SELECT count(*) AS n FROM dealers')).rows[0]!.n).toBe(2);
    await expect(importDealers(db, `${H}\n,Colour,,,,,,,,,,\n,Colour,,,,,,,,,,\n`, { apply: true, actor: 'ops', channel: true })).rejects.toThrow(/1 row has a problem/);
    await expect(importDealers(db, 'name,colour\nA,red\n', { apply: false, actor: 'ops', channel: true })).rejects.toThrow(/column “colour” is not one this import knows/);
    await expect(importDealers(db, 'phone\n1\n', { apply: false, actor: 'ops', channel: true })).rejects.toThrow(/missing name/);
  });

  it('keeps the commission channel for those allowed to configure it', async () => {
    const r = await importDealers(db, `${H}\n,Sneaky,,,,,MASTER_DISTRIBUTOR,,,,,\nDLR-00002,,,,,,,,,0099,,\n,Plain Dealer,,,,,,,,,,\n`, { apply: false, actor: 'dealer.desk', channel: false });
    expect(r.rows.map((x) => x.status)).toEqual(['ERROR', 'ERROR', 'OK']);
    expect(r.rows[0]!.message).toMatch(/permission to configure commission/);
  });
});

describe('agents in bulk', () => {
  it('adds and updates agents of dealers, and keeps an agent with its dealer', async () => {
    const t = await agentsFile(db, {});
    expect(t).toContain('agent_id,dealer_id,name,email,phone,status');
    const file = 'agent_id,dealer_id,name,email,phone,status\n,DLR-00001,Priya Nair,priya@metro.example,+6591234568,\n,DLR-00001,Ken Ong,,,INACTIVE\n,DLR-00002,Mei Ling,,,\n';
    expect((await importAgents(db, file, { apply: true, actor: 'ops' })).rows.map((r) => r.id)).toEqual(['DLR-00001-A001', 'DLR-00001-A002', 'DLR-00002-A001']);
    const up = 'agent_id,dealer_id,name,email,phone,status\nDLR-00001-A001,,Priya N.,-,,\nDLR-00001-A002,,,,,ACTIVE\n';
    expect((await importAgents(db, up, { apply: true, actor: 'ops' })).summary).toMatchObject({ updated: 2 });
    const a = (await db.query(`SELECT * FROM dealer_agents WHERE id='DLR-00001-A001'`)).rows[0]!;
    expect(a).toMatchObject({ name: 'Priya N.', email: null, phone: '+6591234568' });
    expect((await db.query(`SELECT status FROM dealer_agents WHERE id='DLR-00001-A002'`)).rows[0]!.status).toBe('ACTIVE');
    const exp = data(await agentsFile(db, { withData: true, actor: 'ops' }));
    expect(exp).toHaveLength(4);
    const own = data(await agentsFile(db, { withData: true, dealerId: 'DLR-00002' }));
    expect(own.slice(1).map((r) => r.cells[1])).toEqual(['DLR-00002']);
  });

  it('refuses moves, unknown or inactive dealers, and other dealers’ agents for a dealer’s own login', async () => {
    await createDealer(db, 'ops', { name: 'Switched Off' });
    await db.query(`UPDATE dealers SET status='INACTIVE' WHERE id='DLR-00003'`);
    const file = 'agent_id,dealer_id,name,email,phone,status\nDLR-00001-A001,DLR-00002,,,,\n,DLR-00003,Nobody,,,\n,DLR-77777,Nobody,,,\n,,Nobody,,,\n,DLR-00001,No Mail,bad,,\n';
    const r = await importAgents(db, file, { apply: false, actor: 'ops' });
    expect(r.rows.map((x) => x.message)).toEqual([
      expect.stringMatching(/cannot move to another dealer/), expect.stringMatching(/DLR-00003 is inactive/), expect.stringMatching(/DLR-77777 does not exist/), expect.stringMatching(/needs a dealer_id/), expect.stringMatching(/not an email/),
    ]);
    const mine = await importAgents(db, 'agent_id,dealer_id,name,email,phone,status\n,DLR-00001,Intruder,,,\n,DLR-00002,Mine,,,\nDLR-00001-A001,,,,,\n', { apply: false, actor: 'dealer.desk', dealerId: 'DLR-00002' });
    expect(mine.rows.map((x) => x.status)).toEqual(['ERROR', 'OK', 'ERROR']);
    expect(mine.rows[0]!.message).toMatch(/your own dealer/);
  });
});

describe('stores in bulk', () => {
  const SH = 'store_id,name,address,phone,status,market_code';
  it('adds, updates and exports stores, checking names', async () => {
    expect(await storesFile(db, {})).toContain(SH);
    const before = Number((await db.query('SELECT count(*) AS n FROM stores')).rows[0]!.n);
    const file = `${SH}\n,Marina Square Outlet,"6 Raffles Boulevard, Singapore",+6561234567,,\n,Bugis Junction,,,INACTIVE,\n`;
    const check = await importStores(db, file, { apply: false, actor: 'ops' });
    expect(check.rows.map((r) => r.message).filter(Boolean)).toEqual([]);
    expect(check.summary).toMatchObject({ created: 2, errors: 0 });
    expect(Number((await db.query('SELECT count(*) AS n FROM stores')).rows[0]!.n)).toBe(before);
    const done = await importStores(db, file, { apply: true, actor: 'ops' });
    const [a, b] = done.rows.map((r) => r.id);
    expect(a).toMatch(/^STORE-\d{5}$/);
    expect((await db.query('SELECT * FROM stores WHERE id=$1', [a])).rows[0]).toMatchObject({ name: 'Marina Square Outlet', address: '6 Raffles Boulevard, Singapore', status: 'ACTIVE' });
    expect((await db.query('SELECT status FROM stores WHERE id=$1', [b])).rows[0]!.status).toBe('INACTIVE');
    const up = await importStores(db, `${SH}\n${a},,-,+6569999999,,\n`, { apply: true, actor: 'ops' });
    expect(up.summary).toMatchObject({ updated: 1 });
    expect((await db.query('SELECT * FROM stores WHERE id=$1', [a])).rows[0]).toMatchObject({ name: 'Marina Square Outlet', address: null, phone: '+6569999999' });
    const exp = data(await storesFile(db, { withData: true, actor: 'ops' }));
    expect(exp.some((r) => r.cells[0] === a && r.cells[1] === 'Marina Square Outlet')).toBe(true);
    expect(await importStores(db, (await storesFile(db, { withData: true })), { apply: false, actor: 'ops' })).toMatchObject({ canApply: true, summary: { errors: 0 } });
  });

  it('refuses a clash of names, an unknown id, and a market that is not switched on', async () => {
    const r = await importStores(db, `${SH}\n,orchard flagship,,,,\nSTORE-90909,Ghost,,,,\n,Twin,,,,\n,twin,,,,\n,Elsewhere,,,,SG\n`, { apply: false, actor: 'ops' });
    expect(r.rows.map((x) => x.message)).toEqual([
      expect.stringMatching(/already a store called orchard flagship/), expect.stringMatching(/does not exist.*leave store_id empty/), undefined, expect.stringMatching(/appears twice/), expect.stringMatching(/markets? (are|is) not switched on|Several markets/i),
    ]);
    await expect(importStores(db, `${SH}\n,orchard flagship,,,,\n`, { apply: true, actor: 'ops' })).rejects.toThrow(/nothing was loaded/);
  });
});
