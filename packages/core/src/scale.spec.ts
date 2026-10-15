import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browseChildren, nodeDetail, pageOffers, searchNodes } from './catalog.js';
import { createAccount, createCustomer, customerLineage, getAccount, listAccounts, listChildren, searchCustomers } from './customers.js';
import { customer360 } from './reports.js';
import { listServices } from './lifecycle.js';
import { listStock, listStockLocations } from './inventory.js';
import { auditLog } from './reports.js';
import { audit } from './audit.js';
import { MAX_PAGE } from './paging.js';
import type { Db } from './db.js';
import { freshDb, newCustomer } from './test-helpers.js';

/**
 * Lists must stay correct and bounded on big tables. These tests load thousands of rows with generate_series and check what a user relies on:
 * every row is seen exactly once while paging (even as new rows arrive), search finds the right records, and no call returns an unbounded set.
 */
let db: Db;
const N = 3000;
beforeAll(async () => {
  db = await freshDb();
  await db.query(
    `INSERT INTO customers (id, shard_id, segment, display_name, id_document_ref, id_document_hash, market_code, hierarchy_path, email, phone, created_at)
     SELECT gen_random_uuid(), 0, 'CONSUMER', 'Bulk' || i || ' Tan' , 'S****' || i, 'h' || i, 'SG', text2ltree('b_' || i),
            'bulk' || i || '@example.com', '+65' || (90000000 + i), now() - (i || ' seconds')::interval
       FROM generate_series(1, ${N}) i`);
  await db.query(`ALTER TABLE customers ALTER COLUMN id SET DEFAULT gen_random_uuid()`).catch(() => {});
}, 60_000);
afterAll(async () => { await db.close(); });

describe('customers at scale', () => {
  it('pages through every customer exactly once, newest first, with a stable order', async () => {
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const p = await searchCustomers(db, { limit: 100, cursor });
      expect(p.items.length).toBeLessThanOrEqual(100);
      seen.push(...p.items.map((c: any) => c.id)); cursor = p.nextCursor ?? undefined; pages++;
    } while (cursor);
    expect(seen.length).toBe(N);
    expect(new Set(seen).size).toBe(N);
    expect(pages).toBe(N / 100);
  });

  it('is not disturbed by rows arriving between pages', async () => {
    const first = await searchCustomers(db, { limit: 50 });
    await newCustomer(db, { displayName: 'Arrived Later' });
    const second = await searchCustomers(db, { limit: 50, cursor: first.nextCursor! });
    const ids = new Set(first.items.map((c: any) => c.id));
    expect(second.items.some((c: any) => ids.has(c.id))).toBe(false);
  });

  it('caps the page size whatever the caller asks for', async () => {
    expect((await searchCustomers(db, { limit: 100000 })).items.length).toBeLessThanOrEqual(MAX_PAGE);
  });

  it('finds people by name words, e-mail prefix, phone prefix (with or without +65) and id', async () => {
    const byName = await searchCustomers(db, { q: 'bulk1234 ta' });
    expect(byName.items.map((c: any) => c.displayName)).toEqual(['Bulk1234 Tan']);
    expect((await searchCustomers(db, { q: 'bulk2999@exa' })).items).toHaveLength(1);
    expect((await searchCustomers(db, { q: '+6590001500' })).items).toHaveLength(1);
    expect((await searchCustomers(db, { q: '90001500' })).items).toHaveLength(1);
    const one = (await searchCustomers(db, { q: 'bulk77 tan' })).items[0] as any;
    expect((await searchCustomers(db, { q: one.id })).items.map((c: any) => c.id)).toEqual([one.id]);
    expect((await searchCustomers(db, { q: 'nobody-like-this' })).items).toEqual([]);
  });

  it('treats search text as literal text, never as a pattern', async () => {
    expect((await searchCustomers(db, { q: '%' })).items).toEqual([]);
    expect((await searchCustomers(db, { q: '_@%' })).items).toEqual([]);
  });

  it('rejects a tampered cursor', async () => {
    await expect(searchCustomers(db, { cursor: 'not-a-cursor' })).rejects.toThrow(/page link/);
    await expect(searchCustomers(db, { cursor: Buffer.from(JSON.stringify(['x'])).toString('base64url') })).rejects.toThrow(/page link/);
  });

  it('answers the common queries from indexes', async () => {
    await db.query('ANALYZE customers');
    const plan = async (sql: string) => (await db.query(`EXPLAIN ${sql}`)).rows.map((r) => Object.values(r)[0]).join('\n');
    expect(await plan(`SELECT id FROM customers ORDER BY created_at DESC, id DESC LIMIT 26`)).toMatch(/customers_created_idx|Index/i);
    expect(await plan(`SELECT id FROM customers WHERE lower(email) LIKE 'bulk29%' LIMIT 20`)).toMatch(/lower_idx|email_pfx/);
    expect(await plan(`SELECT id FROM customers WHERE to_tsvector('simple', display_name) @@ to_tsquery('simple', 'bulk12:*') LIMIT 20`)).toMatch(/fts_idx|Bitmap/);
  });
});

