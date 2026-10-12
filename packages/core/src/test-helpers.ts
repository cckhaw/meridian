import pg from 'pg';
import { openDb, type Db } from './db.js';
import { createCustomer } from './customers.js';
import { seedReference } from './seed.js';

/** Fresh isolated embedded database with the reference catalog and stock. */
export async function freshDb(): Promise<Db> {
  // TEST_DATABASE_URL=postgres://... runs the suite against a real server (one throwaway database per call).
  const admin = process.env.TEST_DATABASE_URL;
  let url = '';
  if (admin) {
    const name = `meridian_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const c = new pg.Client({ connectionString: admin });
    await c.connect();
    await c.query(`CREATE DATABASE ${name}`);
    await c.end();
    url = admin.replace(/\/[^/]*$/, `/${name}`);
  }
  const db = await openDb({ url });
  await seedReference(db);
  return db;
}
let n = 0;
export const newCustomer = async (db: Db, o: Partial<Parameters<typeof createCustomer>[1]> = {}) =>
  createCustomer(db, { segment: 'CONSUMER', displayName: `Test Customer ${++n}`, idDocument: `T${n}${Math.random().toString(36).slice(2, 8)}`, ...o });

/** Pretend a customer's services went live `days` ago, so a bill run has something to bill. */
export const backdate = (db: Db, customerId: string, days: number) =>
  db.query(`UPDATE services SET activated_at = now() - ($2 || ' days')::interval, contract_start = now() - ($2 || ' days')::interval WHERE customer_id=$1`, [customerId, String(days)]);
