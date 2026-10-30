// Run with: node --test scripts/load-test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Governor, Metrics, Session, backoffDelay, chooseSim, chunks, classifyRefusal, estimateNeeds, isInfraFailure, leastUsed, makeRng, orderCounts, parseArgs, parseRetryAfter, pool, shouldRetry, StepLog } from './lib.mjs';

test('parseArgs reads flags and values', () => {
  assert.deepEqual(parseArgs(['--orders', '20', '--dry', '--phases', 'a,b']), { orders: '20', dry: true, phases: 'a,b' });
});

test('shouldRetry: reads and keyed writes are repeated, plain writes only when they cannot have been processed', () => {
  assert.equal(shouldRetry({ method: 'GET', status: 503 }).retry, true);
  assert.equal(shouldRetry({ method: 'GET', status: 404 }).retry, false);
  assert.equal(shouldRetry({ method: 'POST', status: 503 }).retry, false);
  assert.equal(shouldRetry({ method: 'POST', status: 503, idempotent: true }).retry, true);
  assert.equal(shouldRetry({ method: 'POST', status: 429 }).retry, true);
  assert.equal(shouldRetry({ method: 'POST', status: 422 }).retry, false);
  assert.equal(shouldRetry({ method: 'POST', error: Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }) }).retry, true);
  assert.equal(shouldRetry({ method: 'POST', error: Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }) }).retry, false);
  assert.equal(shouldRetry({ method: 'POST', error: new Error('fetch failed'), idempotent: true }).retry, true);
  assert.equal(shouldRetry({ method: 'GET', status: 500, bodyText: 'upstream request timeout' }).retry, true);
  assert.equal(shouldRetry({ method: 'GET', status: 500, bodyText: 'null value in column' }).retry, false);
  assert.equal(shouldRetry({ method: 'POST', status: 504, idempotent: true }).retry, true);
});

test('isInfraFailure ignores business refusals', () => {
  assert.equal(isInfraFailure({ status: 422 }), false);
  assert.equal(isInfraFailure({ status: 409 }), false);
  assert.equal(isInfraFailure({ status: 503 }), true);
  assert.equal(isInfraFailure({ status: 0, error: new Error('x') }), true);
});

test('backoffDelay grows, is jittered, is capped, and honours Retry-After', () => {
  const lo = () => 0, hi = () => 0.999;
  assert.equal(backoffDelay(1, { rnd: lo }), 200);
  assert.ok(backoffDelay(1, { rnd: hi }) <= 400);
  assert.ok(backoffDelay(3, { rnd: lo }) > backoffDelay(2, { rnd: lo }));
  assert.ok(backoffDelay(20, { rnd: hi }) <= 20_000);
  assert.ok(backoffDelay(1, { retryAfterMs: 5000, rnd: lo }) >= 5000);
  assert.equal(parseRetryAfter('7'), 7000);
  assert.equal(parseRetryAfter(null), 0);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4000), 6000);
});

test('Governor drops concurrency when more than 20% of the last calls failed, then recovers after the hold', () => {
  let t = 0; const g = new Governor({ limit: 8, min: 2, now: () => t });
  for (let i = 0; i < 30; i++) g.record(true);
  assert.equal(g.effective, 8);
  for (let i = 0; i < 12; i++) g.record(false);
  assert.equal(g.effective, 4);   // 12 of 42 failed = 28%
  for (let i = 0; i < 20; i++) g.record(false);
  assert.equal(g.effective, 2);   // halved again, never below the floor
  for (let i = 0; i < 60; i++) g.record(false);
  assert.equal(g.effective, 2);
  t += 59_000; assert.equal(g.effective, 2);
  t += 61_000; assert.equal(g.effective, 8);
  assert.ok(g.trips >= 2);
});

test('Governor does not trip on a few early errors and limits calls in flight', async () => {
  const g = new Governor({ limit: 2 });
  g.record(false); g.record(false); assert.equal(g.effective, 2);
  await g.acquire(); await g.acquire();
  let third = false; const p = g.acquire().then(() => { third = true; });
  await new Promise((r) => setTimeout(r, 30)); assert.equal(third, false);
  g.release(); await p; assert.equal(third, true);
});

test('pool runs everything with bounded workers and survives a throwing item', async () => {
  let running = 0, peak = 0; const seen = []; const errs = [];
  await pool(Array.from({ length: 20 }, (_, i) => i), 4, async (n) => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 2)); running--; if (n === 7) throw new Error('boom'); seen.push(n); }, (e) => errs.push(e.message));
  assert.equal(seen.length, 19); assert.deepEqual(errs, ['boom']); assert.ok(peak <= 4);
});

test('chunks splits into pieces of at most size', () => {
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunks([], 3), []);
});

