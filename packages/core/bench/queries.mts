/**
 * Latency of the application's hot queries against a loaded Postgres (see load.sql). For each query: N runs with random parameters taken from the data,
 * latency p50/p95/p99 in milliseconds measured at the client over a local socket (so it includes the round trip, which is the honest number), and the plan's
 * scan types. Usage: BENCH_URL=postgres://… npx tsx bench/queries.mts [runs]
 */
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.BENCH_URL, max: 1 });
const runs = Number(process.argv[2] ?? 300);
const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const pick = async <T,>(sql: string, n = 500): Promise<T[]> => (await one(sql, [n])) as T[];

const [custs, svcs, ords, accts] = await Promise.all([
  pick<{ id: string; shard_id: number; phone: string; email: string; display_name: string }>(`SELECT id, shard_id, phone, email, display_name FROM customers TABLESAMPLE SYSTEM (0.05) LIMIT $1`),
  pick<{ id: string; identifier: string; account_id: string; shard_id: number }>(`SELECT id, identifier, account_id, shard_id FROM services TABLESAMPLE SYSTEM (0.05) LIMIT $1`),
  pick<{ id: string; shard_id: number; customer_id: string; number: string }>(`SELECT id, shard_id, customer_id, number FROM orders TABLESAMPLE SYSTEM (0.05) LIMIT $1`),
  pick<{ id: string; customer_id: string; shard_id: number }>(`SELECT id, customer_id, shard_id FROM accounts TABLESAMPLE SYSTEM (0.05) LIMIT $1`),
]);
const rnd = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;

interface Q { name: string; sql: string; params: () => unknown[]; note?: string }
const Q: Q[] = [
  { name: 'service by number (exact)', sql: `SELECT * FROM services WHERE identifier=$1 AND type='MOBILE' ORDER BY (status='TERMINATED'), updated_at DESC LIMIT 1`, params: () => [rnd(svcs).identifier] },
  { name: 'service by id (shard unknown)', sql: `SELECT * FROM services WHERE id=$1`, params: () => [rnd(svcs).id] },
  { name: 'services of an account', sql: `SELECT * FROM services WHERE account_id=$1 AND status <> 'TERMINATED' ORDER BY identifier`, params: () => [rnd(svcs).account_id] },
  { name: 'customer by id (shard unknown)', sql: `SELECT * FROM customers WHERE id=$1`, params: () => [rnd(custs).id] },
  { name: 'customer by id and shard', sql: `SELECT * FROM customers WHERE shard_id=$1 AND id=$2`, params: () => { const c = rnd(custs); return [c.shard_id, c.id]; } },
  { name: 'account by id (shard unknown)', sql: `SELECT * FROM accounts WHERE id=$1`, params: () => [rnd(accts).id] },
  { name: 'accounts of a customer', sql: `SELECT * FROM accounts WHERE customer_id=$1 ORDER BY created_at, id`, params: () => [rnd(accts).customer_id] },
  { name: 'customer search: phone prefix (8 digits)', sql: `SELECT id FROM customers WHERE phone LIKE $1 LIMIT 25`, params: () => [rnd(custs).phone.slice(0, 9) + '%'] },
  { name: 'customer search: e-mail prefix', sql: `SELECT id FROM customers WHERE lower(email) LIKE $1 LIMIT 25`, params: () => [rnd(custs).email.slice(0, 9) + '%'] },
  { name: 'customer search: name words', sql: `SELECT id FROM customers WHERE to_tsvector('simple', display_name) @@ to_tsquery('simple', $1) LIMIT 25`, params: () => { const w = rnd(custs).display_name.toLowerCase().split(' '); return [`${w[0]!.slice(0, 3)}:* & ${w[2]}:*`]; } },
  { name: 'customer list, newest first (page 1)', sql: `SELECT * FROM customers ORDER BY created_at DESC, id DESC LIMIT 26`, params: () => [] },
  { name: 'order by id (shard unknown)', sql: `SELECT * FROM orders WHERE id=$1`, params: () => [rnd(ords).id] },
  { name: 'order by number', sql: `SELECT id FROM orders WHERE number LIKE $1 LIMIT 25`, params: () => [rnd(ords).number] },
  { name: 'orders of a customer', sql: `SELECT * FROM orders WHERE shard_id=$1 AND customer_id=$2 ORDER BY created_at DESC LIMIT 25`, params: () => { const o = rnd(ords); return [o.shard_id, o.customer_id]; } },
  { name: 'orders, newest first (page 1)', sql: `SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 26`, params: () => [] },
  { name: 'bill run: accounts due today (one cycle day, a page)', sql: `SELECT id, customer_id FROM accounts WHERE bill_cycle_day=$1 AND status='ACTIVE' ORDER BY id LIMIT 1000`, params: () => [1 + Math.floor(Math.random() * 28)] },
  { name: 'invoices of an account', sql: `SELECT * FROM invoices WHERE account_id=$1 ORDER BY issue_date DESC LIMIT 25`, params: () => [rnd(accts).id] },
  { name: 'dunning: open invoices past due (a page)', sql: `SELECT id, account_id FROM invoices WHERE status IN ('ISSUED','OVERDUE') AND due_date < current_date ORDER BY due_date LIMIT 1000`, params: () => [] },
  { name: 'dunning: open balance of an account', sql: `SELECT sum(total_minor - paid_minor - credited_minor) FROM invoices WHERE account_id=$1 AND status IN ('ISSUED','OVERDUE')`, params: () => [rnd(accts).id] },
  { name: 'identifier registry claim (insert + rollback)', sql: `WITH x AS (INSERT INTO identifier_registry (type, identifier, service_id) VALUES ('MOBILE', $1, gen_random_uuid()) ON CONFLICT DO NOTHING RETURNING 1) SELECT count(*) FROM x`, params: () => ['+6599' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0')] },
];

const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]!;
const scans = (plan: any): string[] => { const out: string[] = []; const walk = (n: any) => { if (/Scan/.test(n['Node Type'])) out.push(`${n['Node Type'].replace(' Scan', '')}${n['Index Name'] ? ':' + n['Index Name'] : ''}`); (n.Plans ?? []).forEach(walk); }; walk(plan); return [...new Set(out)]; };

console.log('| Query | p50 ms | p95 ms | p99 ms | Plan |\n|---|---:|---:|---:|---|');
for (const q of Q) {
  const times: number[] = [];
  for (let i = 0; i < 20; i++) await pool.query(q.sql, q.params()); // warm up
  for (let i = 0; i < runs; i++) { const p = q.params(); const t = process.hrtime.bigint(); await pool.query(q.sql, p); times.push(Number(process.hrtime.bigint() - t) / 1e6); }
  times.sort((a, b) => a - b);
  let plan = '';
  try {
    const ex = (await pool.query(`EXPLAIN (FORMAT JSON) ${q.sql}`, q.params())).rows[0]['QUERY PLAN'][0].Plan;
    const s = scans(ex);
    plan = s.length > 3 ? `${s.slice(0, 2).join(', ')} … (${s.length} scans)` : s.join(', ');
  } catch { plan = '—'; }
  console.log(`| ${q.name} | ${pct(times, 50).toFixed(2)} | ${pct(times, 95).toFixed(2)} | ${pct(times, 99).toFixed(2)} | ${plan} |`);
}
await pool.end();
