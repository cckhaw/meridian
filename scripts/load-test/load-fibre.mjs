#!/usr/bin/env node
/**
 * Fills the fibre coverage hub with distribution points (the points on the coverage map, each with its ports) through the hub's own import, so the map, the
 * ports page and the serviceability checks have something to work on.
 *
 *   FIBER_URL=https://meridian-fibercoverage.vercel.app ADMIN_USER=… ADMIN_PASS=… node scripts/load-test/load-fibre.mjs [--count 5000] [--dry]
 *
 * Options: --count N (default 5000)  --provider CODE (default: every enabled provider in turn)  --prefix LT (point codes are <prefix>-DP-00001, cabinets <prefix>-CAB-001)
 *          --chunk N (rows per import request, default 200)  --seed N  --dry (check the first chunk only: nothing is written)
 * Points are spread over Malaysian cities and Singapore, about 24 points to a cabinet, with a splitter of 8, 16 or 32 ports, some ports in use or faulty and a few
 * points full. Rows are matched by (provider, code), so running it again updates the same points instead of adding more. Nothing is ever deleted.
 */
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null)).filter(Boolean));
const BASE = (process.env.FIBER_URL ?? 'https://meridian-fibercoverage.vercel.app').replace(/\/$/, '');
const COUNT = Number(args.count ?? 5000), CHUNK = Math.max(20, Number(args.chunk ?? 200)), PREFIX = String(args.prefix ?? 'LT').toUpperCase();
let seed = Number(args.seed ?? 4242);
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// city, state, centre, spread in degrees, postcode range
const CITIES = [
  ['Kuala Lumpur', 'Kuala Lumpur', 3.139, 101.687, 0.09, [50000, 60000]], ['Petaling Jaya', 'Selangor', 3.107, 101.607, 0.05, [46000, 47900]],
  ['Shah Alam', 'Selangor', 3.0738, 101.5183, 0.06, [40000, 40800]], ['Subang Jaya', 'Selangor', 3.0565, 101.585, 0.04, [47500, 47700]],
  ['Klang', 'Selangor', 3.0449, 101.4455, 0.06, [41000, 42100]], ['Cyberjaya', 'Selangor', 2.9213, 101.6559, 0.03, [63000, 63200]],
  ['George Town', 'Penang', 5.414, 100.329, 0.06, [10000, 11900]], ['Johor Bahru', 'Johor', 1.4927, 103.7414, 0.08, [80000, 81900]],
  ['Ipoh', 'Perak', 4.5975, 101.0901, 0.06, [30000, 31650]], ['Melaka', 'Melaka', 2.1896, 102.2501, 0.05, [75000, 76100]],
  ['Seremban', 'Negeri Sembilan', 2.7258, 101.9424, 0.05, [70000, 71000]], ['Kuantan', 'Pahang', 3.8077, 103.326, 0.06, [25000, 26100]],
  ['Kota Kinabalu', 'Sabah', 5.9804, 116.0735, 0.06, [88000, 88999]], ['Kuching', 'Sarawak', 1.5535, 110.3593, 0.06, [93000, 93999]],
  ['Alor Setar', 'Kedah', 6.1248, 100.3678, 0.04, [5000, 6900]], ['Kota Bharu', 'Kelantan', 6.1254, 102.2381, 0.04, [15000, 16100]],
  ['Singapore', 'Singapore', 1.3521, 103.8198, 0.09, [10000, 829999]],
];
const WEIGHTS = [16, 8, 5, 5, 4, 2, 6, 7, 3, 3, 3, 3, 4, 4, 2, 2, 12];
const wide = WEIGHTS.flatMap((w, i) => Array(w).fill(i));
const STREETS = ['Jalan Ampang', 'Jalan Bukit Bintang', 'Jalan Sultan Ismail', 'Jalan Tun Razak', 'Jalan Pasar', 'Jalan Merdeka', 'Jalan Raja Laut', 'Lorong Maarof', 'Jalan SS2', 'Persiaran Kewajipan', 'Jalan Kenanga', 'Jalan Melati', 'Jalan Mawar', 'Jalan Cempaka', 'Jalan Taman Desa', 'Orchard Road', 'Bedok North Avenue', 'Tampines Street', 'Clementi Avenue'];

