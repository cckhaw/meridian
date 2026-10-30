#!/usr/bin/env node
/**
 * Fills a Meridian system with a realistic load of transactions through its public API, so every module has data to look at: customers (with
 * identity photographs and KYC decisions), orders on every channel across every store, dealer and product range, service changes, groups, cases,
 * interactions, bill runs, invoices, payments, credits, refunds, collections, dunning and fraud entries.
 *
 *   BASE=https://meridian.example.com ADMIN_USER=root ADMIN_PASS=… node scripts/load-test/run.mjs [--customers 60] [--orders N] [--tag LT] [--dry]
 *   (ADMIN_OTP=123456 if the admin account asks for a second factor; load-pools.mjs tops up numbers and SIMs first)
 *
 *   --phases setup,customers,kyc,orders,changes,care,billing,payments,ops,report   (default: all)  A phase that needs customers adopts the ones
 *            already tagged [TAG] when `customers` is not part of the run. --resume = every phase except setup, customers and kyc.
 *   --customers N (60)  --orders N (more orders to place; about 2.2 x customers when customers are created in the same run)  --cases N  --interactions N
 *   --dealers N (3) --agents-per-dealer N (2) --stores N (new stores, 0) --callcentre N --telesales N --backoffice N   (staff accounts left active)
 *   --concurrency N (6, at most 12)  --tag LT  --seed N  --dry (read-only: shows what could be sold and what stock there is)  --keep-users
 *   --bill-chunk N (500 accounts per bill run)  --cycle-run (also run the bill cycle that has most load-test accounts: bills every account on it!)
 *   --esim-share 0.35  --quicksale-stores N (5)  --groups N  --out FILE (report path)
 *
 * It uses the products already in the system (nothing is invented) and tags everything it creates: customer names end in “[LT]”, ID numbers carry the
 * tag, references start with LT-. It needs an administrator (to create short-lived staff logins: compliance, finance and five agents, which it
 * disables again at the end) and never deletes anything. Calls that fail for infrastructure reasons are repeated with backoff (orders carry one
 * idempotency key for all their repeats); progress is printed every 30 seconds and the JSON report is rewritten every minute. Run it against a copy first.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Governor, Metrics, Session, StepLog, parseArgs, makeRng, pool as poolRaw, chunks, orderCounts, leastUsed, chooseSim, estimateNeeds, classifyRefusal, sleep } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const BASE = (process.env.BASE ?? args.base ?? 'http://localhost:3111').replace(/\/$/, '');
const RESUME = !!args.resume;
const ALL_PHASES = ['setup', 'customers', 'kyc', 'orders', 'changes', 'care', 'billing', 'payments', 'ops', 'report'];
const PHASES = new Set(args.phases && args.phases !== true ? String(args.phases).split(',').map((s) => s.trim()).filter(Boolean) : RESUME ? ALL_PHASES.filter((p) => !['setup', 'customers', 'kyc'].includes(p)) : ALL_PHASES);
for (const p of PHASES) if (!ALL_PHASES.includes(p)) throw new Error(`unknown phase “${p}”: use ${ALL_PHASES.join(', ')}`);
const has = (p) => PHASES.has(p);
const TAG = String(args.tag ?? 'LT');
const DRY = !!args.dry;
const KEEP_USERS = !!args['keep-users'];
const COUNT = (k, d) => Math.max(0, Math.floor(Number(args[k] ?? d)) || 0);
const N = has('customers') ? COUNT('customers', 60) : 0;
const DEALERS = has('setup') ? COUNT('dealers', 3) : 0, AGENTS_PER_DEALER = Math.max(1, COUNT('agents-per-dealer', 2)), NEW_STORES = has('setup') ? COUNT('stores', 0) : 0;
const CALLCENTRE = has('setup') ? COUNT('callcentre', 0) : 0, TELESALES = has('setup') ? COUNT('telesales', 0) : 0, BACKOFFICE = has('setup') ? COUNT('backoffice', 0) : 0;
const CONC = Math.min(12, Math.max(1, COUNT('concurrency', 6)));
const ORDERS = args.orders !== undefined ? COUNT('orders', 0) : has('customers') ? Math.round(N * 2.2) : 0;
const ESIM_SHARE = Math.min(1, Math.max(0, Number(args['esim-share'] ?? 0.35)));
const BILL_CHUNK = Math.min(10_000, Math.max(1, COUNT('bill-chunk', 500)));
const OUT = String(args.out && args.out !== true ? args.out : `load-test-report-${TAG}.json`);
const AGENT_USERS = 5;

// ─────────────────────────── small helpers ───────────────────────────
const rng = makeRng(args.seed !== undefined ? Number(args.seed) : Date.now() % 100000);
const { rnd, pick, chance, between, shuffle } = rng;
const steps = new StepLog(5);
const note = (k, ok, err) => steps.note(k, ok, err);
const log = (...a) => console.log(...a);
const gov = new Governor({ limit: CONC, min: 2 });
const metrics = new Metrics();
const mkSession = (name) => new Session(name, { base: BASE, gov, metrics });
const errText = (r) => `${r.status} ${r.json?.error?.message ?? JSON.stringify(r.json).slice(0, 120)}`;

/** Runs one step and records whether it worked, so one bad call does not stop the load. */
async function step(key, fn) {
  try { const r = await fn(); if (r && r.status !== undefined && !r.ok) { note(key, false, errText(r)); return null; } note(key, true); return r; }
  catch (e) { note(key, false, String(e.message).slice(0, 160)); return null; }
}

// progress and phase timing
const t0 = Date.now();
const prog = { phase: 'start', done: 0, total: 0 };
const timings = {};
let phaseStart = Date.now();
const mmss = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
function startPhase(name, total = 0) {
  if (prog.phase !== 'start') timings[prog.phase] = { seconds: Math.round((Date.now() - phaseStart) / 1000), done: prog.done, total: prog.total };
  prog.phase = name; prog.done = 0; prog.total = total; phaseStart = Date.now();
  log(`\n== ${name}${total ? ` (${total})` : ''} ==`);
}
const setTotal = (n) => { prog.total = n; prog.done = 0; };
function progressLine() {
  const pct = prog.total ? ` ${prog.done}/${prog.total} (${Math.round((100 * prog.done) / prog.total)}%)` : prog.done ? ` ${prog.done}` : '';
  return `[${mmss(Date.now() - t0)}] ${prog.phase}${pct} | ${metrics.rate().toFixed(1)} calls/s | errors ${metrics.calls ? ((100 * metrics.failures) / metrics.calls).toFixed(1) : '0.0'}% (last ${gov.ring.length}: ${(gov.errorRate * 100).toFixed(0)}%), ${metrics.retries} retries | concurrency ${gov.effective}/${gov.limit}`;
}
setInterval(() => log(progressLine()), 30_000).unref();
/** Runs fn over items with the configured concurrency, counting progress; a throwing item is counted, not fatal. */
async function each(label, items, fn) {
  setTotal(items.length);
  await poolRaw(items, CONC, async (it, i) => { try { await fn(it, i); } finally { prog.done++; } }, (e) => note(`${label} (unexpected)`, false, e.message));
}

// ─────────────────────────── fixtures ───────────────────────────
// A structurally valid, camera-style JPEG (no photo-library metadata), different every time.
const jpeg = (w = 1280, h = 800) => {
  const seg = (m, d) => { const l = Buffer.alloc(2); l.writeUInt16BE(d.length + 2); return Buffer.concat([Buffer.from([0xff, m]), l, d]); };
  const sof = Buffer.alloc(15); sof[0] = 8; sof.writeUInt16BE(h, 1); sof.writeUInt16BE(w, 3); sof[5] = 3; sof.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 6);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), seg(0xfe, Buffer.from(randomUUID())), seg(0xc0, sof), seg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0])), Buffer.from('scan'), Buffer.from([0xff, 0xd9])]).toString('base64');
};
const capture = () => ({ method: 'LIVE_CAMERA', at: new Date().toISOString(), facing: 'environment', width: 1280, height: 800 });
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000 - between(0, 80_000) * 1000).toISOString();
const futureDate = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

const FIRST = ['Aiman', 'Siti', 'Wei Jie', 'Mei Ling', 'Arjun', 'Priya', 'Hafiz', 'Nurul', 'Jason', 'Sarah', 'Kumar', 'Lakshmi', 'Daniel', 'Aisha', 'Ethan', 'Farah', 'Ravi', 'Hui Min', 'Zul', 'Amirah', 'Kenneth', 'Syafiqah', 'Marcus', 'Devi', 'Irfan', 'Jia Hao', 'Tan', 'Nadia', 'Haziq', 'Yan Ting'];
const LAST = ['Abdullah', 'Tan', 'Lim', 'Raj', 'Rahman', 'Wong', 'Ismail', 'Chong', 'Singh', 'Lee', 'Hassan', 'Ng', 'Krishnan', 'Yusof', 'Ong', 'Ahmad', 'Teo', 'Subramaniam', 'Chan', 'Zainal'];
const COMPANIES = ['Orbit Logistics', 'Sunrise Bakery', 'Kopi & Co', 'Delta Engineering', 'Harbour Freight', 'Lumen Clinic', 'Pinnacle Tuition', 'GreenLeaf Trading', 'Bluewave IT', 'Maju Hardware'];
const CITIES = [['Kuala Lumpur', '50450', 'WP Kuala Lumpur'], ['Petaling Jaya', '47800', 'Selangor'], ['George Town', '10200', 'Penang'], ['Johor Bahru', '80000', 'Johor'], ['Ipoh', '30000', 'Perak'], ['Kota Kinabalu', '88000', 'Sabah']];
const SUBJECTS = {
  FIBER_ASSURANCE: ['Fibre keeps dropping in the evening', 'Slow speeds since the router swap', 'No internet since this morning', 'Router lights red'],
  BILLING_REFUND: ['Charged twice for this month', 'Wrong plan fee on the bill', 'Refund for the cancelled add-on', 'Late fee dispute'],
  MNP_PORT_OUT: ['Customer wants to move to another operator'],
  GENERAL: ['Cannot log in to the app', 'Change my billing address', 'SIM stopped working abroad', 'Request a copy of my contract', 'Roaming not activating', 'Where is my delivery?'],
};
const INTERACTIONS = ['Asked about the next bill', 'Wants to upgrade the plan', 'Reported poor coverage at home', 'Enquired about device instalments', 'Updated contact details', 'Asked about contract end date', 'Complained about call drops', 'Asked for an itemised bill', 'Enquired about roaming packs', 'Thanked the agent for fast service'];