test('orderCounts sums to the target with a mix of one-offs, 2 to 6 and 10 or more', () => {
  const rng = makeRng(42);
  const c = orderCounts(5000, 20000, rng);
  assert.equal(c.reduce((a, b) => a + b, 0), 20000);
  assert.ok(c.every((n) => n >= 1));
  assert.ok(c.filter((n) => n >= 10).length > 100);
  assert.ok(c.filter((n) => n >= 2 && n <= 6).length > c.length * 0.4);
  assert.equal(orderCounts(3, 100, makeRng(1)).reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(orderCounts(0, 10, rng), []);
});

test('leastUsed reaches every item before repeating any', () => {
  const rng = makeRng(7); const used = new Map(); const items = ['a', 'b', 'c', 'd'];
  for (let i = 0; i < 8; i++) { const x = leastUsed(items, used, rng); used.set(x, (used.get(x) ?? 0) + 1); }
  assert.deepEqual([...used.values()].sort(), [2, 2, 2, 2]);
});

test('chooseSim prefers what the place has', () => {
  const rng = makeRng(3);
  assert.equal(chooseSim({ physical: false, esim: true, esimShare: 0 }, rng), 'ESIM');
  assert.equal(chooseSim({ physical: true, esim: false, esimShare: 1 }, rng), 'PHYSICAL');
  assert.equal(chooseSim({ physical: false, esim: false, esimShare: 0.5 }, rng), null);
  const n = Array.from({ length: 1000 }, () => chooseSim({ physical: true, esim: true, esimShare: 0.3 }, rng)).filter((x) => x === 'ESIM').length;
  assert.ok(n > 230 && n < 370);
});

test('estimateNeeds scales plan lines at 1.3 x orders x plan share', () => {
  const n = estimateNeeds({ orders: 20000, planShare: 0.8, esimShare: 0.35 });
  assert.equal(n.planLines, 20800); assert.equal(n.esims + n.physical, n.planLines); assert.equal(n.imsi, n.esims);
});

test('classifyRefusal recognises the refusals the order loop learns from', () => {
  assert.deepEqual(classifyRefusal('insufficient stock for PHONE-X1-128 at STORE-SG-001 (available 0, need 1)'), { kind: 'sku', sku: 'PHONE-X1-128', location: 'STORE-SG-001', available: 0 });
  assert.equal(classifyRefusal('There are no free SIM cards at your store (S1). Receive some first, or sell an eSIM.').kind, 'store-sims');
  assert.equal(classifyRefusal('There are no free SIM cards in the warehouse.').kind, 'warehouse-sims');
  assert.equal(classifyRefusal('There are no eSIM profiles left in inventory. Load more eSIM ICCIDs.').kind, 'esims');
  assert.equal(classifyRefusal('There are no standard numbers left in the pool. Load more numbers').kind, 'msisdn');
  assert.equal(classifyRefusal('Family Member line requires any Group offer. Buy one in the same order or own one already.').kind, 'requires');
  assert.equal(classifyRefusal('something else').kind, 'other');
});

test('StepLog keeps the first five distinct messages, with ids folded away', () => {
  const l = new StepLog(5);
  for (let i = 0; i < 20; i++) l.note('x', false, `422 order 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed ${i % 7}`);
  l.note('x', true);
  assert.equal(l.stats.x.failed, 20); assert.equal(l.stats.x.ok, 1); assert.equal(l.errors.x.length, 5);
});

test('Session.call repeats a keyed POST with the same key after a 503, honouring Retry-After, and never repeats an unkeyed one', async () => {
  const realFetch = globalThis.fetch; const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, key: init.headers['idempotency-key'], method: init.method });
    const n = seen.length;
    if (n < 3) return new Response('{"error":{"message":"busy"}}', { status: 503, headers: { 'retry-after': '0' } });
    return new Response('{"id":"o1"}', { status: 200 });
  };
  const delays = [];
  try {
    const s = new Session('t', { base: 'http://x', sleepFn: async (ms) => { delays.push(ms); }, rnd: () => 0.5 });
    const r = await s.call('/orders', 'POST', { a: 1 }, { 'idempotency-key': 'K1' });
    assert.equal(r.ok, true); assert.equal(r.attempts, 3);
    assert.deepEqual(seen.map((x) => x.key), ['K1', 'K1', 'K1']); assert.equal(delays.length, 2); assert.ok(delays[1] > delays[0]);
    seen.length = 0;
    const r2 = await s.call('/customers', 'POST', { a: 1 });
    assert.equal(r2.status, 503); assert.equal(seen.length, 1);   // not repeated: the server may have processed it
    seen.length = 0;
    globalThis.fetch = async () => { seen.push(1); throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    const r3 = await s.call('/customers', 'POST', {}); assert.equal(r3.status, 0); assert.equal(seen.length, 5);   // 5 attempts, then gives up without throwing
  } finally { globalThis.fetch = realFetch; }
});

test('Metrics reports a call rate over its window', () => {
  let t = 1000; const m = new Metrics(() => t);
  for (let i = 0; i < 60; i++) m.onCall(i < 6);
  t += 10_000; assert.equal(m.rate(30_000), 2); assert.equal(m.failures, 6);
});