class Hub {
  constructor() { this.cookies = new Map(); }
  async call(path, method = 'GET', body) {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(`${BASE}/api${path}`, { method, headers: { 'content-type': 'application/json', origin: BASE, ...(this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
        for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) this.cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
        const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
        if ([429, 502, 503, 504].includes(r.status) && attempt < 5) { await sleep(1000 * attempt * 2); continue; }
        return { status: r.status, json };
      } catch (e) { if (attempt >= 5) throw e; await sleep(1000 * attempt * 2); }
    }
  }
}

const hub = new Hub();
const login = await hub.call('/admin/login', 'POST', { username: process.env.ADMIN_USER ?? '', password: process.env.ADMIN_PASS ?? '' });
if (login.json?.mfaRequired) {
  if (!process.env.ADMIN_OTP) throw new Error('The admin account needs a second factor: set ADMIN_OTP');
  const v = await hub.call('/admin/verify-2fa', 'POST', { challenge: login.json.challenge.token, code: process.env.ADMIN_OTP });
  if (v.status >= 300) throw new Error(`verify: ${v.status} ${JSON.stringify(v.json).slice(0, 160)}`);
} else if (login.status >= 300) throw new Error(`login: ${login.status} ${JSON.stringify(login.json).slice(0, 160)}`);
console.log(`Signed in to ${BASE}.`);

const providers = ((await hub.call('/admin/providers')).json.items ?? []).filter((p) => p.enabled !== false && (!args.provider || String(p.code).toUpperCase() === String(args.provider).toUpperCase()));
if (!providers.length) throw new Error('No provider to put the points under: create one in the hub first (Providers tab).');
const before = (await hub.call('/admin/dps?limit=1')).json;
console.log(`Providers: ${providers.map((p) => p.code).join(', ')}. Loading ${COUNT} points in requests of ${CHUNK}${args.dry ? ' (dry run: checking the first request only)' : ''}.`);

// ── the points ──
const quote = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
const HEAD = 'code,name,provider,cabinet,lat,lng,splitter,radiusM,usedPorts,faultyPorts,address,city,state,postalCode';
const rows = [];
for (let i = 1; i <= COUNT; i++) {
  const [city, state, lat0, lng0, spread, [pcLo, pcHi]] = CITIES[pick(wide)];
  const lat = lat0 + (rnd() - 0.5) * spread * 2, lng = lng0 + (rnd() - 0.5) * spread * 2;
  const splitter = pick([8, 16, 16, 32, 32]);
  const roll = rnd();
  const used = roll < 0.06 ? splitter : roll < 0.30 ? between(Math.floor(splitter * 0.8), splitter - 1) : between(0, Math.floor(splitter * 0.8));
  const faulty = chance(0.12) ? between(1, 2) : 0;
  const postal = city === 'Singapore' ? String(between(10000, 829999)).padStart(6, '0') : String(between(pcLo, pcHi)).padStart(5, '0');
  const provider = providers[(i - 1) % providers.length].code;
  const cab = `${PREFIX}-CAB-${String(Math.ceil(i / 24)).padStart(3, '0')}`;
  rows.push([`${PREFIX}-DP-${String(i).padStart(5, '0')}`, `${city} point ${i}`, provider, cab, lat.toFixed(6), lng.toFixed(6), splitter, between(80, 260), Math.min(used, splitter - faulty), faulty, `${between(1, 199)} ${pick(STREETS)}`, city, state, postal].map(quote).join(','));
}

async function send(slice, apply) {
  const r = await hub.call('/admin/import', 'POST', { format: 'CSV', text: [HEAD, ...slice].join('\n') + '\n', apply });
  if (r.status >= 300) throw new Error(`import ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
}
const first = await send(rows.slice(0, CHUNK), false);
console.log(`Check of the first ${Math.min(CHUNK, rows.length)} points:`, JSON.stringify(first.summary), first.errors?.length ? `PROBLEMS: ${first.errors.slice(0, 5).join(' | ')}` : 'no problems');
if (first.errors?.length) { console.log('Stopping: fix the file first.'); process.exit(1); }
if (args.dry) { console.log('Dry run done: nothing was written.'); process.exit(0); }

let created = 0, updated = 0, failed = 0; const problems = []; const t0 = Date.now();
for (let at = 0; at < rows.length; at += CHUNK) {
  try {
    const res = await send(rows.slice(at, at + CHUNK), true);
    created += res.summary?.dps?.create ?? 0; updated += res.summary?.dps?.update ?? 0;
    if (res.errors?.length) { failed += CHUNK; problems.push(...res.errors.slice(0, 3)); }
  } catch (e) { failed += Math.min(CHUNK, rows.length - at); problems.push(String(e.message).slice(0, 200)); }
  if (((at / CHUNK) + 1) % 5 === 0 || at + CHUNK >= rows.length) console.log(`  ${Math.min(at + CHUNK, rows.length)}/${rows.length} points sent (${created} created, ${updated} updated, ${failed} refused), ${Math.round((Date.now() - t0) / 1000)} s`);
}
const after = (await hub.call('/admin/dps?limit=1')).json;
const cabinets = (await hub.call('/admin/cabinets')).json.items ?? [];
console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)} s: ${created} points created, ${updated} updated, ${failed} refused. Cabinets in the hub: ${cabinets.length}. Hub points before: ${before.total ?? before.items?.length ?? '?'}, after: ${after.total ?? after.items?.length ?? '?'}.`);
if (problems.length) console.log('First problems:', problems.slice(0, 5).join(' | '));
writeFileSync(`load-fibre-report-${PREFIX}.json`, JSON.stringify({ base: BASE, count: COUNT, created, updated, failed, cabinets: cabinets.length, problems: problems.slice(0, 20) }, null, 2));
