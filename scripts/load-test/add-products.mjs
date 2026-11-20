#!/usr/bin/env node
/**
 * Adds 75 more demo products to a running Meridian catalog through its own API: a few new categories and groups, the offers (through the bulk offers import) and
 * the starting stock of the goods they sell (through the stock import). Nothing is deleted or changed that already exists (a row whose offer id exists would update it).
 *
 *   BASE=https://meridian.example.com ADMIN_USER=… ADMIN_PASS=… node scripts/load-test/add-products.mjs [--dry] [--no-stock]
 *
 * --dry only runs the import's own check (nothing is written). Offer ids start with dx-, SKUs are new, so running it twice only updates the same offers; the stock
 * is added again each time unless --no-stock is given. Amounts are plain numbers in the deployment's currency; the market is read from the existing offers.
 */
const args = Object.fromEntries(process.argv.slice(2).map((a) => (a.startsWith('--') ? [a.slice(2), true] : null)).filter(Boolean));
const BASE = (process.env.BASE ?? 'http://localhost:3111').replace(/\/$/, '');
const cookies = new Map();
async function call(path, method = 'GET', body) {
  const r = await fetch(`${BASE}/api${path}`, { method, headers: { 'content-type': 'application/json', origin: BASE, ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: r.status, json, text };
}
const login = await call('/auth/login', 'POST', { username: process.env.ADMIN_USER ?? '', password: process.env.ADMIN_PASS ?? '' });
if (login.status >= 300) throw new Error(`login ${login.status}: ${login.text.slice(0, 200)}`);
console.log(`Signed in to ${BASE}.`);

// ── the new places in the tree ──
const NEW_CATEGORIES = [['mobile-prepaid', 'Prepaid', 'mobile'], ['fiber-business', 'Business', 'fiber']];
const NEW_GROUPS = [
  ['grp-prepaid-plans', 'Prepaid plans', 'mobile-prepaid'], ['grp-business', 'Business mobile', 'mobile-postpaid'], ['grp-fibre-addons', 'Fibre add-ons', 'fiber-residential'],
  ['grp-biz-fibre', 'Business fibre', 'fiber-business'], ['grp-iot-plans', 'IoT plans', 'iot-iot-enterprise'], ['grp-iot-devices', 'IoT devices', 'iot-iot-enterprise'],
  ['grp-accessories', 'Accessories', 'none-goods'], ['grp-audio', 'Audio', 'none-goods'], ['grp-networking', 'Networking', 'none-goods'],
];

// ── the offers: [group, id, name, type, fields] (amounts in major units) ──
const SIM = 'SIM', SHIP = 'SHIP|SIM';
const O = [];
const add = (group, id, name, type, f = {}) => O.push({ group, id: `dx-${id}`, name, type, ...f });
// SIM only
add('grp-sim-only', 'student-30', 'Student 30GB SIM-only', 'SIM_ONLY', { monthly: 15, upfront: 0, fulfilment: SIM, description: 'No contract, 30GB for students.' });
add('grp-sim-only', 'night-owl-40', 'Night Owl 40GB SIM-only', 'SIM_ONLY', { monthly: 20, upfront: 5, fulfilment: SIM, description: 'Extra data between midnight and 8am.' });
add('grp-sim-only', 'light-10', 'Light 10GB SIM-only', 'SIM_ONLY', { monthly: 10, upfront: 5, fulfilment: SIM });
add('grp-sim-only', 'starter-5', 'Starter 5GB SIM-only', 'SIM_ONLY', { monthly: 8, upfront: 5, fulfilment: SIM });
add('grp-sim-only', 'pro-100-12', 'Pro 100GB SIM-only (12 mo)', 'SIM_ONLY', { monthly: 35, upfront: 0, months: 12, fulfilment: SIM });
add('grp-sim-only', 'max-300-24', 'Max 300GB SIM-only (24 mo)', 'SIM_ONLY', { monthly: 58, upfront: 0, months: 24, fulfilment: SIM });
add('grp-sim-only', 'roam-plus-80', 'Roam Plus 80GB SIM-only', 'SIM_ONLY', { monthly: 45, upfront: 5, fulfilment: SIM, description: 'Includes 10GB of roaming in Asia.' });
add('grp-sim-only', 'senior-15', 'Senior 15GB SIM-only', 'SIM_ONLY', { monthly: 12, upfront: 0, fulfilment: SIM });
// prepaid-style plans (no contract)
for (const [id, n, fee] of [['10', 'Prepaid 10', 10], ['20', 'Prepaid 20', 20], ['30', 'Prepaid 30', 30], ['50', 'Prepaid 50', 50], ['weekly', 'Weekly Pass 7', 7], ['tourist', 'Tourist 30-day', 25]])
  add('grp-prepaid-plans', `pre-${id}`, n, 'SIM_ONLY', { monthly: fee, upfront: 3, fulfilment: SIM, description: 'No contract.' });
// business mobile
for (const [id, n, fee, m] of [['50', 'Business 50GB', 55, 12], ['100', 'Business 100GB', 85, 12], ['200', 'Business 200GB', 120, 24], ['unl', 'Business Unlimited', 160, 24], ['fleet', 'Business Fleet line', 40, 12], ['data', 'Business Data-only 300GB', 70, 12]])
  add('grp-business', `biz-${id}`, `${n} (${m} mo)`, 'SIM_ONLY', { monthly: fee, upfront: 0, months: m, fulfilment: SIM });
// device plans
const dev = (id, n, fee, up, months, retail, sub, sku) => add('grp-device', id, n, 'SIM_DEVICE', { monthly: fee, upfront: up, months, free: 1, subsidy: sub, retail, fulfilment: SHIP, skus: sku });
dev('lite-12', '5G Plan + Phone Lite 64GB (12 mo)', 48, 99, 12, 599, 400, 'PHONE-LITE-64');
dev('lite-24', '5G Plan + Phone Lite 64GB (24 mo)', 38, 0, 24, 599, 500, 'PHONE-LITE-64');
dev('fold-24', '5G Plan + Phone Fold 512GB (24 mo)', 128, 799, 24, 3999, 2400, 'PHONE-FOLD-512');
dev('fold-36', '5G Plan + Phone Fold 512GB (36 mo)', 118, 499, 36, 3999, 2900, 'PHONE-FOLD-512');
dev('pro512-24', '5G Plan + Phone Pro 512GB (24 mo)', 118, 699, 24, 2499, 1500, 'PHONE-PRO-512');
dev('pro512-36', '5G Plan + Phone Pro 512GB (36 mo)', 98, 299, 36, 2499, 1700, 'PHONE-PRO-512');
// tablets and wearables
dev('tab-mini-24', '5G Tablet Mini + Data (24 mo)', 35, 99, 24, 599, 400, 'TABLET-MINI');
dev('tab-pro-24', '5G Tablet Pro + Data (24 mo)', 65, 399, 24, 2199, 1500, 'TABLET-PRO');
O[O.length - 2].group = 'grp-tablet'; O[O.length - 1].group = 'grp-tablet';
add('grp-tablet', 'tab-kids-12', '5G Tablet Kids + Data (12 mo)', 'SIM_DEVICE', { monthly: 25, upfront: 49, months: 12, subsidy: 250, retail: 499, fulfilment: SHIP, skus: 'TABLET-KIDS' });
add('grp-wearable', 'watch-sport', 'Watch Sport LTE (12 mo)', 'WEARABLE', { monthly: 15, upfront: 199, months: 12, subsidy: 400, retail: 899, fulfilment: SHIP, skus: 'WATCH-SPORT' });
add('grp-wearable', 'watch-kids', 'Watch Kids LTE (12 mo)', 'WEARABLE', { monthly: 10, upfront: 99, months: 12, subsidy: 200, retail: 399, fulfilment: SHIP, skus: 'WATCH-KIDS' });
// fibre
for (const [id, n, fee, up, m] of [['100', 'Home Fibre 100 Mbps (12 mo)', 19, 0, 12], ['500', 'Home Fibre 500 Mbps (24 mo)', 39, 50, 24], ['3g', 'Home Fibre 3 Gbps (24 mo)', 129, 0, 24], ['gamer', 'Home Fibre Gamer 1 Gbps (24 mo)', 69, 50, 24]])
  add('grp-home', `fibre-${id}`, n, 'FIBER', { monthly: fee, upfront: up, months: m, etc: 50, fulfilment: 'INSTALL', skus: 'ONT-ROUTER' });
for (const [id, n, fee, up] of [['500', 'Business Fibre 500 Mbps + static IP', 89, 100], ['1g', 'Business Fibre 1 Gbps + static IP', 149, 100], ['2g', 'Business Fibre 2 Gbps + static IP', 249, 0]])
  add('grp-biz-fibre', `bizfibre-${id}`, `${n} (24 mo)`, 'FIBER', { monthly: fee, upfront: up, months: 24, etc: 50, fulfilment: 'INSTALL', skus: 'ONT-ROUTER' });
// fibre add-ons and mobile add-ons, insurance
for (const [id, n, fee] of [['extender', 'Wi-Fi Extender rental', 6], ['staticip', 'Static IP address', 15], ['wifi7', 'Wi-Fi 7 upgrade', 10]]) add('grp-fibre-addons', `fa-${id}`, n, 'VAS', { monthly: fee });
for (const [id, n, fee] of [['roam-week', 'Roaming Weekly 10GB', 18], ['roam-eu', 'Roaming Europe 15GB', 40], ['data-50', 'Data Pass 50GB', 20], ['social', 'Unlimited Social apps', 8]]) add('grp-addons', `vas-${id}`, n, 'VAS', { monthly: fee });
add('grp-insurance', 'care-plus', 'Device Care Plus (insurance)', 'VAS', { monthly: 15, requires: 'grp-device', description: 'Accidental damage and theft cover. Needs a phone plan with a device.' });
add('grp-insurance', 'care-tablet', 'Tablet Care (insurance)', 'VAS', { monthly: 7, requires: 'grp-tablet' });
add('grp-insurance', 'care-screen', 'Screen Protect (insurance)', 'VAS', { monthly: 5, requires: 'grp-device' });
add('grp-video', 'netflix-std', 'Netflix Standard', 'NON_TELCO_SUBSCRIPTION', { monthly: 15.9, partner: 'netflix' });
add('grp-video', 'youtube-family', 'YouTube Premium Family', 'NON_TELCO_SUBSCRIPTION', { monthly: 22.9, partner: 'youtube' });
// goods
const good = (group, id, n, price, sku) => add(group, id, n, 'PHYSICAL_GOOD', { upfront: price, fulfilment: 'SHIP', skus: sku });
good('grp-electronics', 'g-lite', 'Phone Lite 64GB (outright)', 599, 'PHONE-LITE-64'); good('grp-electronics', 'g-fold', 'Phone Fold 512GB (outright)', 3999, 'PHONE-FOLD-512');
good('grp-electronics', 'g-pro512', 'Phone Pro 512GB (outright)', 2499, 'PHONE-PRO-512'); good('grp-electronics', 'g-tab-mini', 'Tablet Mini (outright)', 599, 'TABLET-MINI');
good('grp-accessories', 'case', 'Phone Case X1', 49, 'CASE-X1'); good('grp-accessories', 'guard', 'Screen Guard X1', 29, 'GUARD-X1'); good('grp-accessories', 'charger-65', 'Fast Charger 65W', 89, 'CHARGER-65W');
good('grp-accessories', 'cable', 'USB-C Cable 2m', 25, 'CABLE-USBC'); good('grp-accessories', 'charger-wl', 'Wireless Charger', 79, 'CHARGER-WL');
good('grp-accessories', 'powerbank', 'Power Bank 20000mAh', 119, 'POWERBANK-20K');
good('grp-audio', 'earbuds', 'Earbuds E1', 199, 'EARBUDS-E1'); good('grp-audio', 'headphones', 'Headphones H1', 349, 'HEADPHONE-H1'); good('grp-audio', 'speaker-bt', 'Bluetooth Speaker', 149, 'SPEAKER-BT');
good('grp-networking', 'mifi', '5G MiFi Hotspot', 499, 'MIFI-5G'); good('grp-networking', 'router-w7', 'Wi-Fi 7 Router', 599, 'ROUTER-WIFI7'); good('grp-networking', 'mesh-3', 'Mesh Wi-Fi Kit (3 pack)', 349, 'MESH-3PK');
good('grp-appliances', 'airfryer', 'Smart Air Fryer A1', 399, 'AIRFRYER-A1'); good('grp-appliances', 'vacuum', 'Robot Vacuum R1', 899, 'VACUUM-R1');
good('grp-smart-home', 'bulb-4', 'Smart Bulb (4 pack)', 99, 'BULB-4PK'); good('grp-smart-home', 'plug', 'Smart Plug', 39, 'PLUG-S1'); good('grp-smart-home', 'cam-door', 'Smart Door Camera', 249, 'CAM-DOOR'); good('grp-smart-home', 'lock', 'Smart Door Lock', 599, 'LOCK-S1');
// IoT
add('grp-iot-plans', 'iot-fleet', 'IoT Fleet Tracking plan (per device)', 'IOT_CONNECTIVITY', { monthly: 4 });
add('grp-iot-plans', 'iot-meter', 'IoT Smart Meter plan (per device)', 'IOT_CONNECTIVITY', { monthly: 2 });
good('grp-iot-devices', 'tracker', 'GPS Tracker', 129, 'TRACKER-GPS');

const STORE_STOCK = 12;
const skus = [...new Set(O.flatMap((o) => (o.skus ? [o.skus] : [])))].filter((s) => !['ONT-ROUTER', 'PHONE-X1-128'].includes(s));
console.log(`${O.length} offers, ${skus.length} new SKUs, ${NEW_CATEGORIES.length} new categories, ${NEW_GROUPS.length} new groups.`);
if (O.length !== 75) throw new Error(`expected 75 offers, built ${O.length}`);

// the market the existing offers are sold in
const existing = (await call('/catalog?limit=100')).json.items ?? [];
const market = existing.find((n) => n.level === 'OFFER' && n.markets?.length)?.markets[0] ?? '';
console.log(`Market: ${market || '(none)'}`);

// ── tree ──
async function node(body) {
  const r = await call('/catalog', 'POST', body);
  if (r.status >= 300 && !/exist|already|duplicate|in use/i.test(r.text)) throw new Error(`catalog ${body.id}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.status < 300 ? 'created' : 'exists';
}
if (!args.dry && !args['stock-only']) {
  for (const [id, name, parentId] of NEW_CATEGORIES) console.log('category', id, await node({ level: 'CATEGORY', id, name, parentId, status: 'ACTIVE' }));
  for (const [id, name, parentId] of NEW_GROUPS) console.log('group', id, await node({ level: 'GROUP', id, name, parentId, status: 'ACTIVE' }));
}

if (!args['stock-only']) {
// ── offers ──
const HEAD = 'group_id,offer_id,name,type,description,monthly_fee,upfront_price,prices_include_tax,contract_months,contract_free_months,etc_percent,subsidy,device_retail_price,fulfilment,stock_skus,colours_storage,device_contracts,channels,requires,excludes,partner_code,market,status,go_live_date,validity_days,ocs_plan_code,suspension_mode,suspension_fee,group_plan,max_group_members,allowed_member_offers,shared_pool_quota_gb,characteristics'.split(',');
const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const money = (n) => (n === undefined ? '' : Number(n).toFixed(2));
const rows = O.map((o) => {
  const r = { group_id: o.group, offer_id: o.id, name: o.name, type: o.type, description: o.description, monthly_fee: money(o.monthly), upfront_price: money(o.upfront), prices_include_tax: 'yes',
    contract_months: o.months ?? '', contract_free_months: o.free ?? '', etc_percent: o.etc ?? '', subsidy: money(o.subsidy), device_retail_price: money(o.retail), fulfilment: o.fulfilment, stock_skus: o.skus,
    requires: o.requires, partner_code: o.partner, market, status: 'ACTIVE' };
  return HEAD.map((h) => q(r[h])).join(',');
});
const csv = [HEAD.join(','), ...rows].join('\n') + '\n';
const check = await call('/catalog-import', 'POST', { csv, apply: false });
console.log('Check:', JSON.stringify({ canApply: check.json.canApply, summary: check.json.summary, errors: check.json.errors, problems: (check.json.rows ?? []).filter((r) => r.status !== 'OK').slice(0, 8) }).slice(0, 1500));
if (check.status >= 300 || check.json?.errors?.length) { console.log('Stopping: the check found problems.'); process.exit(1); }
if (args.dry) { console.log('Dry run done: nothing was written.'); process.exit(0); }
const done = await call('/catalog-import', 'POST', { csv, apply: true });
console.log('Import:', JSON.stringify(done.json).slice(0, 600));
if (done.status >= 300) process.exit(1);

}

// ── stock ──
if (!args['no-stock']) {
  const wh = ((await call('/warehouses')).json.items ?? []).filter((w) => w.status === 'ACTIVE').map((w) => w.id);
  const stores = ((await call('/inventory/locations')).json.items ?? []).filter((l) => !wh.includes(l));
  const lines = ['location_id,sku,quantity,action'];
  const qty = (sku) => (/PHONE|TABLET|WATCH|EARBUDS|CASE|GUARD|CHARGER|CABLE|GRIP/.test(sku) ? 300 : 150);
  for (const s of skus) { for (const w of wh) lines.push(`${w},${s},${qty(s)},RECEIVE`); for (const st of stores) lines.push(`${st},${s},${STORE_STOCK},RECEIVE`); }
  for (const s of ['ONT-ROUTER']) for (const w of wh) lines.push(`${w},${s},300,RECEIVE`);
  const stockCsv = lines.join('\n') + '\n';
  const sc = await call('/inventory/import', 'POST', { csv: stockCsv, apply: false });
  console.log(`Stock check (${lines.length - 1} rows):`, JSON.stringify({ canApply: sc.json.canApply, summary: sc.json.summary, problems: (sc.json.rows ?? []).filter((r) => r.status !== 'OK').slice(0, 6) }).slice(0, 1200));
  if (sc.status >= 300 || sc.json?.canApply === false) { console.log('Stopping: the stock check found problems.'); process.exit(1); }
  const sa = await call('/inventory/import', 'POST', { csv: stockCsv, apply: true });
  console.log('Stock loaded:', JSON.stringify(sa.json).slice(0, 400));
}
console.log('Done.');