describe('services, stock and audit at scale', () => {
  beforeAll(async () => {
    const c = await newCustomer(db);
    await db.query(
      `INSERT INTO services (id, shard_id, customer_id, account_id, offer_id, type, identifier, status)
       SELECT gen_random_uuid(), 0, $1, (SELECT id FROM accounts WHERE customer_id=$1 LIMIT 1), 'plan-sim-5g', 'MOBILE', '+6581' || lpad(i::text, 6, '0'), 'ACTIVE' FROM generate_series(1, 1500) i`, [c.customer.id]).catch(() => {});
    await db.query(`INSERT INTO inventory_stock (location_id, sku, on_hand) SELECT 'STORE-' || (i % 5), 'SKU-' || lpad(i::text, 5, '0'), 10 FROM generate_series(1, 2000) i ON CONFLICT DO NOTHING`);
    for (let i = 0; i < 120; i++) await audit(db, i % 2 ? 'alice' : 'bob', 'customer', String(i), 'VIEWED');
  }, 60_000);

  it('pages services by number and finds one by prefix', async () => {
    const all: string[] = []; let cursor: string | undefined;
    do { const p = await listServices(db, { limit: 200, cursor }); all.push(...p.items.map((s: any) => s.id)); cursor = p.nextCursor ?? undefined; } while (cursor);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThanOrEqual(1500);
    expect((await listServices(db, { q: '+6581000042' })).items.map((s: any) => s.identifier)).toEqual(['+6581000042']);
  });

  it('pages stock, filters by SKU prefix and lists locations without scanning every SKU', async () => {
    const p = await listStock(db, { sku: 'sku-0001', limit: 200 });
    expect(p.items.length).toBe(10);
    expect(p.items.every((r: any) => r.sku.startsWith('SKU-0001'))).toBe(true);
    const locs = await listStockLocations(db);
    expect(locs).toEqual(expect.arrayContaining(['STORE-0', 'STORE-4', 'WH-MAIN']));
    expect(new Set(locs).size).toBe(locs.length);
  });

  it('pages the audit log newest first and filters by actor', async () => {
    const p1 = await auditLog(db, { actor: 'alice', limit: 40 });
    expect(p1.items).toHaveLength(40);
    const p2 = await auditLog(db, { actor: 'alice', limit: 40, cursor: p1.nextCursor! });
    expect(p2.items.length).toBe(20);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((a: any) => a.id)).size).toBe(60);
    expect(p1.items.every((a: any) => a.actor === 'alice')).toBe(true);
  });
});