// ─────────────────────────── report ───────────────────────────
const S = {   // everything the report and the summary draw from
  customers: [], stores: [], dealers: [], storeOrders: new Map(), dealerOrders: new Map(), agentOrders: new Map(), channelOrders: {}, kindOrders: {}, orderIds: [],
  orders: { target: ORDERS, ok: 0, attempts: 0, replays: 0, held: 0, cancelled: 0 }, offers: new Map(), stock: null, needs: null, billing: { runs: [], invoicesProduced: 0, cycleRun: null },
  care: {}, blockedNotes: [], failingStores: [],
};
function buildReport(final = false) {
  const top = (m, names) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, name: names?.get(id), orders: n }));
  const storeNames = new Map(S.stores.map((s) => [s.id, s.name])), dealerNames = new Map(S.dealers.map((d) => [d.id, d.name]));
  const perStore = S.stores.map((s) => ({ id: s.id, name: s.name, orders: S.storeOrders.get(s.id) ?? 0 })).sort((a, b) => b.orders - a.orders);
  const perDealer = S.dealers.map((d) => ({ id: d.id, name: d.name, orders: S.dealerOrders.get(d.id) ?? 0, agents: d.agents.length })).sort((a, b) => b.orders - a.orders);
  const cur = { ...timings, ...(final ? {} : { [prog.phase]: { seconds: Math.round((Date.now() - phaseStart) / 1000), done: prog.done, total: prog.total, running: true } }) };
  return {
    base: BASE, tag: TAG, phases: [...PHASES], final, startedAt: new Date(t0).toISOString(), updatedAt: new Date().toISOString(), minutes: Math.round((Date.now() - t0) / 600) / 100, timings: cur,
    calls: { total: metrics.calls, infraFailures: metrics.failures, retries: metrics.retries, perSecond: Math.round((metrics.calls / Math.max(1, (Date.now() - t0) / 1000)) * 10) / 10, effectiveConcurrency: gov.effective, governorTrips: gov.trips },
    steps: steps.stats, errors: steps.errors,
    customers: { known: S.customers.length, created: S.customers.filter((c) => c.created).length, verified: S.customers.filter((c) => c.verified).length, pending: S.customers.filter((c) => !c.verified && /PENDING/.test(c.kycStatus ?? '')).length },
    orders: { ...S.orders, byChannel: S.channelOrders, byKind: S.kindOrders, perOffer: [...S.offers.values()].map(offerRow).sort((a, b) => a.orders - b.orders), perStore, perDealer, perAgent: top(S.agentOrders), blocked: S.blockedNotes, failingStores: S.failingStores, storesWithNoOrders: perStore.filter((s) => !s.orders).length, dealersWithNoOrders: perDealer.filter((d) => !d.orders).length },
    stock: S.stock, needs: S.needs, billing: S.billing, care: S.care,
    sample: S.customers.slice(0, 5).map((c) => ({ id: c.id, name: c.name })),
  };
}
const offerRow = (o) => ({ id: o.offer.id, name: o.offer.name, kind: o.offer.kind, orders: o.orders, refused: o.refused, shapes: o.shapes.filter((s) => !s.dead).map((s) => s.type), firstRefusal: o.firstRefusal, blocked: o.blocked ? { reason: o.blocked.reason, until: o.blocked.until === Infinity ? 'for the run' : new Date(o.blocked.until).toISOString() } : null, whyNotSold: o.orders ? undefined : o.firstRefusal ?? o.whyNot ?? 'never picked' });
let reportTimer;
const writeReport = (final = false) => { try { writeFileSync(OUT, JSON.stringify(buildReport(final), null, 2)); } catch (e) { log(`(could not write ${OUT}: ${e.message})`); } };
reportTimer = setInterval(() => writeReport(false), 60_000); reportTimer.unref();
process.on('SIGINT', () => { log('\nInterrupted: writing the report. Re-run with the remaining --phases (adoption by tag) to carry on.'); writeReport(false); process.exit(130); });

// ─────────────────────────── start ───────────────────────────
const admin = mkSession('admin');
await admin.login(process.env.ADMIN_USER ?? 'root', process.env.ADMIN_PASS ?? '', process.env.ADMIN_OTP);
log(`Signed in to ${BASE} as ${admin.user.username}. Tag ${TAG}; phases ${[...PHASES].join(', ')}; concurrency ${CONC}${DRY ? ' (dry run: nothing is written)' : ''}.`);
log(`Target: ${N} new customers, ${ORDERS} more orders${args.orders === undefined && !has('customers') ? ' (give --orders N to place orders for adopted customers)' : ''}.`);
const me = admin.user;
const market = me.marketCode ?? 'MY';
const meta = (await admin.call('/meta')).json;
const segments = (await admin.call('/segments')).json;
const segList = Array.isArray(segments) ? segments.filter((s) => s && s.id && (!s.status || s.status === 'ACTIVE')) : [];
const individualSeg = (segList.find((s) => s.individual) ?? { id: 'CONSUMER' }).id;
const companySeg = segList.find((s) => !s.individual && /enterprise|business|corporate|sme/i.test(s.id + s.name))?.id ?? segList.find((s) => !s.individual)?.id;
const billDays = meta.billCycles?.days ?? Array.from({ length: 28 }, (_, i) => i + 1);
const must = (r, what) => { if (!r.ok) throw new Error(`${what}: ${errText(r)}`); return r.json; };

/** Follows a list's cursor to the end (or maxPages), calling onPage for each page. Servers may clamp the page size, so the cursor decides. */
async function pages(sess, path, onPage, { maxPages = 5000 } = {}) {
  const sep = path.includes('?') ? '&' : '?';
  let cursor = '';
  for (let i = 0; i < maxPages; i++) {
    const r = await sess.call(`${path}${sep}${cursor ? `cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!r.ok) { note(`list ${path.split('?')[0]}`, false, errText(r)); return false; }
    const stop = await onPage(r.json.items ?? [], i);
    cursor = r.json.nextCursor; if (!cursor || stop === false) return true;
  }
  return true;
}

// ─────────────────────────── catalog ───────────────────────────
const catalog = [];
async function loadCatalog() {
  if (catalog.length) return;
  await pages(admin, `/catalog?limit=100&status=ACTIVE&forSale=1&market=${market}`, (items) => { catalog.push(...items); });
  log(`Found ${catalog.length} offers on sale in market ${market}.`);
  if (!catalog.length) throw new Error('No offers on sale: create products first.');
}
const beh = (o) => o.behaviour ?? {};
const needsSimOffer = (o) => !!o.fulfilment?.requiresSimActivation && (beh(o).service ?? 'MOBILE') === 'MOBILE';
const isGroup = (o) => !!o.group?.isGroupOffer;
const segs = (o) => String(o.path ?? '').split('/');
const satisfies = (target, offer) => offer.id === target || segs(offer).includes(target);
const isPlainPlan = (o) => needsSimOffer(o) && !isGroup(o) && !o.variants?.length && beh(o).role !== 'ADDON' && !beh(o).goods && (o.prices ?? []).some((p) => p.type === 'RECURRING');
const skusOf = (o, variantId) => {
  const own = o.fulfilment?.inventorySkus ?? []; const v = (o.variants ?? []).find((x) => x.id === variantId); if (!v) return own;
  const covered = new Set((o.variants ?? []).map((x) => x.sku)); return [...own.filter((s) => !covered.has(s)), v.sku];
};
const kindGroup = (o) => isGroup(o) ? 'group plan' : o.fulfilment?.requiresInstallation ? 'fibre' : o.variants?.length && needsSimOffer(o) ? 'device + plan' : o.variants?.length ? 'device (outright)' : needsSimOffer(o) ? 'plan' : (o.prices ?? []).some((p) => p.type === 'RECURRING') ? 'add-on / service' : 'goods';

// ─────────────────────────── stores, dealers, stock ───────────────────────────
async function discoverStoresAndDealers() {
  S.stores = [];
  await pages(admin, '/stores?limit=200&status=ACTIVE', (items) => { for (const s of items) if (!s.status || s.status === 'ACTIVE') S.stores.push({ id: s.id, name: s.name }); });
  S.dealers = [];
  await pages(admin, '/dealers?limit=200&status=ACTIVE', (items) => { for (const d of items) if (!d.status || d.status === 'ACTIVE') S.dealers.push({ id: d.id, name: d.name, agents: [] }); });
  await each('dealer agents read', S.dealers, async (d) => { await pages(admin, `/dealers/${d.id}/agents?limit=200&status=ACTIVE`, (items) => { for (const a of items) if (!a.status || a.status === 'ACTIVE') d.agents.push(a.id); }); });
  S.dealers = S.dealers.filter((d) => d.agents.length);
  log(`Found ${S.stores.length} active stores and ${S.dealers.length} dealers with agents (${S.dealers.reduce((n, d) => n + d.agents.length, 0)} agents).`);
}

/** What is on the shelves: numbers, IMSIs, SIM cards, eSIM profiles, SKU stock per location. */
const stock = { numbers: true, msisdn: Infinity, imsi: Infinity, whSims: Infinity, esim: Infinity, storeSims: new Map(), sku: null, learned: new Map(), loaded: false };
async function loadStock({ quiet = false } = {}) {
  const sum = await admin.call('/numbering/summary');
  if (sum.ok) {
    const s = sum.json; const add = (rows, f) => rows.filter(f).reduce((n, r) => n + r.n, 0);
    const total = add(s.msisdn, () => true);
    stock.numbers = total > 0;
    stock.msisdn = total > 0 ? s.availableByTier?.STANDARD ?? 0 : Infinity;
    stock.imsi = add(s.imsi, (r) => r.state === 'POOL_UNASSIGNED');
    stock.whSims = add(s.iccid, (r) => r.kind === 'PHYSICAL' && r.state === 'WAREHOUSE_INVENTORY');
    stock.esim = Math.min(add(s.iccid, (r) => r.kind === 'ESIM' && ['WAREHOUSE_INVENTORY', 'DISTRIBUTED_DEALER'].includes(r.state)), stock.imsi);
    S.stock = { msisdnFree: add(s.msisdn, (r) => r.state === 'AVAILABLE'), msisdnStandardFree: s.availableByTier?.STANDARD ?? 0, byTier: s.availableByTier, imsiFree: stock.imsi, physicalSimsInWarehouse: stock.whSims, esimProfilesFree: add(s.iccid, (r) => r.kind === 'ESIM' && ['WAREHOUSE_INVENTORY', 'DISTRIBUTED_DEALER'].includes(r.state)), skuRows: 0 };
  } else note('stock summary', false, errText(sum));
  const sku = new Map(); let rows = 0;
  const ok = await pages(admin, '/inventory?limit=200', (items) => { for (const r of items) { rows++; if (!sku.has(r.locationId)) sku.set(r.locationId, new Map()); sku.get(r.locationId).set(r.sku, Number(r.available)); } }, { maxPages: 2000 });
  if (ok) { stock.sku = sku; S.stock && (S.stock.skuRows = rows); }
  stock.loaded = true;
  if (!quiet) log(`Stock: ${stock.numbers ? `${S.stock?.msisdnStandardFree} standard numbers free (${Object.entries(S.stock?.byTier ?? {}).map(([t, n]) => `${t} ${n}`).join(', ')})` : 'no number pool (plans get no number)'}; ${stock.imsi} IMSIs free; ${stock.whSims} physical SIMs in the warehouse; ${S.stock?.esimProfilesFree} eSIM profiles; ${rows} SKU rows at ${sku.size} locations.`);
}
/** Free physical SIMs at one store (up to 600 counted: more than enough to know the store can sell). */
async function loadStoreSims(stores) {
  await each('store SIM stock read', stores, async (st) => {
    let n = 0; await pages(admin, `/numbering/sims?locationId=${encodeURIComponent(st.id)}&state=AVAILABLE&kind=PHYSICAL&limit=200`, (items) => { n += items.length; return n < 600; }, { maxPages: 3 });
    stock.storeSims.set(st.id, n);
  });
}
const skuAvail = (loc, sku) => { const l = stock.learned.get(`${loc}|${sku}`); const k = stock.sku ? stock.sku.get(loc)?.get(sku) ?? 0 : Infinity; return l === undefined ? k : Math.min(l, k); };
const bumpSku = (loc, sku, d) => { const m = stock.sku?.get(loc); if (m && m.has(sku)) m.set(sku, m.get(sku) + d); const key = `${loc}|${sku}`; if (stock.learned.has(key)) stock.learned.set(key, Math.max(0, stock.learned.get(key) + d)); };

