import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { nrmSummary } from './nrm.js';
import { seedDemo } from './seed.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

describe('the demo data', () => {
  it('loads, including sample number, SIM and identity pools, and the demo customers get numbers from the pool', async () => {
    await seedDemo(db);
    const s = await nrmSummary(db);
    expect(s.iccid.length).toBeGreaterThan(0);
    expect(s.availableByTier.STANDARD).toBeGreaterThan(300);
    expect((await db.query(`SELECT state FROM msisdn_inventory WHERE msisdn='+6598888888'`)).rows[0]!.state).toBe('AUCTION_HOLD');
    expect((await db.query(`SELECT count(*)::int AS n FROM services s JOIN msisdn_inventory m ON m.msisdn = s.identifier WHERE m.state='ASSIGNED_ACTIVE'`)).rows[0]!.n).toBeGreaterThan(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM orders WHERE number ~ '^[0-9]{8}-[0-9]{5}$'`)).rows[0]!.n).toBeGreaterThan(0);
  }, 120_000);
});
