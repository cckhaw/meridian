#!/usr/bin/env node
/**
 * Loads extra identity pools (phone numbers, IMSIs, physical SIM cards, eSIM profiles) through the numbering API, so a big load-test run does not
 * starve. It looks for free ranges above the highest value already in the system, checks every chunk first (apply:false: the check reports
 * conflicts), and only then loads it. Everything is tagged with the batch name.
 *
 *   BASE=https://meridian.example.com ADMIN_USER=root ADMIN_PASS=… node scripts/load-test/load-pools.mjs --msisdn 30000 --sims 12000 --esims 8000 --batch LT-POOLS
 *   options: --msisdn N  --sims N (physical, WH-MAIN, each bound to a fresh IMSI)  --esims N (eSIM profiles)  --imsi N (extra IMSIs; by default
 *            enough for the SIMs and eSIMs that are loaded)  --location WH-MAIN  --batch NAME  --dry (check only)  --chunk N
 *   (ADMIN_OTP=123456 if the admin account asks for a second factor)
 */
import { Governor, Metrics, Session, parseArgs, chunks } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const BASE = (process.env.BASE ?? args.base ?? 'http://localhost:3111').replace(/\/$/, '');
const DRY = !!args.dry;
const COUNT = (k) => Math.max(0, Math.floor(Number(args[k] ?? 0)) || 0);
const WANT = { msisdn: COUNT('msisdn'), sims: COUNT('sims'), esims: COUNT('esims') };
const LOCATION = String(args.location ?? 'WH-MAIN');
const BATCH = String(args.batch ?? `LT-POOLS-${new Date().toISOString().slice(0, 10)}`).slice(0, 60);
const CHUNK = Math.min(Math.max(1000, COUNT('chunk') || 5000), 50_000);
const log = (...a) => console.log(...a);

if (!WANT.msisdn && !WANT.sims && !WANT.esims && !args.imsi) { log('Nothing to load: give --msisdn N, --sims N, --esims N or --imsi N (and --dry to only check).'); process.exit(0); }

const gov = new Governor({ limit: 4 });
const admin = new Session('admin', { base: BASE, gov, metrics: new Metrics() });
await admin.login(process.env.ADMIN_USER ?? 'root', process.env.ADMIN_PASS ?? '', process.env.ADMIN_OTP);
log(`Signed in to ${BASE} as ${admin.user.username}. Batch ${BATCH}${DRY ? ' (dry run: nothing is written)' : ''}.`);
const must = (r, what) => { if (!r.ok) throw new Error(`${what}: ${r.status} ${r.json?.error?.message ?? JSON.stringify(r.json).slice(0, 160)}`); return r.json; };

async function summary() {
  const s = must(await admin.call('/numbering/summary'), 'summary');
  const sum = (rows, f) => rows.filter(f).reduce((n, r) => n + r.n, 0);
  return {
    raw: s,
    msisdnFree: sum(s.msisdn, (r) => r.state === 'AVAILABLE'), msisdnStandardFree: s.availableByTier?.STANDARD ?? 0, msisdnTotal: sum(s.msisdn, () => true),
    imsiFree: sum(s.imsi, (r) => r.state === 'POOL_UNASSIGNED'), imsiBound: sum(s.imsi, (r) => r.state === 'BOUND_TO_SIM'), imsiTotal: sum(s.imsi, () => true),
    simFree: sum(s.iccid, (r) => r.kind === 'PHYSICAL' && ['WAREHOUSE_INVENTORY', 'DISTRIBUTED_DEALER'].includes(r.state)), simTotal: sum(s.iccid, (r) => r.kind === 'PHYSICAL'),
    esimFree: sum(s.iccid, (r) => r.kind === 'ESIM' && ['WAREHOUSE_INVENTORY', 'DISTRIBUTED_DEALER'].includes(r.state)), esimTotal: sum(s.iccid, (r) => r.kind === 'ESIM'),
  };
}
function show(title, s) {
  log(`${title}`);
  log(`  numbers  free ${s.msisdnFree} (standard ${s.msisdnStandardFree}) of ${s.msisdnTotal}; by tier ${Object.entries(s.raw.availableByTier ?? {}).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}`);
  log(`  IMSIs    free ${s.imsiFree}, bound to a SIM ${s.imsiBound}, total ${s.imsiTotal}`);
  log(`  SIMs     physical free ${s.simFree} of ${s.simTotal}; eSIM profiles free ${s.esimFree} of ${s.esimTotal}`);
}