// ── staff for the work that needs a second person ──
const pw = () => `Lt-${randomBytes(9).toString('base64url')}-9a!`;
const made = [];
async function staffUser(username, roles, extra = {}) {
  const password = pw();
  let r = await admin.call('/users', 'POST', { username, displayName: `Load test ${roles[0]}`, roles, password, ...extra });
  let s;
  if (!r.ok) {   // left over from an earlier run: give it a new password
    const list = (await admin.call(`/users?q=${username}`)).json; const u = (list.items ?? []).find((x) => x.username === username);
    if (!u) throw new Error(`cannot create ${username}: ${JSON.stringify(r.json).slice(0, 150)}`);
    await admin.call(`/users/${u.id}`, 'PATCH', { status: 'ACTIVE', roles, ...extra });
    r = await admin.call(`/users/${u.id}/reset-password`, 'POST', {});
    const temp = r.json.temporaryPassword ?? r.json.password; if (!temp) throw new Error(`cannot reset ${username}`);
    const s1 = mkSession(username); await s1.login(username, temp);
    await s1.call('/auth/change-password', 'POST', { current: temp, next: password }); s = mkSession(username); await s.login(username, password); made.push(u.id);
  } else {
    s = mkSession(username);
    const first = await s.call('/auth/login', 'POST', { username, password });
    if (first.json?.user?.mustChangePassword) { const next = pw(); await s.call('/auth/change-password', 'POST', { current: password, next }); const s2 = mkSession(username); await s2.login(username, next); s = s2; }
    else { s.user = first.json.user; s.creds = { username, password }; }
    made.push(r.json.id);
  }
  return s;
}
const staff = { compliance: null, finance: null, agents: [] };
async function ensureStaff() {
  const need = (k) => !staff[k] || (Array.isArray(staff[k]) && !staff[k].length);
  if (has('kyc') && need('compliance')) staff.compliance = await staffUser('lt.compliance', ['compliance']);
  if ((has('billing') || has('payments')) && need('finance')) staff.finance = await staffUser('lt.finance', ['finance']);
  if ((has('care') || has('payments')) && need('agents')) for (let i = 1; i <= AGENT_USERS; i++) staff.agents.push(await staffUser(`lt.agent.${i}`, ['customer-service']));
}
const agentFor = (i) => staff.agents[i % staff.agents.length];

// ─────────────────────────── setup: dealers, stores, staff ───────────────────────────
async function setup() {
  startPhase('setup');
  const dealerNames = Array.from({ length: DEALERS }, (_, i) => i < 3 ? [`Metro Mobile Sdn Bhd [${TAG}]`, `Kedai Telefon Maju [${TAG}]`, `Northern Connect [${TAG}]`][i] : `${pick(COMPANIES)} Dealer ${i + 1} [${TAG}]`);
  await each('dealers', dealerNames, async (name) => {
    const d = await step('dealers', () => admin.call('/dealers', 'POST', { name, contactName: pick(FIRST), email: `${name.split(' ')[0].toLowerCase()}@example.com`.replace(/[^a-z0-9@.]/g, ''), phone: `+6012${between(1000000, 9999999)}` }));
    if (!d) return;
    for (let k = 0; k < AGENTS_PER_DEALER; k++) await step('dealer agents', () => admin.call(`/dealers/${d.json.id}/agents`, 'POST', { name: `${pick(FIRST)} ${pick(LAST)}`, email: `agent${k}.${d.json.id.slice(0, 4)}@example.com`.toLowerCase() }));
  });
  const newStores = [];
  await each('stores', Array.from({ length: NEW_STORES }, (_, i) => i), async (i) => {
    const [city] = pick(CITIES);
    const st = await step('stores created', () => admin.call('/stores', 'POST', { name: `${pick(['Mall', 'Plaza', 'Central', 'Point', 'Kiosk', 'Hub'])} ${city} ${i + 1} [${TAG}]`, address: `${between(1, 200)} Jalan ${pick(LAST)}, ${city}`, phone: `+603${between(10000000, 99999999)}` }));
    if (st) newStores.push(st.json);
  });
  // staff who work the channels: real accounts with passwords nobody knows (an admin can reset any of them), left active so the lists look lived in
  const bulkStaff = [
    ...Array.from({ length: CALLCENTRE }, (_, i) => ['lt.cc', i, ['call-center']]),
    ...Array.from({ length: TELESALES }, (_, i) => ['lt.ts', i, ['telesales']]),
    ...Array.from({ length: BACKOFFICE }, (_, i) => ['lt.bo', i, [['billing-ops'], ['inventory-ops'], ['customer-service'], ['revenue-assurance']][i % 4]]),
    ...newStores.map((st, i) => ['lt.st', i, ['retail-store'], st.id]),
  ];
  await each('staff', bulkStaff, async ([pre, i, roles, storeId]) => {
    const username = `${pre}${TAG.toLowerCase()}${String(i + 1).padStart(4, '0')}`;
    await step(`staff: ${roles[0]}`, () => admin.call('/users', 'POST', { username, displayName: `${pick(FIRST)} ${pick(LAST)} [${TAG}]`, roles, password: pw(), ...(storeId ? { storeId } : {}) }));
  });
}

// ─────────────────────────── customers ───────────────────────────
const usedIds = new Set(); const runSalt = Date.now().toString(36).slice(-3);
const nric = (i) => { let v; do { v = `${between(70, 99)}${String(between(1, 12)).padStart(2, '0')}${String(between(1, 28)).padStart(2, '0')}${between(10, 14)}${String(between(1000, 9999))}${TAG}${runSalt}${i}`; } while (usedIds.has(v)); usedIds.add(v); return v; };
async function newCustomer(i) {
  const company = !!companySeg && chance(0.15);
  const [city, postcode, state] = pick(CITIES);
  const first = pick(FIRST), last = pick(LAST);
  const name = company ? `${pick(COMPANIES)} ${between(1, 99)} [${TAG}]` : `${first} ${last} [${TAG}]`;
  const dob = `${between(1960, 2002)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`;
  const idType = company ? 'NATIONAL_ID' : pick(['NATIONAL_ID', 'NATIONAL_ID', 'NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENCE']);
  const kinds = company ? ['COMPANY_REGISTRATION', 'ID_FRONT', 'ID_BACK'] : idType === 'PASSPORT' ? ['ID_FRONT', 'SELFIE'] : ['ID_FRONT', 'ID_BACK', 'SELFIE'];
  const billCycleDay = pick(billDays);
  const body = {
    context: 'order', segment: company ? companySeg : individualSeg, displayName: name, idDocument: nric(i),
    email: `${first}.${last}.${runSalt}${i}@example.com`.toLowerCase().replace(/[^a-z0-9@.]/g, ''), phone: `+60${between(11, 19)}${between(1000000, 9999999)}`, dateOfBirth: dob, gender: pick(['FEMALE', 'MALE']),
    address: { line1: `${between(1, 99)} Jalan ${pick(LAST)}`, city, postcode, state, country: 'MY' },
    account: { billCycleDay },
    identity: { idType, idExpiry: idType === 'PASSPORT' || chance(0.5) ? `${between(2028, 2035)}-0${between(1, 9)}-15` : undefined, nationality: 'Malaysian', dateOfBirth: dob, documents: kinds.map((kind) => ({ kind, dataBase64: jpeg(), capture: capture() })) },
  };
  const r = await step('customers created', () => admin.call('/customers', 'POST', body));
  if (!r) return;
  S.customers.push(newCust({ id: r.json.customer.id, name, company, created: true, kycCase: r.json.kyc?.caseId, kycStatus: r.json.customer.kycStatus, accountId: r.json.account?.id ?? null, billCycleDay }));
}
const newCust = (c) => ({ company: false, created: false, kycCase: null, kycStatus: null, accountId: null, verified: c.kycStatus === 'VERIFIED', billCycleDay: null, ordersBefore: 0, orders: [], services: [], allServices: [], noService: false, ...c });
async function customersPhase() {
  startPhase('customers', N);
  await each('customers', Array.from({ length: N }, (_, i) => i), newCustomer);
  log(`Created ${S.customers.length} customers.`);
}

/** Adopts the customers already made under this tag (names end in “[TAG]”): pages of 100 in sequence, follow-ups per customer in parallel. */
let adopted = false;
async function adopt() {
  if (adopted || has('customers')) { adopted = true; return; }
  adopted = true;
  const found = [];
  startPhase('adopting customers');
  await pages(admin, '/customers?limit=200', (items) => { for (const x of items) if (String(x.displayName).endsWith(`[${TAG}]`)) found.push(newCust({ id: x.id, name: x.displayName, kycStatus: x.kycStatus, company: x.segment !== individualSeg })); prog.done = found.length; }, { maxPages: 100_000 });
  S.customers.push(...found);
  log(`Adopted ${found.length} customers tagged [${TAG}] (${found.filter((c) => c.verified).length} verified).`);
}
/** Existing order count per customer, so --orders N means N more (first page of 100 is enough to know a customer has history). */
async function readOrderHistory() {
  await each('order history read', S.customers, async (c) => { const r = await admin.call(`/orders?customerId=${c.id}&limit=100`); if (r.ok) c.ordersBefore = (r.json.items ?? []).length + (r.json.nextCursor ? 1 : 0); else note('order history read', false, errText(r)); });
  log(`${S.customers.filter((c) => c.ordersBefore).length} of ${S.customers.length} customers already have orders (${S.customers.reduce((n, c) => n + c.ordersBefore, 0)} counted).`);
}

// ─────────────────────────── identity reviews ───────────────────────────
async function kycPhase() {
  const todo = S.customers.filter((c) => /PENDING/.test(c.kycStatus ?? '') || c.kyc === 'PENDING');
  startPhase('kyc', todo.length);
  // customers adopted from the system have no case id yet: find them in the review queue
  const byCustomer = new Map(todo.map((c) => [c.id, c]));
  if (todo.some((c) => !c.kycCase)) await pages(staff.compliance, '/kyc/cases?status=PENDING&limit=100', (items) => { for (const k of items) { const c = byCustomer.get(k.customerId); if (c && !c.kycCase) c.kycCase = k.id; } }, { maxPages: 100_000 });
  await each('kyc', todo.filter((c) => c.kycCase), async (c) => {
    const roll = rnd();
    if (roll < 0.72) { const r = await step('kyc approved', () => staff.compliance.call(`/kyc/cases/${c.kycCase}/decision`, 'POST', { decision: 'APPROVE' })); if (r) { c.verified = true; c.kycStatus = 'VERIFIED'; } }
    else if (roll < 0.80) { if (await step('kyc rejected', () => staff.compliance.call(`/kyc/cases/${c.kycCase}/decision`, 'POST', { decision: 'REJECT', reason: pick(['The ID photo is cut off', 'Selfie does not match the ID', 'ID looks altered']), reasonCode: pick(['UNREADABLE', 'MISMATCH', 'SUSPECTED_FRAUD']) }))) c.kycStatus = 'REJECTED'; }
    else if (roll < 0.87) { if (await step('kyc sent back', () => staff.compliance.call(`/kyc/cases/${c.kycCase}/decision`, 'POST', { decision: 'RETURN', reason: 'Please retake the back of the ID in better light', reasonCode: 'UNREADABLE' }))) c.kycStatus = 'RETURNED'; }
    // the rest stay waiting, so the review queue has work in it
  });
}

