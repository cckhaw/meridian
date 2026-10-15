/**
 * Order throughput through the application's own code (placeOrder) on a loaded Postgres: W concurrent workers for S seconds.
 * 100,000 orders a day is about 1.2 a second on average and perhaps 10 a second in a busy hour; this finds how far above that one database goes.
 * Usage: BENCH_URL=postgres://… npx tsx bench/orders.mts [workers] [seconds]
 */
import pg from 'pg';
import { openDb } from '../src/db.ts';
import { placeOrder } from '../src/orders.ts';

const workers = Number(process.argv[2] ?? 8), seconds = Number(process.argv[3] ?? 30);
process.env.PG_POOL_MAX = String(workers + 2);
const db = await openDb({ url: process.env.BENCH_URL });
const raw = new pg.Pool({ connectionString: process.env.BENCH_URL, max: 1 });
const sample = (await raw.query(`SELECT a.id AS account_id, a.customer_id FROM accounts a TABLESAMPLE SYSTEM (0.02) LIMIT 5000`)).rows;
await raw.end();
const lat: number[] = [];
let fails = 0;
const end = Date.now() + seconds * 1000;
const t0 = Date.now();
await Promise.all(Array.from({ length: workers }, async (_, w) => {
  for (let i = w; Date.now() < end; i += workers) {
    const s = sample[(i * 7919) % sample.length]!;
    const t = process.hrtime.bigint();
    try { await placeOrder(db, { customerId: s.customer_id, accountId: s.account_id, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'bench' }, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] }); lat.push(Number(process.hrtime.bigint() - t) / 1e6); }
    catch { fails++; }
  }
}));
const secs = (Date.now() - t0) / 1000;
lat.sort((a, b) => a - b);
const p = (x: number) => lat[Math.min(lat.length - 1, Math.floor(x / 100 * lat.length))]!.toFixed(1);
console.log(`${workers} workers, ${secs.toFixed(0)} s: ${lat.length} orders, ${(lat.length / secs).toFixed(1)}/s (${Math.round(lat.length / secs * 86400).toLocaleString()}/day), failures ${fails}; latency p50 ${p(50)} ms, p95 ${p(95)} ms, p99 ${p(99)} ms`);
await db.close();