/** The highest value that starts a pool listing's key: descends one digit at a time asking for "anything starting with this prefix". */
async function highest(path, query, prefixOf, lengthHint) {
  const first = must(await admin.call(`${path}?limit=1`), path).items?.[0];
  if (!first) return null;
  const len = String(first[query]).replace(/\D/g, '').length || lengthHint;
  let prefix = '';
  for (let pos = 0; pos < len; pos++) {
    const probes = await Promise.all(Array.from({ length: 10 }, (_, d) => admin.call(`${path}?limit=1&q=${encodeURIComponent(prefixOf(prefix + d))}`).then((r) => (r.json.items?.length ? d : -1))));
    const best = Math.max(...probes);
    if (best < 0) break;   // cannot happen on a consistent listing; keep what was found
    prefix += best;
  }
  return prefix.length === len ? BigInt(prefix) : null;
}

const roundUp = (n, step) => ((n + step - 1n) / step) * step;
const pad = (n, len) => n.toString().padStart(len, '0');

/** Finds a free start for `count` consecutive values of `len` digits at or above `from`, checking each candidate block with the importer's own check. */
async function reserveRange(kind, from, count, len, check) {
  let start = from;
  for (let attempt = 0; attempt < 30; attempt++) {
    const r = await check(start, Math.min(count, CHUNK));
    if (!r.errors?.length && !r.duplicates) return start;
    log(`  ${kind}: ${r.duplicates} already exist from ${pad(start, len)}; moving up`);
    start += roundUp(BigInt(Math.max(count, CHUNK)), 10_000n);
  }
  throw new Error(`${kind}: no free range found above ${pad(from, len)}`);
}

const before = await summary();
show('Before:', before);
const result = {};

// ── phone numbers ──
if (WANT.msisdn) {
  const tpl = String(must(await admin.call('/numbering/template/msisdn'), 'template').raw ?? '').split('\n')[1] ?? '60128001234';
  const len = tpl.length;
  const top = await highest('/numbering/numbers', 'msisdn', (p) => `+${p}`, len);
  const from = top === null ? BigInt(tpl.slice(0, -4) + '0000') : roundUp(top + 1n, 10_000n);
  log(`Phone numbers: ${top === null ? 'none yet, starting at' : `highest is +${pad(top, len)}, starting at`} +${pad(from, len)}.`);
  const range = (s, n) => ({ range: { from: pad(s, len), to: pad(s + BigInt(n) - 1n, len) }, batch: BATCH });
  const start = await reserveRange('numbers', from, WANT.msisdn, len, async (s, n) => must(await admin.call('/numbering/import/msisdn', 'POST', { ...range(s, n), apply: false }, {}, { idempotent: true }), 'check numbers'));
  let added = 0, s = start;
  for (const n of chunks(Array.from({ length: WANT.msisdn }), CHUNK).map((c) => c.length)) {
    const body = range(s, n);
    const chk = must(await admin.call('/numbering/import/msisdn', 'POST', { ...body, apply: false }, {}, { idempotent: true }), 'check numbers');
    if (chk.duplicates || chk.errors?.length) { log(`  numbers: block at +${pad(s, len)} has ${chk.duplicates} existing and ${chk.errors?.length ?? 0} errors; skipped`); s += BigInt(n); continue; }
    if (!DRY) must(await admin.call('/numbering/import/msisdn', 'POST', { ...body, apply: true }), 'load numbers');
    added += chk.added; s += BigInt(n);
    log(`  numbers: ${DRY ? 'would load' : 'loaded'} ${chk.added} (tiers ${Object.entries(chk.byTier ?? {}).map(([t, c]) => `${t} ${c}`).join(', ')}) up to +${pad(s - 1n, len)}`);
  }
  result.msisdn = { added, from: `+${pad(start, len)}`, to: `+${pad(s - 1n, len)}` };
}