// ─────────────────────────── order planning ───────────────────────────
const REMOTE = ['CALL_CENTER', 'TELESALES'];
const quickUsers = [];   // store-bound sessions for QUICK_SALE (a counter sale is rung up at the user's own store)
let planned = null;

/** For every sellable offer: which baskets (“shapes”) quote cleanly. Quotes change nothing, so this is safe in a dry run. */
let sellableCache = null;
const getSellable = async () => (sellableCache ??= await discoverOffers());
async function discoverOffers() {
  const sellable = new Map();
  const plainPlans = [];
  const quote = async (channel, lines, extra = {}) => admin.call('/orders/quote', 'POST', { channel, lines, ...extra }, {}, { idempotent: true });
  const ALLCH = [...REMOTE, 'RETAIL_ASSISTED', 'DEALER', 'QUICK_SALE'];
  const channelsOf = (...offers) => new Set(ALLCH.filter((ch) => offers.every((o) => !o.salesChannels?.length || o.salesChannels.includes(ch))));
  const remoteFor = (...offers) => { const ok = (ch) => offers.every((o) => !o.salesChannels?.length || o.salesChannels.includes(ch)); return [...REMOTE, 'DEALER', 'RETAIL_ASSISTED'].find(ok); };
  for (const o of catalog) S.offers.set(o.id, { offer: o, shapes: [], orders: 0, refused: 0, firstRefusal: null, blocked: null, whyNot: null, variantSold: {}, kindGroup: kindGroup(o), refusals: new Map() });
  // plain plans first: other offers attach to them
  await each('offer discovery (plans)', catalog.filter(isPlainPlan), async (o) => {
    const ch = remoteFor(o); if (!ch) return;
    const q = await quote(ch, [{ offerId: o.id }]);
    if (q.ok && !q.json.problems?.length) plainPlans.push(o);
  });
  const tryShape = async (st, problems, type, lines, extra = {}) => {
    const o = st.offer;
    const ch = remoteFor(o, ...(extra.plan ? [extra.plan] : [])); if (!ch) { problems.push(`${type}: no sales channel allows it`); return false; }
    const q = await quote(ch, lines, extra.quoteExtra ?? {});
    if (!q.ok) { problems.push(`${type}: ${errText(q)}`); return false; }
    if (q.json.problems?.length) { problems.push(`${type}: ${q.json.problems.join(' ')}`); return false; }
    const channels = channelsOf(o, ...(extra.plan ? [extra.plan] : []));
    if (type !== 'solo' || !(beh(o).outright && !o.contract?.termMonths && !needsSimOffer(o) && !o.fulfilment?.requiresInstallation)) channels.delete('QUICK_SALE');
    st.shapes.push({ type, plans: extra.cands ?? (extra.plan ? [extra.plan] : []), dead: false, needsDelivery: !!q.json.needs?.delivery, deliveryMethods: q.json.deliveryMethods ?? [], installation: !!q.json.needs?.installation, term: extra.term, channels });
    return true;
  };
  const baseOf = (o) => ({ offerId: o.id, ...(o.variants?.[0] ? { options: { variantId: o.variants[0].id } } : {}) });
  const problemsOf = new Map();
  // pass 1: each offer on its own (group plans with one member)
  await each('offer discovery', catalog, async (o) => {
    const st = S.offers.get(o.id); const problems = []; problemsOf.set(o.id, problems);
    if (isGroup(o)) {
      const allowed = o.group.allowedMemberOfferIds?.length ? o.group.allowedMemberOfferIds : [];
      const cands = (allowed.length ? allowed.map((id) => catalog.find((x) => x.id === id)).filter(Boolean) : plainPlans);
      const member = cands.find((m) => plainPlans.includes(m)) ?? cands[0];
      if (member) await tryShape(st, problems, 'members', [{ offerId: o.id, members: [{ offerId: member.id }] }], { plan: member, cands: cands.filter((m) => plainPlans.includes(m) || !plainPlans.length) });
      else problems.push('members: no member plan is sellable');
    } else await tryShape(st, problems, 'solo', [baseOf(o)]);
  });
  const soloOk = catalog.filter((o) => S.offers.get(o.id).shapes.some((x) => x.type === 'solo'));
  // pass 2: offers that need something else in the basket (an add-on needs a plan, a device-care plan needs a device), and devices on a contract
  await each('offer discovery (combinations)', catalog.filter((o) => !isGroup(o)), async (o) => {
    const st = S.offers.get(o.id); const problems = problemsOf.get(o.id); const needs = o.requires ?? [];
    if (!st.shapes.length || needs.length) {
      const pool = needs.length ? soloOk.filter((p) => needs.every((t) => satisfies(t, p))) : plainPlans;
      const ok = pool.filter((p) => p.id !== o.id && !(o.excludes ?? []).includes(p.id) && !(p.excludes ?? []).includes(o.id));
      for (const p of ok.slice(0, 3)) if (await tryShape(st, problems, 'with-plan', [baseOf(p), baseOf(o)], { plan: p, cands: ok })) break;
    }
    if ((o.deals ?? []).length && !isPlainPlan(o) && plainPlans.length) {
      const ok = plainPlans.filter((x) => !(o.excludes ?? []).includes(x.id) && !x.salesChannels?.length);
      const p = ok[0] ?? plainPlans[0]; const cands = ok.length ? ok : [p];
      const term = o.deals[0].termMonths; const line = { ...baseOf(o), attachTo: 0, dealTermMonths: term };
      await tryShape(st, problems, 'attached-financed', [{ offerId: p.id }, line], { plan: p, cands, term });
      await tryShape(st, problems, 'attached-payinfull', [{ offerId: p.id }, line], { plan: p, cands, term, quoteExtra: { financing: { payInFull: true } } });
    }
  });
  for (const o of catalog) { const st = S.offers.get(o.id); if (!st.shapes.length) st.whyNot = problemsOf.get(o.id).join(' | ').slice(0, 400) || 'no basket could be quoted'; else sellable.set(o.id, st); }
  S.plainPlans = plainPlans;
  const by = {}; for (const st of sellable.values()) by[st.kindGroup] = (by[st.kindGroup] ?? 0) + 1;
  log(`Sellable: ${sellable.size} of ${catalog.length} offers (${Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ')}); ${plainPlans.length} plain plans.`);
  for (const st of S.offers.values()) if (!st.shapes.length) log(`  cannot be sold: ${st.offer.name} (${st.offer.kind}): ${st.whyNot}`);
  return sellable;
}

function stockReport(sellable) {
  // plan share: lines that need a number per order, estimated from what the catalog offers
  const needs = estimateNeeds({ orders: ORDERS, planShare: 0.8, esimShare: ESIM_SHARE });
  S.needs = { ...needs, orders: ORDERS };
  const free = { msisdn: stock.msisdn, physical: stock.whSims + [...stock.storeSims.values()].reduce((a, b) => a + b, 0), esims: stock.esim, imsi: stock.imsi };
  log(`Estimated need for ${ORDERS} orders: ~${needs.planLines} plan lines = ${needs.msisdn} numbers, ~${needs.physical} physical SIMs, ~${needs.esims} eSIM profiles (and as many IMSIs).`);
  const warn = [];
  if (stock.numbers && free.msisdn < needs.msisdn) warn.push(`NUMBERS: ${needs.msisdn} needed, ${free.msisdn} standard numbers free`);
  if (free.physical < needs.physical) warn.push(`PHYSICAL SIMs: ~${needs.physical} needed, ${free.physical} free in the warehouse and counted stores`);
  if (free.esims < needs.esims) warn.push(`eSIM PROFILES: ~${needs.esims} needed, ${free.esims} usable (limited by free IMSIs ${free.imsi})`);
  if (warn.length) { log('!!! WARNING: the target needs more stock than is free. Load more with scripts/load-test/load-pools.mjs, or the run will stop selling the lines that run out:'); for (const w of warn) log(`!!!   ${w}`); S.needs.warnings = warn; }
  else log('Stock covers the estimate.');
}

/** Learns from a refused order; returns what the caller should change. */
function learn(job, lines, r) {
  const msg = r.json?.error?.message ?? JSON.stringify(r.json).slice(0, 200);
  const c = classifyRefusal(msg);
  const offers = [...new Set(lines.map((l) => l.offerId))].map((id) => S.offers.get(id)).filter(Boolean);
  const mainOffer = S.offers.get(job.target);
  for (const o of offers) { o.refused++; if (!o.firstRefusal) o.firstRefusal = `${job.channel}: ${msg}`.slice(0, 300); }
  const block = (o, reason, ms = 15 * 60_000) => { if (o && !(o.blocked && o.blocked.until > Date.now() + ms)) { o.blocked = { until: ms === Infinity ? Infinity : Date.now() + ms, reason }; S.blockedNotes.push(`${o.offer.name}: ${reason}`.slice(0, 220)); if (S.blockedNotes.length > 60) S.blockedNotes.shift(); log(`  ! pausing ${o.offer.name}: ${reason}`); } };
  switch (c.kind) {
    case 'sku': {
      stock.learned.set(`${c.location}|${c.sku}`, Math.max(0, c.available));
      for (const l of lines) { const o = S.offers.get(l.offerId); if (o && !skusOf(o.offer, l.options?.variantId).includes(c.sku)) (o.extraSkus ??= new Set()).add(c.sku); }
      break;
    }
    case 'store-sims': stock.storeSims.set(job.storeId, 0); break;
    case 'warehouse-sims': stock.whSims = 0; log('  ! no physical SIMs left in the warehouse: remote channels sell eSIM only'); break;
    case 'esims': stock.esim = 0; log('  ! no eSIM profiles (or IMSIs) left: selling physical SIMs only'); break;
    case 'msisdn': stock.msisdn = 0; log('  ! no standard numbers left: offers that need a number are paused until stock is loaded'); break;
    case 'requires': case 'excludes': { const sh = job.shape; if (sh) sh.dead = true; if (mainOffer && !mainOffer.shapes.some((s) => !s.dead)) block(mainOffer, msg.slice(0, 160), Infinity); break; }
    case 'channel': { const o = mainOffer; if (o) (o.badChannels ??= new Set()).add(job.channel); break; }
    case 'credit-check': { if (job.shape) job.shape.dead = true; break; }
    case 'kyc': job.customer.noService = true; break;
    default: {
      if (mainOffer) { const key = msg.replace(/[0-9a-f-]{20,}|\d+/g, '#').slice(0, 100); const n = (mainOffer.refusals.get(key) ?? 0) + 1; mainOffer.refusals.set(key, n); if (n >= 8 && mainOffer.orders === 0) block(mainOffer, `refused ${n} times: ${msg.slice(0, 120)}`); else if (n >= 25) block(mainOffer, `refused ${n} times: ${msg.slice(0, 120)}`, 5 * 60_000); }
      if (job.storeId) { const k = job.storeId; S.storeFail ??= new Map(); S.storeFail.set(k, (S.storeFail.get(k) ?? 0) + 1); }
    }
  }
  return c;
}