describe('catalog browsing at scale', () => {
  let group = '', groupPath = '';
  beforeAll(async () => {
    const g = (await db.query(`SELECT p.id, p.path FROM catalog_nodes o JOIN catalog_nodes p ON p.id = o.parent_id WHERE o.id = 'plan-sim-5g'`)).rows[0]!;
    group = g.id; groupPath = g.path;
    await db.query(
      `INSERT INTO catalog_nodes (id, level, code, name, path, parent_id, status, kind, markets, data, sort_order)
       SELECT 'bulk-offer-' || i, 'OFFER', 'BULK' || i, 'Bulk Plan ' || i, $1 || '/bulk-offer-' || i, $2, CASE WHEN i % 4 = 0 THEN 'DRAFT' ELSE 'ACTIVE' END, 'SIM_ONLY', '{}',
              '{"prices":[],"requires":[],"excludes":[],"salesChannels":[],"characteristics":{}}'::jsonb, i FROM generate_series(1, 1200) i`, [groupPath, group]);
  }, 60_000);

  it('lists one level a page at a time with offer counts, never the whole tree', async () => {
    const top = await browseChildren(db, {});
    expect(top.items.length).toBeGreaterThan(0);
    expect(top.items.every((n) => n.level === 'NETWORK_TYPE')).toBe(true);
    const mobile = top.items.find((n) => n.id === groupPath.split('/')[0])!;
    expect(mobile.offerCount).toBeGreaterThanOrEqual(1200);
    expect(mobile.activeOfferCount).toBeLessThan(mobile.offerCount);
    const seen = new Set<string>(); let cursor: string | undefined; let pages = 0;
    do { const p = await browseChildren(db, { parentId: group, limit: 100, cursor }); p.items.forEach((n) => seen.add(n.id)); cursor = p.nextCursor ?? undefined; pages++; } while (cursor);
    expect(seen.size).toBeGreaterThanOrEqual(1200);
    expect(pages).toBeGreaterThanOrEqual(12);
  });

  it('searches by words across the whole catalog and says where each result lives', async () => {
    const r = await searchNodes(db, { q: 'bulk plan 777' });
    expect(r.items.map((n) => n.id)).toEqual(['bulk-offer-777']);
    expect(r.items[0]!.trail.map((t) => t.id)).toEqual(groupPath.split('/'));
    const live = await searchNodes(db, { q: 'bulk plan 776', activeOnly: true }); // 776 % 4 = 0 → draft
    expect(live.items).toEqual([]);
    expect((await searchNodes(db, { q: '' })).items).toEqual([]);
  });

  it('opens one node with its trail, line items and bounded usage', async () => {
    const d = await nodeDetail(db, 'plan-sim-5g');
    expect(d.trail.length).toBe(3);
    expect(d.usage).toEqual(expect.objectContaining({ capped: false }));
    await expect(nodeDetail(db, 'bulk-offer-4', { activeOnly: true })).rejects.toThrow(/not found/);
  });

  it('pages sellable offers for sales screens, filtered by words', async () => {
    const p = await pageOffers(db, { status: 'ACTIVE', limit: 24 });
    expect(p.items).toHaveLength(24);
    expect(p.nextCursor).toBeTruthy();
    expect((await pageOffers(db, { status: 'ACTIVE', q: 'bulk plan 55' })).items.every((o) => o.name.startsWith('Bulk Plan 55'))).toBe(true);
  });
});

describe('customer hierarchy navigation', () => {
  it('walks customer → account → services with paged, searchable levels', async () => {
    const company = (await createCustomer(db, { segment: 'ENTERPRISE', displayName: 'Hierarchy Company', idDocument: 'UEN-CO-1', account: false })).customer;
    // 45 departments under the company, 30 accounts on it
    for (let i = 0; i < 45; i++) await createCustomer(db, { segment: 'ENTERPRISE', displayName: `Dept ${String(i).padStart(2, '0')}`, idDocument: 'UEN-CO-1', parentCustomerId: company.id as string, account: false });
    for (let i = 0; i < 30; i++) await createAccount(db, company.id as string, { name: `Cost centre ${i}` });

    const seenAccounts: string[] = []; let cur: string | undefined;
    do { const p = await listAccounts(db, company.id as string, { limit: 10, cursor: cur }); expect(p.items.length).toBeLessThanOrEqual(10); seenAccounts.push(...p.items.map((a: any) => a.id)); cur = p.nextCursor ?? undefined; } while (cur);
    expect(seenAccounts).toHaveLength(30);
    expect(new Set(seenAccounts).size).toBe(30);
    expect((await listAccounts(db, company.id as string, { q: 'centre 2' })).items.map((a: any) => a.name).sort()).toEqual(['Cost centre 2', 'Cost centre 20', 'Cost centre 21', 'Cost centre 22', 'Cost centre 23', 'Cost centre 24', 'Cost centre 25', 'Cost centre 26', 'Cost centre 27', 'Cost centre 28', 'Cost centre 29']);

    const kids = await listChildren(db, company.id as string, { limit: 20 });
    expect(kids.items).toHaveLength(20);
    expect(kids.nextCursor).toBeTruthy();
    expect((await listChildren(db, company.id as string, { q: 'dept 07' })).items.map((k: any) => k.displayName)).toEqual(['Dept 07']);

    const dept = (kids.items[0] as any).id as string;
    const lin = await customerLineage(db, dept);
    expect(lin.ancestors.map((a: any) => a.displayName)).toEqual(['Hierarchy Company']);

    const c360 = await customer360(db, company.id as string);
    expect(c360.accountCount).toBe(30);
    expect(c360.accounts).toHaveLength(20); // a first page, not all of them
    expect(c360.childCount).toBe(45);
    expect(c360.children).toHaveLength(10);

    const acct = await getAccount(db, seenAccounts[0]!);
    expect(acct).toMatchObject({ balanceMinor: 0, serviceCount: 0 });
    expect(acct.customer.displayName).toBe('Hierarchy Company');
  }, 60_000);
});