// ── IMSIs: one for every physical SIM loaded, and one for every eSIM profile that will be sold ──
const imsiNeed = args.imsi !== undefined ? COUNT('imsi') : Math.max(0, WANT.sims + WANT.esims - before.imsiFree);
if (imsiNeed) {
  const len = 15;
  const tpl = String(must(await admin.call('/numbering/template/imsi'), 'template').raw ?? '').split('\n')[1] ?? '525010000000001';
  const top = await highest('/numbering/imsis', 'imsi', (p) => p, len);
  const from = top === null ? BigInt(tpl.slice(0, -6) + '000000') : roundUp(top + 1n, 100_000n);
  log(`IMSIs: ${top === null ? 'none yet, starting at' : `highest is ${pad(top, len)}, starting at`} ${pad(from, len)}.`);
  const range = (s, n) => ({ range: { from: pad(s, len), to: pad(s + BigInt(n) - 1n, len) }, batch: BATCH });
  const start = await reserveRange('IMSIs', from, imsiNeed, len, async (s, n) => must(await admin.call('/numbering/import/imsi', 'POST', { ...range(s, n), apply: false }, {}, { idempotent: true }), 'check IMSIs'));
  let added = 0, s = start;
  for (const n of chunks(Array.from({ length: imsiNeed }), CHUNK * 4).map((c) => c.length)) {
    const body = range(s, n);
    const chk = must(await admin.call('/numbering/import/imsi', 'POST', { ...body, apply: false }, {}, { idempotent: true }), 'check IMSIs');
    if (chk.duplicates || chk.errors?.length) { log(`  IMSIs: block at ${pad(s, len)} has ${chk.duplicates} existing; skipped`); s += BigInt(n); continue; }
    if (!DRY) must(await admin.call('/numbering/import/imsi', 'POST', { ...body, apply: true }), 'load IMSIs');
    added += chk.added; s += BigInt(n);
    log(`  IMSIs: ${DRY ? 'would load' : 'loaded'} ${chk.added} up to ${pad(s - 1n, len)}`);
  }
  result.imsi = { added, from: pad(start, len), to: pad(s - 1n, len) };
}

// ── ICCIDs: physical SIM cards (bound to an IMSI as they load) and eSIM profiles ──
if (WANT.sims || WANT.esims) {
  const len = 19;
  const top = await highest('/numbering/sims', 'iccid', (p) => p, len);
  let next = top === null ? 8960118763890000000n : roundUp(top + 1n, 10_000n);
  log(`ICCIDs: ${top === null ? 'none yet, starting at' : `highest is ${pad(top, len)}, starting at`} ${pad(next, len)}.`);
  const load = async (kind, total) => {
    let added = 0, bound = 0; const from = next;
    for (const n of chunks(Array.from({ length: total }), Math.min(CHUNK, 5000)).map((c) => c.length)) {
      let tries = 0, chk, body;
      for (; tries < 30; tries++) {   // a block that clashes with something already loaded is stepped over
        body = { csv: ['iccid', ...Array.from({ length: n }, (_, i) => pad(next + BigInt(i), len))].join('\n'), batch: BATCH, kind, locationId: LOCATION, autoBindImsi: kind === 'PHYSICAL' };
        chk = must(await admin.call('/numbering/import/sim', 'POST', { ...body, apply: false }, {}, { idempotent: true }), 'check SIMs');
        if (!chk.duplicates && !chk.errors?.length) break;
        log(`  ${kind}: ${chk.duplicates} already exist at ${pad(next, len)}; moving up`); next += BigInt(Math.max(n, 10_000));
      }
      if (tries >= 30) throw new Error(`no free ICCID block above ${pad(next, len)}`);
      if (!DRY) { const r = must(await admin.call('/numbering/import/sim', 'POST', { ...body, apply: true }), `load ${kind}`); bound += r.bound ?? 0; }
      added += chk.added; next += BigInt(n);
      log(`  ${kind === 'PHYSICAL' ? 'SIMs' : 'eSIMs'}: ${DRY ? 'would load' : 'loaded'} ${chk.added}${kind === 'PHYSICAL' && !DRY ? ` (${bound} bound to IMSIs)` : ''} up to ${pad(next - 1n, len)}`);
    }
    return { added, from: pad(from, len), to: pad(next - 1n, len) };
  };
  if (WANT.sims) result.sims = await load('PHYSICAL', WANT.sims);
  if (WANT.esims) result.esims = await load('ESIM', WANT.esims);
}

const after = await summary();
show(DRY ? 'Unchanged (dry run):' : 'After:', after);
log(`\nBatch ${BATCH}: ${JSON.stringify(result)}`);