const offerBlocked = (st) => !!st.blocked && st.blocked.until > Date.now();
const kindWeight = { plan: 40, 'device + plan': 14, 'device (outright)': 8, fibre: 8, goods: 8, 'group plan': 5, 'add-on / service': 10 };
const goodsLoc = (job) => (job.channel === 'RETAIL_ASSISTED' || job.channel === 'QUICK_SALE' ? job.storeId : 'WH-MAIN');

/** Whether a mobile line could get its number and SIM at this place right now. */
function simFor(job) {
  const retail = job.channel === 'RETAIL_ASSISTED' || job.channel === 'QUICK_SALE';
  const physical = retail ? (stock.storeSims.get(job.storeId) ?? 0) > 0 : stock.whSims > 0;
  return chooseSim({ physical, esim: stock.esim > 0, esimShare: ESIM_SHARE }, rng);
}
const eligibleChannel = (st, sh, ch) => !st.badChannels?.has(ch) && sh.channels.has(ch);

/** A basket for the offer at this place, or null when stock there cannot cover it. Variants are chosen where the stock is. */
function basketFor(st, shape, job) {
  const o = st.offer; const lines = [];
  const loc = goodsLoc(job);
  const addVariant = (off, line) => {
    const vs = off.variants ?? []; if (!vs.length) return line;
    const avail = vs.filter((v) => skusOf(off, v.id).every((s) => skuAvail(loc, s) > 0));
    if (!avail.length) return null;
    const s2 = S.offers.get(off.id); const pickV = leastUsed(avail, new Map(Object.entries(s2.variantSold)), rng, (v) => v.id);
    return { ...line, options: { variantId: pickV.id } };
  };
  const needsStock = (off, variantId, q = 1) => skusOf(off, variantId).every((s) => skuAvail(loc, s) >= q) && [...(S.offers.get(off.id)?.extraSkus ?? [])].every((s) => skuAvail(loc, s) >= q);
  const mobile = (off) => needsSimOffer(off);
  if (shape.type === 'members') {
    const g = o.group; const allowed = (g.allowedMemberOfferIds?.length ? g.allowedMemberOfferIds : shape.plans.map((p) => p.id)).filter((id) => S.offers.get(id) && !offerBlocked(S.offers.get(id)));
    if (!allowed.length) return null;
    const members = Array.from({ length: Math.min(between(1, 3), g.maxGroupMembers ?? 3) }, () => { const sim = simFor(job); return sim ? { offerId: pick(allowed), simType: sim } : null; });
    if (members.some((m) => !m) || (stock.numbers && stock.msisdn < members.length)) return null;
    return { lines: [{ offerId: o.id, members }], numbers: members.length, sims: members.map((m) => m.simType) };
  }
  let main = { offerId: o.id };
  if (o.variants?.length) { main = addVariant(o, main); if (!main) return null; }
  else if (!needsSimOffer(o) && !o.fulfilment?.requiresInstallation && !(o.prices ?? []).some((p) => p.type === 'RECURRING')) main.quantity = chance(0.25) ? 2 : 1;
  if (shape.type === 'solo') lines.push(main);
  else {
    const p = pick(shape.plans.filter((x) => S.offers.get(x.id) && !offerBlocked(S.offers.get(x.id)) && (!x.salesChannels?.length || x.salesChannels.includes(job.channel)))); if (!p) return null;
    const comp = addVariant(p, { offerId: p.id }); if (!comp) return null;
    if (shape.type === 'with-plan') lines.push(comp, main); else lines.push(comp, { ...main, attachTo: 0, dealTermMonths: shape.term });
  }
  const sims = [];
  for (const l of lines) {
    const off = S.offers.get(l.offerId).offer; const q = l.quantity ?? 1;
    if (!needsStock(off, l.options?.variantId, q)) return null;
    if (mobile(off) && q === 1) { const sim = simFor(job); if (!sim) return null; l.simType = sim; sims.push(sim); }
  }
  const numbers = lines.filter((l) => beh(S.offers.get(l.offerId).offer).service === 'MOBILE' || mobile(S.offers.get(l.offerId).offer)).length;
  if (stock.numbers && numbers > 0 && stock.msisdn < numbers) return null;
  // sometimes an add-on rides along with a plan
  if (!job.noExtras && lines.some((l) => isPlainPlan(S.offers.get(l.offerId).offer)) && chance(0.2)) {
    const inBasket = lines.map((l) => S.offers.get(l.offerId).offer);
    const addons = [...S.offers.values()].filter((a) => a.offer.id !== o.id && !offerBlocked(a) && a.shapes.some((s) => !s.dead && s.type === 'solo') && !needsSimOffer(a.offer) && !a.offer.variants?.length && !a.offer.fulfilment?.requiresInstallation && !a.offer.fulfilment?.requiresShipping && (a.offer.prices ?? []).some((p) => p.type === 'RECURRING')
      && (a.offer.requires ?? []).every((t) => inBasket.some((b) => satisfies(t, b))) && !(a.offer.excludes ?? []).some((e) => inBasket.some((b) => b.id === e)) && !inBasket.some((b) => (b.excludes ?? []).includes(a.offer.id)) && !(a.badWith?.has(o.id)));
    const a = leastUsed(addons, new Map([...S.offers.entries()].map(([id, s]) => [id, s.orders])), rng, (x) => x.offer.id);
    if (a) lines.push({ offerId: a.offer.id });
  }
  return { lines, numbers, sims };
}

function chooseTarget(job, sellable) {
  const retail = job.channel === 'RETAIL_ASSISTED' || job.channel === 'QUICK_SALE';
  const cands = [];
  for (const st of sellable.values()) {
    if (offerBlocked(st)) continue;
    if (job.customer && job.customer.noService && (needsSimOffer(st.offer) || isGroup(st.offer))) continue;
    if (retail && !job.storeId) continue;
    for (const sh of st.shapes) if (!sh.dead && eligibleChannel(st, sh, job.channel)) cands.push({ st, sh });
  }
  if (!cands.length) return null;
  // half the time the least-sold offer (so every range gets orders), otherwise by how people really buy
  const sold = new Map(); for (const c of cands) sold.set(c.st.offer.id, c.st.orders);
  const feasible = (c) => basketFor(c.st, c.sh, job);
  for (let tries = 0; tries < 12; tries++) {
    let c;
    if (chance(0.55)) { const least = leastUsed([...new Set(cands.map((x) => x.st))], sold, rng, (s) => s.offer.id); c = pick(cands.filter((x) => x.st === least)); }
    else { const kinds = [...new Set(cands.map((x) => x.st.kindGroup))]; const k = rng.weighted(kinds.map((kk) => [kk, kindWeight[kk] ?? 5])); c = pick(cands.filter((x) => x.st.kindGroup === k)); }
    const b = feasible(c); if (b) return { ...c, basket: b };
  }
  return null;
}

function newJobPlan(sellable) {
  const verified = S.customers.filter((c) => c.verified);
  const pending = S.customers.filter((c) => !c.verified && c.kycStatus === 'PENDING_REVIEW');
  const pendingShare = 0.07;
  const total = ORDERS;
  const tickets = [];
  const vCounts = orderCounts(verified.length, Math.max(verified.length, Math.round(total * (pending.length ? 1 - pendingShare : 1))), rng);
  verified.forEach((c, i) => { for (let k = 0; k < vCounts[i]; k++) tickets.push(c); });
  const pCounts = orderCounts(pending.length, Math.round(total * pendingShare), rng);
  pending.forEach((c, i) => { for (let k = 0; k < Math.min(2, pCounts[i]); k++) tickets.push(c); });
  const order = shuffle(tickets);
  const coverage = shuffle([...S.stores.map((s) => ({ channel: 'RETAIL_ASSISTED', storeId: s.id })), ...S.dealers.flatMap((d) => d.agents.map((a) => ({ channel: 'DEALER', dealerId: d.id, agentId: a })))]);
  return { tickets: order, i: 0, coverage, used: { stores: new Map(), dealers: new Map(), agents: new Map() }, sellable };
}

function nextJob(plan, remaining) {
  const sellable = plan.sellable;
  let customer = plan.tickets[plan.i % Math.max(1, plan.tickets.length)]; plan.i++;
  if (!customer) return null;
  let place;
  if (plan.coverage.length && (chance(0.5) || plan.coverage.length >= remaining)) place = plan.coverage.pop();
  else {
    const channels = [['CALL_CENTER', 30], ['TELESALES', 15]];
    if (S.stores.length) channels.push(['RETAIL_ASSISTED', 28]);
    if (S.dealers.length) channels.push(['DEALER', 20]);
    if (quickUsers.length) channels.push(['QUICK_SALE', 4]);
    const channel = rng.weighted(channels);
    if (channel === 'RETAIL_ASSISTED') { const s = chance(0.7) ? leastUsed(S.stores.filter((x) => !S.failingStores.includes(x.id)), plan.used.stores, rng, (x) => x.id) : pick(S.stores); place = { channel, storeId: s.id }; }
    else if (channel === 'DEALER') { const d = chance(0.7) ? leastUsed(S.dealers, plan.used.dealers, rng, (x) => x.id) : pick(S.dealers); const a = leastUsed(d.agents, plan.used.agents, rng); place = { channel, dealerId: d.id, agentId: a }; }
    else if (channel === 'QUICK_SALE') { const u = pick(quickUsers); place = { channel, storeId: u.storeId, session: u.session }; }
    else place = { channel };
  }
  return { customer, ...place };
}

function noteSuccess(job, lines, order, basket) {
  S.orders.ok++; prog.done++;
  S.channelOrders[job.channel] = (S.channelOrders[job.channel] ?? 0) + 1;
  if (job.storeId) S.storeOrders.set(job.storeId, (S.storeOrders.get(job.storeId) ?? 0) + 1);
  if (job.dealerId) { S.dealerOrders.set(job.dealerId, (S.dealerOrders.get(job.dealerId) ?? 0) + 1); S.agentOrders.set(job.agentId, (S.agentOrders.get(job.agentId) ?? 0) + 1); }
  for (const id of new Set(lines.flatMap((l) => [l.offerId, ...(l.members ?? []).map((m) => m.offerId)]))) {
    const st = S.offers.get(id); if (!st) continue; st.orders++; S.kindOrders[st.kindGroup] = (S.kindOrders[st.kindGroup] ?? 0) + 1;
  }
  for (const l of lines) { const st = S.offers.get(l.offerId); if (st && l.options?.variantId) st.variantSold[l.options.variantId] = (st.variantSold[l.options.variantId] ?? 0) + 1; }
  // local stock bookkeeping
  const loc = goodsLoc(job);
  for (const l of lines) { const st = S.offers.get(l.offerId); if (!st) continue; for (const s of skusOf(st.offer, l.options?.variantId)) bumpSku(loc, s, -(l.quantity ?? 1)); }
  const retail = job.channel === 'RETAIL_ASSISTED' || job.channel === 'QUICK_SALE';
  for (const t of basket.sims) { if (t === 'ESIM') { stock.esim--; stock.imsi--; } else if (retail) stock.storeSims.set(job.storeId, (stock.storeSims.get(job.storeId) ?? 1) - 1); else stock.whSims--; }
  if (stock.numbers && Number.isFinite(stock.msisdn)) stock.msisdn -= basket.numbers;
  if (job.customer) { job.customer.orders.push(order.id); if (!job.customer.verified && /PENDING/.test(job.customer.kycStatus ?? '') && order.pendingTasks?.length) S.orders.held++; }
  S.orderIds.push({ id: order.id, state: order.state });
}