describe('customer lookup by ID document', () => {
  it('finds the owner by their ID number, exactly, without ever storing the number', async () => {
    const c = (await createCustomer(db, { segment: 'CONSUMER', displayName: 'Lookup Person', idDocument: 'S1234567D' })).customer;
    expect((await searchCustomers(db, { q: 'S1234567D' })).items.map((x: any) => x.id)).toEqual([c.id]);
    expect((await searchCustomers(db, { q: 's1234567d' })).items.map((x: any) => x.id)).toEqual([c.id]); // case does not matter
    expect((await searchCustomers(db, { q: 'S1234567E' })).items).toEqual([]);
    expect(JSON.stringify(c)).not.toContain('1234567');
  });
});

describe('lookups by id alone, and order numbers', () => {
  it('has an index on id for every sharded table that is found by id alone, so each lookup is one probe per partition (150-400 ms without, measured at 4 million rows)', async () => {
    for (const [table, col] of [['customers', 'id'], ['accounts', 'id'], ['orders', 'id'], ['services', 'id'], ['order_lines', 'order_id'], ['services', 'order_id']] as const) {
      const plan = (await db.query(`SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexdef ~ $2`, [table, `\\(${col}\\)`])).rows;
      expect(plan.length, `${table}(${col})`).toBeGreaterThan(0);
    }
    await db.query('SET enable_seqscan = off');
    const ex = (await db.query(`EXPLAIN SELECT * FROM services WHERE id = '00000000-0000-0000-0000-000000000001'`)).rows.map((r: any) => Object.values(r)[0]).join('\n');
    await db.query('RESET enable_seqscan');
    expect(ex).toMatch(/services_h\d+_id_idx/);
  });

  it('numbers orders 1, 2, 3 each day without holding a lock until the order commits', async () => {
    const { nextOrderNumber } = await import('./orders.js');
    const day = new Date('2031-05-05T04:00:00Z');
    const [a, b] = await db.tx(async (q) => [await nextOrderNumber(q, day), await nextOrderNumber(q, day)]);
    expect([a, b]).toEqual(['20310505-00001', '20310505-00002']);
    // A second transaction takes its number while the first is still open and does not wait for it. (The embedded database has one connection, so this needs real Postgres.)
    if (db.kind === 'postgres') {
      let release!: () => void;
      const open = db.tx(async (q) => { const n = await nextOrderNumber(q, day); await new Promise<void>((r) => { release = r; }); return n; });
      await new Promise((r) => setTimeout(r, 100));
      const other = await Promise.race([db.tx((q) => nextOrderNumber(q, day)), new Promise<string>((r) => setTimeout(() => r('WAITED'), 3000))]);
      release();
      expect(other).toBe('20310505-00004');
      expect(await open).toBe('20310505-00003');
    }
    expect(await nextOrderNumber(db, new Date('2031-05-06T04:00:00Z'))).toBe('20310506-00001');
  });
});