async function submitOrder(sess, body, key) {
  let r = await sess.call('/orders', 'POST', body, { 'idempotency-key': key });
  // an unclear outcome (timeout, server error, “already being processed”): ask again with the SAME key; the server returns the order if the first try made it
  for (let k = 0; k < 3 && !r.ok && (r.status === 0 || r.status >= 500 || (r.status === 409 && /already being processed/i.test(JSON.stringify(r.json)))); k++) { await sleep(1500 * (k + 1)); r = await sess.call('/orders', 'POST', body, { 'idempotency-key': key }); }
  return r;
}
const pickMethod = () => pick(['CASH', 'CASH', 'QR', 'CREDIT_CARD']);

/** Places one order for the job (up to three baskets when the first is refused for a reason that can be worked around). Returns true when an order was created. */
async function placeJob(job, sellable, budget) {
  for (let tries = 0; tries < 3; tries++) {
    if (budget.attempts >= budget.cap) return false;
    const t = job.forcedTarget ? { ...job.forcedTarget, basket: job.forcedTarget.basket ?? basketFor(job.forcedTarget.st, job.forcedTarget.sh, job) } : chooseTarget(job, sellable);
    if (!t || !t.basket) { note('orders skipped (no basket fits)', false, `${job.channel}${job.storeId ? ' ' + job.storeId : ''}: nothing sellable with the stock there`); if (job.storeId && !job.forcedTarget) { S.storeFail ??= new Map(); S.storeFail.set(job.storeId, (S.storeFail.get(job.storeId) ?? 0) + 1); } return false; }
    const { st, sh, basket } = t; job.target = st.offer.id; job.shape = sh;
    const lines = basket.lines;
    const body = { ...(job.customer ? { customerId: job.customer.id, ...(job.customer.accountId ? { accountId: job.customer.accountId } : {}) } : {}), channel: job.channel, lines, payment: { method: pickMethod(), reference: `${TAG}-${randomBytes(3).toString('hex')}`, confirmed: true } };
    if (job.channel === 'RETAIL_ASSISTED') body.storeId = job.storeId;
    if (job.channel === 'DEALER') { body.dealerId = job.dealerId; body.dealerAgentId = job.agentId; }
    const retail = job.channel === 'RETAIL_ASSISTED' || job.channel === 'QUICK_SALE';
    if (sh.needsDelivery && !retail) {
      body.deliveryAddress = `${between(1, 99)} Jalan ${pick(LAST)}, ${pick(CITIES)[0]}`;
      if (!sh.deliveryMethods.includes('SHIP') && sh.deliveryMethods.includes('COLLECT')) {
        const skus = lines.flatMap((l) => skusOf(S.offers.get(l.offerId).offer, l.options?.variantId));
        const store = S.stores.find((s) => skus.every((k) => skuAvail(s.id, k) > 0)) ?? S.stores[0];
        body.delivery = { method: 'COLLECT', pickupStoreId: store?.id };
      }
    }
    if (sh.installation) { body.installationSlot = futureDate(between(3, 20)); body.deliveryAddress ??= `${between(1, 99)} Jalan ${pick(LAST)}, ${pick(CITIES)[0]}`; }
    if (sh.type === 'attached-payinfull') body.financing = { payInFull: true };
    budget.attempts++; S.orders.attempts++;
    const r = await submitOrder(job.session ?? admin, body, randomUUID());
    if (r.ok && r.json?.id) {
      note('orders placed', true); if (r.replay) S.orders.replays++;
      noteSuccess(job, lines, r.json, basket); return true;
    }
    note('orders placed', false, errText(r));
    const c = learn(job, lines, r);
    if (job.storeId && c.kind === 'other') { const n = S.storeFail?.get(job.storeId) ?? 0; if (n >= 12 && !S.storeOrders.get(job.storeId) && !S.failingStores.includes(job.storeId)) { S.failingStores.push(job.storeId); log(`  ! store ${job.storeId} refuses every order; leaving it out`); } }
    if (job.forcedTarget || !['sku', 'store-sims', 'warehouse-sims', 'esims', 'msisdn', 'requires', 'excludes', 'channel', 'credit-check', 'kyc'].includes(c.kind)) return false;   // a refusal that a different basket can get around: try again
  }
  return false;
}

async function ordersPhase() {
  startPhase('orders', ORDERS);
  await loadCatalog();
  await discoverStoresAndDealers();
  const sellable = await getSellable();
  await loadStock();
  await loadStoreSims(S.stores);
  stockReport(sellable);
  if (!ORDERS) { log('No orders requested (--orders 0).'); return; }
  if (!S.customers.length) { log('No customers to sell to.'); return; }
  if (has('customers') === false) await readOrderHistory();
  // store users for counter sales
  const qs = COUNT('quicksale-stores', 5);
  if (!DRY && qs && S.stores.length && [...sellable.values()].some((st) => st.shapes.some((s) => s.type === 'solo' && s.channels.has('QUICK_SALE')))) {
    for (const st of S.stores.slice(0, qs)) {
      try { quickUsers.push({ storeId: st.id, session: await staffUser(`lt.qs.${st.id.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 40), ['retail-store'], { storeId: st.id }) }); } catch (e) { note('quick-sale users', false, e.message); }
    }
    if (quickUsers.length) log(`${quickUsers.length} counter users ready for quick sales.`);
  }
  planned = newJobPlan(sellable);
  const budget = { attempts: 0, cap: Math.ceil(ORDERS * 1.6) };
  let inflight = 0, stalled = 0;
  setTotal(ORDERS);
  const worker = async () => {
    for (;;) {
      if (budget.attempts >= budget.cap) return;
      if (S.orders.ok + inflight >= ORDERS) { if (!inflight) return; await sleep(25); continue; }
      const job = nextJob(planned, ORDERS - S.orders.ok);
      if (!job) return;
      if (job.channel === 'QUICK_SALE') job.customer = null;
      inflight++;
      try { await placeJob(job, sellable, budget); } catch (e) { note('orders placed', false, `unexpected: ${e.message}`.slice(0, 160)); } finally { inflight--; }
      if (S.orders.ok === 0 && budget.attempts > 60 + ORDERS * 0.02) { stalled++; if (stalled === 1) log('  ! 60 attempts without one order: check the report’s first refusals (stock?)'); }
    }
  };
  // numbers and SIM counts may change under us (another operator loading pools): re-read now and then
  const refresher = setInterval(() => { loadStock({ quiet: true }).catch(() => {}); }, 5 * 60_000); refresher.unref();
  await Promise.all(Array.from({ length: CONC }, worker));
  clearInterval(refresher);
  log(`Orders: ${S.orders.ok} placed in ${S.orders.attempts} attempts (${S.orders.held} waiting on identity checks, ${S.orders.replays} repeats answered from the idempotency key).`);
  if (S.orders.ok < ORDERS) log(`!!! Only ${S.orders.ok} of ${ORDERS} orders could be placed. See the refusals below and the stock figures above.`);
  // order lifecycle: some cancelled, returns left alone
  const toCancel = S.orderIds.filter((o) => !['COMPLETED', 'CANCELLED', 'FAILED'].includes(o.state) && chance(0.15)).map((o) => o.id);   // an order that is already live cannot be cancelled
  await each('orders cancelled', toCancel, async (id) => { const r = await step('orders cancelled', () => admin.call(`/orders/${id}/actions`, 'POST', { type: 'cancel', reason: pick(['Customer changed their mind', 'Found a better offer', 'Ordered by mistake']) }, {}, { idempotent: false })); if (r) S.orders.cancelled++; });
}

// ─────────────────────────── services ───────────────────────────
let servicesRead = false;
async function readServices() {
  if (servicesRead) return; servicesRead = true;
  const withOrders = S.customers.filter((c) => c.orders.length || c.ordersBefore || !has('orders'));
  await each('services read', withOrders, async (c) => {
    const items = []; await pages(admin, `/services?customerId=${c.id}&limit=100`, (xs) => { items.push(...xs); }, { maxPages: 5 });
    c.allServices = items; c.services = items.filter((x) => x.status !== 'TERMINATED'); if (!c.accountId && c.services[0]) c.accountId = c.services[0].accountId;
  });
  const withSvc = S.customers.filter((c) => c.services.length);
  log(`${withSvc.length} customers have a live service.`);
}

// ─────────────────────────── service changes and groups ───────────────────────────
async function changesPhase() {
  startPhase('changes');
  await loadCatalog();
  await readServices();
  const plans = catalog.filter(isPlainPlan), groupPlans = catalog.filter(isGroup);
  const withSvc = S.customers.filter((c) => c.services.length);
  // aim for a share of customers with a changed service; customers who already have one (an earlier run) count towards it
  const changed = withSvc.filter((c) => c.allServices.some((s) => s.status !== 'ACTIVE' || s.status === 'TERMINATED'));
  const target = Math.round(withSvc.length * 0.45), todo = shuffle(withSvc.filter((c) => !changed.includes(c))).slice(0, Math.max(0, target - changed.length));
  setTotal(todo.length);
  await each('service changes', todo, async (c) => {
    const s = c.services.find((x) => x.type === 'MOBILE' && x.status === 'ACTIVE'); if (!s) return;
    const roll = rnd() * 0.45;
    if (roll < 0.12) { const r = await step('services suspended', () => admin.call(`/services/${s.id}/actions`, 'POST', { action: 'suspend', reason: pick(['LOST_STOLEN', 'FRAUD_SUSPECTED', 'CUSTOMER_REQUEST']) })); if (r && chance(0.6)) await step('services resumed', () => admin.call(`/services/${s.id}/actions`, 'POST', { action: 'resume' })); }
    else if (roll < 0.20) await step('voluntary suspensions', () => admin.call(`/services/${s.id}/actions`, 'POST', { action: 'suspend-voluntary', months: between(1, 6) }));
    else if (roll < 0.34 && plans.length > 1) { const to = pick(plans.filter((p) => p.id !== s.offerId)); if (to) await step('plan changes', () => admin.call(`/services/${s.id}/change-plan`, 'POST', { targetOfferId: to.id, effective: pick(['IMMEDIATE', 'NEXT_BILL_CYCLE']), acceptContractTerms: true })); }
    else if (roll < 0.40 && groupPlans.length) await step('moved to a group plan', () => admin.call(`/services/${s.id}/upgrade-to-group`, 'POST', { offerId: pick(groupPlans).id }));
    else if (roll < 0.45) await step('services terminated', () => admin.call(`/services/${s.id}/actions`, 'POST', { action: 'terminate', reason: 'Customer left the operator' }));
  });
  // group plans with members, ordered as a family
  const families = Math.min(COUNT('groups', Math.max(6, Math.round(S.customers.filter((c) => c.verified).length * 0.015))), 150);
  if (groupPlans.length && plans.length && families) {
    startPhase('family orders', families);
    if (!S.stores.length && !S.dealers.length) await discoverStoresAndDealers();
    const sellable = await getSellable(); await loadStock({ quiet: true });
    const gp = [...sellable.values()].filter((s) => isGroup(s.offer));
    const buyers = shuffle(S.customers.filter((c) => c.verified)).slice(0, families);
    const budget = { attempts: 0, cap: families * 2 };
    await each('family orders', buyers, async (c) => {
      const job = { customer: c, channel: pick(REMOTE) }; const st = pick(gp); const sh = st.shapes.find((s) => !s.dead); if (!sh) return;
      job.forcedTarget = { st, sh };
      const ok = await placeJob(job, sellable, budget); if (ok) note('family orders', true); else note('family orders', false, 'not placed');
    });
  }
}

// ─────────────────────────── interactions and cases ───────────────────────────
async function carePhase() {
  startPhase('care');
  await readServices();
  const customers = S.customers; if (!customers.length) { log('No customers for interactions and cases.'); return; }
  const nInter = args.interactions !== undefined ? COUNT('interactions', 0) : Math.round(customers.length * 1.2);
  const nCases = args.cases !== undefined ? COUNT('cases', 0) : Math.min(3000, Math.round(customers.length * 0.3));
  const meta2 = (await admin.call('/cases/meta')).json;
  const leaves = []; const walk = (nodes) => { for (const n of nodes ?? []) { if (n.caseType && n.active !== false) leaves.push(n); walk(n.children); } }; walk(meta2.taxonomy);
  log(`Care: ${nInter} interactions, ${nCases} cases over ${leaves.length} issue types (${[...new Set(leaves.map((l) => l.caseType))].join(', ')}).`);
  const channels = meta2.channels?.length ? meta2.channels : ['CALL_CENTER', 'WHATSAPP', 'EMAIL', 'IN_STORE', 'MOBILE_APP', 'WEB_SELF_SERVE'];
  // every customer is reached before any is reached twice
  const spread = (n) => { const out = []; while (out.length < n) out.push(...shuffle(customers)); return out.slice(0, n); };
  const interactionIds = [];
  startPhase('interactions', nInter);
  await each('interactions', spread(nInter).map((c, i) => [c, i]), async ([c, i]) => {
    const r = await step('interactions logged', () => agentFor(i).call('/interactions', 'POST', { customerId: c.id, channel: pick(channels), direction: pick(['INBOUND', 'INBOUND', 'OUTBOUND']), subject: pick(INTERACTIONS), summary: 'Logged by the load test.', durationSec: between(30, 900), occurredAt: iso(between(0, 60)), ...(c.services[0] && chance(0.4) ? { serviceId: c.services[0].id } : {}) }));
    if (r) interactionIds.push({ id: r.json.id, customerId: c.id });
  });
  startPhase('cases', nCases);
  const cases = [];
  const withSvc = customers.filter((c) => c.services.length);
  const caseOwners = spread(nCases);
  const types = leaves.length ? leaves : [{ id: undefined, caseType: 'GENERAL' }];
  const k = (arr, i) => arr[i % arr.length];
  const typeOrder = shuffle(types);
  const fromInter = new Set(shuffle(Array.from({ length: nCases }, (_, i) => i)).slice(0, Math.round(nCases * 0.08)));
  await each('cases', caseOwners.map((c, i) => [c, i]), async ([c0, i]) => {
    const c = chance(0.6) && withSvc.length ? k(withSvc, i) : c0;
    const it = k(typeOrder, i); const type = it.caseType ?? 'GENERAL'; const ag = agentFor(i);
    const sev = chance(0.15) ? 'CRITICAL_OUTAGE' : chance(0.3) ? 'MAJOR_DEGRADATION' : 'MINOR_INQUIRY';
    const common = { subject: pick(SUBJECTS[type] ?? SUBJECTS.GENERAL), severity: sev, note: 'Opened by the load test.' };
    let r;
    if (fromInter.has(i) && interactionIds.length) { const it2 = interactionIds[i % interactionIds.length]; r = await step('cases from interactions', () => ag.call(`/interactions/${it2.id}/case`, 'POST', { ...common, ...(it.id ? { issueTypeId: it.id } : {}) })); if (r) c.caseCustomer = it2.customerId; }
    else r = await step('cases opened', () => ag.call('/cases', 'POST', { customerId: c.id, ...(c.services[0] && chance(0.5) ? { serviceId: c.services[0].id } : {}), ...(it.id ? { issueTypeId: it.id } : { type }), ...common, priority: pick(['LOW', 'NORMAL', 'NORMAL', 'HIGH', 'URGENT']), channel: pick(['CALL_CENTER', 'WHATSAPP', 'EMAIL']) }));
    if (!r) return;
    const id = r.json.id ?? r.json.case?.id; if (!id) return;
    const k2 = { id, customerId: r.json.customerId ?? c.id, type: r.json.type ?? type };
    cases.push(k2); S.care[k2.type] = (S.care[k2.type] ?? 0) + 1;
    const roll = rnd();
    await step('cases assigned', () => ag.call(`/cases/${id}/assign`, 'POST', { assignee: `lt.agent.${(i % AGENT_USERS) + 1}` }));
    for (let n = 0; n < between(1, 3); n++) await step('case notes', () => ag.call(`/cases/${id}/notes`, 'POST', { text: pick(['Called the customer, no answer.', 'Checked the network: no outage in the area.', 'Waiting for the customer to send a photo.', 'Escalated to the second line.', 'Customer confirmed the details by phone.']) }));
    if (chance(0.12)) await step('cases escalated', () => ag.call(`/cases/${id}/severity`, 'POST', { severity: 'CRITICAL_OUTAGE', why: 'Escalated by the load test' }));
    const path = roll < 0.12 || k2.type === 'BILLING_REFUND' && roll < 0.5 ? [] : roll < 0.3 ? ['IN_PROGRESS'] : roll < 0.45 ? ['IN_PROGRESS', 'PENDING_CUSTOMER'] : roll < 0.55 ? ['IN_PROGRESS', 'PENDING_CUSTOMER', 'IN_PROGRESS', 'RESOLVED'] : roll < 0.8 ? ['IN_PROGRESS', 'RESOLVED'] : roll < 0.93 ? ['IN_PROGRESS', 'RESOLVED', 'CLOSED_VERIFIED'] : ['IN_PROGRESS', 'RESOLVED', 'REOPENED'];
    for (const st of path) { const ok = await step('case status changes', () => ag.call(`/cases/${id}/status`, 'POST', { status: st, note: 'Updated by the load test.', ...(st === 'RESOLVED' ? { resolution: 'Resolved after checking with the customer.' } : {}) })); if (!ok) break; }
  });
  S.cases = cases;
  S.care.total = cases.length; S.care.interactions = interactionIds.length;
}

// ─────────────────────────── billing ───────────────────────────
async function billingPhase() {
  startPhase('billing');
  await readServices();
  const accountIds = [...new Set(S.customers.filter((c) => c.services.length && c.accountId).map((c) => c.accountId))];
  if (!accountIds.length) { log('No accounts with a live service to bill.'); return; }
  const parts = chunks(accountIds, BILL_CHUNK);
  log(`Billing ${accountIds.length} accounts in ${parts.length} selective runs of up to ${BILL_CHUNK}.`);
  setTotal(parts.length);
  const asOf = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const WAITING = new Set(['MOCK_RUNNING', 'PRODUCTION_RUNNING']);
  const waitRun = async (id, done, label) => {
    for (let i = 0; i < 900; i++) {   // up to about 20 seconds of work per call
      const w = await admin.call(`/billing/runs/${id}/work`, 'POST', undefined, {}, { idempotent: true });
      if (!w.ok) { note(`bill run work (${label})`, false, errText(w)); await sleep(2000); continue; }
      if (done.includes(w.json.status)) return w.json;
      if (!WAITING.has(w.json.status) && !w.json.busy && !done.includes(w.json.status)) return w.json;
      if (w.json.busy) await sleep(1500);
    }
    return null;
  };
  for (const [i, ids] of parts.entries()) {
    const run = await step('bill runs created', () => admin.call('/billing/runs', 'POST', { accountIds: ids, asOf, note: `${TAG} load test ${i + 1}/${parts.length}` }));
    if (!run) { prog.done++; continue; }
    const id = run.json.id ?? run.json.run?.id;
    const mock = await waitRun(id, ['MOCK_COMPLETED', 'PENDING_APPROVAL', 'APPROVED', 'COMPLETED', 'FAILED', 'CANCELLED'], 'mock');
    if (mock?.status === 'MOCK_COMPLETED') await step('bill runs submitted', () => admin.call(`/billing/runs/${id}/submit`, 'POST', { note: 'Load test' }));
    const ap = await step('bill runs approved', () => staff.finance.call(`/billing/runs/${id}/approve`, 'POST', { note: 'Load test', execute: true }));
    let fin = null;
    if (ap) fin = await waitRun(id, ['COMPLETED', 'FAILED', 'CANCELLED'], 'production');
    const detail = (await admin.call(`/billing/runs/${id}`)).json;
    const row = { id, accounts: ids.length, status: detail.status, counts: detail.counts, summary: detail.summary?.totals ?? detail.summary };
    S.billing.runs.push(row); prog.done++;
    log(`  bill run ${i + 1}/${parts.length} ${id}: ${detail.status} ${JSON.stringify(detail.counts ?? {})}`);
    writeReport(false);
    void fin;
  }
  // a cycle run: bills every active account on that cycle day, so only on request
  if (args['cycle-run']) {
    const byDay = new Map(); for (const c of S.customers) if (c.billCycleDay && c.services.length) byDay.set(c.billCycleDay, (byDay.get(c.billCycleDay) ?? 0) + 1);
    const day = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const cycles = (await admin.call('/billing/cycles')).json.items ?? [];
    const cfg = cycles.find((c) => c.cycleDay === day || c.day === day);
    if (!day) log('Cycle run: no load-test accounts with a known bill cycle day (customers made in an earlier run are not asked).');
    else if (cfg && cfg.enabled === false) log(`Cycle run: bill cycle ${day} is switched off.`);
    else {
      const run = await step('bill cycle runs created', () => admin.call('/billing/runs', 'POST', { cycleDay: day, note: `${TAG} load test cycle ${day}` }));
      if (run) {
        const id = run.json.id; const mock = await waitRun(id, ['MOCK_COMPLETED', 'PENDING_APPROVAL', 'APPROVED', 'COMPLETED', 'FAILED', 'CANCELLED'], 'cycle mock');
        if (mock?.status === 'MOCK_COMPLETED') await step('bill runs submitted', () => admin.call(`/billing/runs/${id}/submit`, 'POST', { note: 'Load test' }));
        const ap = await step('bill runs approved', () => staff.finance.call(`/billing/runs/${id}/approve`, 'POST', { note: 'Load test', execute: true }));
        if (ap) await waitRun(id, ['COMPLETED', 'FAILED', 'CANCELLED'], 'cycle production');
        const d = (await admin.call(`/billing/runs/${id}`)).json; S.billing.cycleRun = { id, cycleDay: day, status: d.status, counts: d.counts }; log(`  cycle run for day ${day}: ${d.status} ${JSON.stringify(d.counts ?? {})}`);
      }
    }
  }
}

// ─────────────────────────── payments, credits, refunds ───────────────────────────
async function paymentsPhase() {
  startPhase('payments');
  await readServices();
  const owners = S.customers.filter((c) => c.accountId);
  const invoices = [];
  await each('invoices read', owners, async (c) => { await pages(admin, `/invoices?customerId=${c.id}&limit=100`, (xs) => { for (const inv of xs) invoices.push({ ...inv, customerId: c.id }); }, { maxPages: 5 }); });
  S.billing.invoicesRead = invoices.length;
  const open = invoices.filter((i) => i.status !== 'VOID' && i.status !== 'PAID' && ((i.balanceMinor ?? i.totalMinor) > 0));
  log(`${invoices.length} invoices exist for these customers; ${open.length} are open.`);
  const creditCap = Math.min(500, Math.ceil(open.length * 0.08)); let credits = 0;
  setTotal(open.length);
  await each('payments', open.map((inv) => [inv, rnd()]), async ([inv, roll]) => {
    const bal = inv.balanceMinor ?? inv.totalMinor; const ref = () => `${TAG}-${randomBytes(3).toString('hex')}`;
    const pay = (amountMinor) => admin.call(`/invoices/${inv.id}/pay`, 'POST', { ...(amountMinor ? { amountMinor } : {}), method: pick(['CASH', 'QR', 'CREDIT_CARD']), reference: ref(), idempotencyKey: randomUUID() }, {}, { idempotent: true });
    if (roll < 0.55) await step('invoices paid', () => pay());
    else if (roll < 0.68 && bal > 200) await step('part payments', () => pay(Math.floor(bal / 2)));
    else if (roll < 0.76 && bal > 500 && credits < creditCap) { credits++; await step('credit notes', () => admin.call(`/invoices/${inv.id}/credit`, 'POST', { amountMinor: Math.min(bal, between(100, 500)), reason: 'Goodwill credit after a complaint' })); }
  });
  // refund requests on billing cases, decided by an administrator (a different person from the requester)
  let cases = S.cases ?? [];
  if (!cases.length) {
    const owned = new Map(S.customers.map((c) => [c.id, c])); cases = [];
    await pages(admin, '/cases?type=BILLING_REFUND&limit=100', (items) => { for (const k of items) if (owned.has(k.customerId) && !/CLOSED/.test(k.status ?? '')) cases.push({ id: k.id, customerId: k.customerId, type: 'BILLING_REFUND' }); }, { maxPages: 200 });
  }
  const billingCases = cases.filter((x) => x.id && x.type === 'BILLING_REFUND').slice(0, 400);
  const byCustomer = new Map(); for (const i of invoices) if (!byCustomer.has(i.customerId)) byCustomer.set(i.customerId, i);
  startPhase('refunds', billingCases.length);
  await each('refunds', billingCases.map((k, i) => [k, i]), async ([k, i]) => {
    const inv = byCustomer.get(k.customerId); if (!inv) return;
    const total = inv.totalMinor ?? 1000;
    const r = await step('refunds requested', () => agentFor(i).call(`/cases/${k.id}/refunds`, 'POST', { invoiceId: inv.id, amountMinor: Math.max(100, Math.floor(total / 4)), reason: 'Customer was charged twice' }));
    if (r && /PENDING/.test(String(r.json.status ?? '')) && chance(0.7)) await step('refunds decided', () => admin.call(`/refunds/${r.json.id}/decision`, 'POST', { decision: chance(0.8) ? 'APPROVE' : 'REJECT', note: 'Reviewed by the load test' }));
  });
}

// ─────────────────────────── collections, fraud, blacklist ───────────────────────────
async function opsPhase() {
  startPhase('ops');
  await readServices();
  await step('dunning run', () => admin.call('/billing/dunning', 'POST', {}, {}, { idempotent: true }));
  const accountIds = [...new Set(S.customers.map((c) => c.accountId).filter(Boolean))];
  const sample = shuffle(accountIds).slice(0, Math.min(150, Math.ceil(accountIds.length * 0.15)));
  await each('collections', sample, async (a) => { await step('collections run', () => admin.call(`/accounts/${a}/collections/run`, 'POST', {}, {}, { idempotent: true })); });
  await step('fraud scan', () => admin.call('/fraud/scan', 'POST', {}, {}, { idempotent: true }));
  const withSvc = S.customers.filter((c) => c.services.length);
  const alertFor = shuffle(withSvc).slice(0, Math.min(60, Math.ceil(withSvc.length * 0.03)));
  await each('fraud alerts', alertFor, async (c) => { await step('fraud alerts raised', () => admin.call('/fraud/alerts', 'POST', { serviceId: c.services[0].id, kind: pick(['SIM_SWAP_ANOMALY', 'USAGE_SPIKE', 'MANUAL', 'OTHER']), severity: pick(['LOW', 'MEDIUM', 'HIGH']), summary: 'Raised by the load test.' })); });
  await each('blacklist', Array.from({ length: Math.max(4, Math.min(30, Math.round(S.customers.length * 0.003))) }), async () => { await step('blacklist entries', () => admin.call('/fraud/blacklist', 'POST', { kind: 'ID_DOCUMENT', value: `BL-${TAG}-${randomBytes(4).toString('hex')}`, reason: 'Known fraud pattern (load test)' })); });
}

// ─────────────────────────── main ───────────────────────────
async function main() {
  if (DRY) {
    startPhase('dry run');
    await loadCatalog(); await discoverStoresAndDealers(); const sellable = await getSellable(); await loadStock(); await loadStoreSims(S.stores); stockReport(sellable);
    log('Dry run done.'); writeReport(true); return;
  }
  await ensureStaff();
  if (has('setup')) await setup();
  if (has('customers')) await customersPhase();
  const needsCustomers = ['kyc', 'orders', 'changes', 'care', 'billing', 'payments', 'ops'].some(has);
  if (needsCustomers && !has('customers')) await adopt();
  if (has('kyc')) await kycPhase();
  if (has('orders')) await ordersPhase();
  if (has('changes')) await changesPhase();
  if (has('care')) await carePhase();
  if (has('billing')) await billingPhase();
  if (has('payments')) await paymentsPhase();
  if (has('ops')) await opsPhase();
  startPhase('report');
}

let failure;
try { await main(); } catch (e) { failure = e; log(`\nStopped: ${e.message}`); }
if (!KEEP_USERS) for (const id of made) await admin.call(`/users/${id}`, 'PATCH', { status: 'DISABLED' });
timings[prog.phase] = { seconds: Math.round((Date.now() - phaseStart) / 1000), done: prog.done, total: prog.total };
writeReport(true);
clearInterval(reportTimer);

// ─────────────────────────── summary ───────────────────────────
function summary() {
  const rep = buildReport(true);
  log(`\nDone in ${rep.minutes} min. ${metrics.calls} calls (${rep.calls.perSecond}/s), ${metrics.failures} infrastructure failures, ${metrics.retries} retries, governor tripped ${gov.trips} times.`);
  log('\nWhat happened:');
  for (const [k, v] of Object.entries(steps.stats)) log(`  ${k.padEnd(30)} ${String(v.ok).padStart(6)} ok${v.failed ? `, ${v.failed} failed` : ''}`);
  if (Object.keys(steps.errors).length) { log('\nSome calls were refused (first examples):'); for (const [k, e] of Object.entries(steps.errors)) log(`  ${k}: ${e.join(' | ')}`); }
  log('\nPhase timings:'); for (const [k, v] of Object.entries(rep.timings)) log(`  ${k.padEnd(24)} ${String(v.seconds).padStart(7)} s`);
  if (S.offers.size && S.orders.attempts) {
    log('\nOrders by offer (fewest first):');
    log(`  ${'offer'.padEnd(44)} ${'kind'.padEnd(22)} orders`);
    for (const r of rep.orders.perOffer) log(`  ${r.name.slice(0, 43).padEnd(44)} ${String(r.kind).slice(0, 21).padEnd(22)} ${String(r.orders).padStart(6)}${r.orders ? '' : `   NEVER SOLD: ${String(r.whyNotSold).slice(0, 160)}`}${r.blocked && r.orders ? `   (paused: ${r.blocked.reason.slice(0, 80)})` : ''}`);
    if (rep.orders.blocked.length) { log('\nOffers paused while running:'); for (const b of rep.orders.blocked.slice(-15)) log(`  ${b}`); }
    log(`\nOrders by channel: ${Object.entries(rep.orders.byChannel).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const ps = rep.orders.perStore, pd = rep.orders.perDealer;
    if (ps.length) log(`Stores: ${ps.length} active, ${rep.orders.storesWithNoOrders} got no order. Top: ${ps.slice(0, 5).map((s) => `${s.name} ${s.orders}`).join('; ')}. Bottom: ${ps.slice(-5).map((s) => `${s.name} ${s.orders}`).join('; ')}`);
    if (pd.length) log(`Dealers: ${pd.length}, ${rep.orders.dealersWithNoOrders} got no order. Top: ${pd.slice(0, 5).map((d) => `${d.name} ${d.orders}`).join('; ')}. Bottom: ${pd.slice(-5).map((d) => `${d.name} ${d.orders}`).join('; ')}`);
  }
  const g = (k) => steps.stats[k]?.ok ?? 0;
  log('\nCreated:');
  const rows = [['customers', g('customers created')], ['kyc approved / rejected / sent back', `${g('kyc approved')} / ${g('kyc rejected')} / ${g('kyc sent back')}`], ['orders placed', S.orders.ok], ['orders on hold (identity pending)', S.orders.held], ['orders cancelled', S.orders.cancelled], ['family orders', g('family orders')],
    ['service changes', ['services suspended', 'voluntary suspensions', 'plan changes', 'moved to a group plan', 'services terminated'].reduce((n, k) => n + g(k), 0)], ['interactions', g('interactions logged')], ['cases', g('cases opened') + g('cases from interactions')], ['case status moves', g('case status changes')],
    ['bill runs approved', g('bill runs approved')], ['invoices paid / part paid', `${g('invoices paid')} / ${g('part payments')}`], ['credit notes', g('credit notes')], ['refunds requested / decided', `${g('refunds requested')} / ${g('refunds decided')}`], ['collections / fraud alerts / blacklist', `${g('collections run')} / ${g('fraud alerts raised')} / ${g('blacklist entries')}`]];
  for (const [k, v] of rows) log(`  ${String(k).padEnd(40)} ${v}`);
  log(`\nReport written to ${OUT}`);
}
summary();
if (failure) process.exitCode = 1;
process.exit(process.exitCode ?? 0);
