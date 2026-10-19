#!/usr/bin/env node
/**
 * Checks that every built-in role can do what its permissions say, and nothing else.
 *
 *   BASE=https://meridian.example.com ADMIN_USER=… ADMIN_PASS=… node scripts/rbac-test/run.mjs [--tag RB] [--keep-users] [--no-transactions]
 *
 * 1. Sweep. For every route in apps/web/src/server/router.ts that names its permission, each role is tried. A role that has the permission must not get
 *    "Your role does not allow this"; a role that lacks it must. Reads are called as they are. Writes carry a made-up id (the permission check happens
 *    before anything is looked up, so an allowed role gets "not found" and nothing changes); a write with no id in its path is only tried by roles that
 *    should be refused.
 * 2. Transactions. The main roles do their own real work (create a customer and order, decide identity checks, log interactions and cases, raise fraud
 *    alerts, start a bill run, ...) and then try the work that belongs to another role, which must be refused.
 *
 * It creates one user per role (names rb.<role>.<tag>, random passwords, disabled at the end) plus a few tagged customers, orders and cases.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null)).filter(Boolean));
const BASE = (process.env.BASE ?? 'http://localhost:3111').replace(/\/$/, '');
const TAG = String(args.tag ?? 'RB');
const KEEP = !!args['keep-users'];
const TX = !args['no-transactions'];
const ROUTER = join(dirname(fileURLToPath(import.meta.url)), '../../apps/web/src/server/router.ts');
const GHOST = '00000000-0000-4000-8000-000000000000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pw = () => `Rb-${randomBytes(9).toString('base64url')}-7q!`;
const log = (...a) => console.log(...a);

class Session {
  constructor(name) { this.name = name; this.cookie = ''; }
  async call(path, method = 'GET', body, headers = {}) {
    const r = await fetch(`${BASE}/api${path}`, { method, headers: { 'content-type': 'application/json', origin: BASE, ...(this.cookie ? { cookie: this.cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
    const set = r.headers.get('set-cookie'); const m = set && /((?:__Host-)?meridian_session=[^;]+)/.exec(set); if (m) this.cookie = m[1];
    return { status: r.status, json, denied: r.status === 403 && /does not allow/.test(JSON.stringify(json)) };
  }
  async login(username, password, otp) {
    let r = await this.call('/auth/login', 'POST', { username, password });
    if (r.json?.mfaRequired) { if (!otp) throw new Error(`${username} needs a second factor: set ADMIN_OTP`); r = await this.call('/auth/verify-2fa', 'POST', { challenge: r.json.challenge.token, code: otp }); }
    if (r.status >= 300) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    if (r.json.user?.mustChangePassword) { const next = pw(); const c = await this.call('/auth/change-password', 'POST', { current: password, next }); if (c.status >= 300) throw new Error(`change password ${username}: ${JSON.stringify(c.json).slice(0, 160)}`); const again = await this.call('/auth/login', 'POST', { username, password: next }); r = again; }
    this.user = r.json.user; return this;
  }
}

// ── the routes that name their permission ──
const routes = [];
for (const line of readFileSync(ROUTER, 'utf8').split('\n')) {
  const m = /^(get|post|patch|put|del)\(\s*'([^']+)',\s*(\[[^\]]*\]|'[^']*'|null)/.exec(line);
  if (!m) continue;
  const perms = m[3] === 'null' ? null : m[3].startsWith('[') ? [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [m[3].slice(1, -1)];
  const method = m[1] === 'del' ? 'DELETE' : m[1].toUpperCase();
  if (/\$\{/.test(m[2])) continue;
  if (/export|download|\.pdf|\.csv|stream|webhook|oidc|callback|\/public\/|\/auth\//.test(m[2])) continue;   // heavy, or not behind a role
  routes.push({ method, path: m[2], perms, hasParam: m[2].includes(':') });
}

const admin = new Session('admin');
await admin.login(process.env.ADMIN_USER ?? 'root', process.env.ADMIN_PASS ?? '', process.env.ADMIN_OTP);
log(`Signed in to ${BASE} as ${admin.user.username}. ${routes.length} routes name their permission.`);

const roles = (await admin.call('/roles')).json;
const staffRoles = roles.filter((r) => r.id !== 'admin' || true);
const store = ((await admin.call('/stores?limit=1&status=ACTIVE')).json.items ?? [])[0]?.id;
const dealer = ((await admin.call('/dealers?limit=1')).json.items ?? [])[0]?.id;
const linked = ((await admin.call('/customers?limit=1')).json.items ?? [])[0]?.id;
log(`${roles.length} roles. Store for store roles: ${store ?? 'none'}; dealer for dealer roles: ${dealer ?? 'none'}.`);

// ── one user per role ──
const made = [];
const sessions = {};
const problems = [];
for (const role of roles) {
  const username = `rb.${role.id}.${TAG}`.toLowerCase().slice(0, 50);
  const password = pw();
  const body = { username, displayName: `RBAC test ${role.id} [${TAG}]`, roles: [role.id], password,
    ...(role.scope === 'store' ? { storeId: store } : {}), ...(role.scope === 'dealer' ? { dealerId: dealer } : {}), ...(role.scope === 'customer' ? { customerId: linked } : {}) };
  let r = await admin.call('/users', 'POST', body);
  if (r.status >= 300) {
    const list = (await admin.call(`/users?q=${username}`)).json; const u = (list.items ?? []).find((x) => x.username === username);
    if (!u) { problems.push(`${role.id}: cannot create user: ${r.status} ${JSON.stringify(r.json).slice(0, 140)}`); continue; }
    await admin.call(`/users/${u.id}`, 'PATCH', { status: 'ACTIVE' });
    const rr = await admin.call(`/users/${u.id}/reset-password`, 'POST', {}); const temp = rr.json.temporaryPassword ?? rr.json.password;
    if (!temp) { problems.push(`${role.id}: cannot reset password`); continue; }
    r = { json: { id: u.id } }; body.password = temp;
  }
  made.push(r.json.id);
  try { sessions[role.id] = await new Session(username).login(username, body.password); }
  catch (e) { problems.push(`${role.id}: ${e.message}`); }
}
log(`Signed in as ${Object.keys(sessions).length} of ${roles.length} role users.`);

// ── 1. the sweep ──
const results = {};
const mismatches = [];
async function pool(items, size, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } })); }
for (const role of roles) {
  const s = sessions[role.id]; if (!s) continue;
  const have = new Set(role.permissions ?? []);
  const res = results[role.id] = { routes: 0, allowedOk: 0, deniedOk: 0, over: 0, under: 0, skipped: 0, effective: [...(s.user.permissions ?? [])].length || null };
  const myPerms = s.user.permissions ? new Set(s.user.permissions) : have;
  await pool(routes, 6, async (rt) => {
    const should = rt.perms === null ? true : rt.perms.some((p) => have.has(p));
    if (rt.method !== 'GET' && rt.perms === null) { res.skipped++; return; }   // checked inside the handler, per channel
    if (rt.method !== 'GET' && !rt.hasParam && should) { res.skipped++; return; }   // would really run
    const path = rt.path.replace(/:[A-Za-z]+/g, GHOST);
    const r = await s.call(path, rt.method, rt.method === 'GET' ? undefined : {});
    if (r.status === 401) { res.skipped++; return; }
    res.routes++;
    if (should && !r.denied) res.allowedOk++;
    else if (!should && r.denied) res.deniedOk++;
    else if (!should && !r.denied) { res.over++; mismatches.push({ role: role.id, kind: 'TOO MUCH', route: `${rt.method} ${rt.path}`, needs: rt.perms, got: r.status }); }
    else { res.under++; mismatches.push({ role: role.id, kind: 'TOO LITTLE', route: `${rt.method} ${rt.path}`, needs: rt.perms, got: r.status }); }
  });
  log(`  ${role.id.padEnd(20)} ${String(res.routes).padStart(4)} routes: ${res.allowedOk} allowed, ${res.deniedOk} refused, ${res.over} too much, ${res.under} too little`);
}

// ── 2. transactions ──
const tx = [], ctx = {};
const check = (role, what, r, expect) => {
  const ok = expect === 'allow' ? r && !r.denied && r.status < 500 && r.status !== 401 : r && r.denied;
  const worked = r && r.status < 300;
  tx.push({ role, what, expect, status: r?.status, ok: !!ok, worked: !!worked, note: ok ? undefined : JSON.stringify(r?.json).slice(0, 140) });
  return r;
};
if (TX) {
  log('Transactions…');
  const jpeg = () => { const seg = (m, d) => { const l = Buffer.alloc(2); l.writeUInt16BE(d.length + 2); return Buffer.concat([Buffer.from([0xff, m]), l, d]); }; const sof = Buffer.alloc(15); sof[0] = 8; sof.writeUInt16BE(800, 1); sof.writeUInt16BE(1280, 3); sof[5] = 3; sof.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 6); return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), seg(0xfe, Buffer.from(randomUUID())), seg(0xc0, sof), seg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0])), Buffer.from('scan'), Buffer.from([0xff, 0xd9])]).toString('base64'); };
  const capture = () => ({ method: 'LIVE_CAMERA', at: new Date().toISOString(), facing: 'environment', width: 1280, height: 800 });
  const segs = (await admin.call('/settings/segments')).json; const segList = (segs.items ?? segs ?? []).filter?.((s) => s && s.id) ?? [];
  const seg = (segList.find((s) => s.individual) ?? { id: 'CONSUMER' }).id;
  const meta = (await admin.call('/meta')).json; const billDay = (meta.billCycles?.days ?? [1])[0];
  let n = 0;
  const newCustomer = (s, who) => s.call('/customers', 'POST', { context: 'order', segment: seg, displayName: `RBAC ${who} ${++n} [${TAG}]`, idDocument: `9${Date.now() % 1e6}${n}${TAG}${randomBytes(2).toString('hex')}`,
    email: `rbac.${who}.${n}.${Date.now() % 1e5}@example.com`, phone: `+60${12}${String(Date.now()).slice(-7)}`, dateOfBirth: '1990-04-12', gender: 'FEMALE',
    address: { line1: '1 Jalan Test', city: 'Kuala Lumpur', postcode: '50450', state: 'WP Kuala Lumpur', country: 'MY' }, account: { billCycleDay: billDay },
    identity: { idType: 'NATIONAL_ID', idExpiry: '2031-05-15', nationality: 'Malaysian', dateOfBirth: '1990-04-12', documents: ['ID_FRONT', 'ID_BACK', 'SELFIE'].map((kind) => ({ kind, dataBase64: jpeg(), capture: capture() })) } });
  // a sellable plan
  const cat = (await admin.call('/catalog?limit=50&status=ACTIVE&forSale=1')).json.items ?? [];
  let plan;
  for (const o of cat) { if (!o.fulfilment?.requiresSimActivation || o.group?.isGroupOffer || o.variants?.length) continue; const q = await admin.call('/orders/quote', 'POST', { channel: 'CALL_CENTER', lines: [{ offerId: o.id }] }); if (q.status < 300) { plan = o; break; } }
  const orderBody = (customerId, channel, extra = {}) => ({ customerId, channel, lines: [{ offerId: plan.id, simType: 'ESIM' }], payment: { method: 'CASH', confirmed: true, reference: `${TAG}-${randomBytes(3).toString('hex')}` }, ...extra });
  const S = (id) => sessions[id];
  const can = (id, perm) => (roles.find((r) => r.id === id)?.permissions ?? []).includes(perm) ? 'allow' : 'deny';
  const has = (id) => !!S(id);

  if (has('call-center')) {
    const c = check('call-center', 'create a customer with identity photos', await newCustomer(S('call-center'), 'cc'), can('call-center', 'customer:create'));
    const cid = c.json?.customer?.id ?? (await newCustomer(admin, 'cc')).json?.customer?.id;   // when the role cannot, an administrator makes the customer the rest of the test needs
    if (!c.json?.customer?.id) ctx.kycCase = undefined;
    if (cid && plan) {
      check('call-center', 'place a call-centre order', await S('call-center').call('/orders', 'POST', orderBody(cid, 'CALL_CENTER'), { 'idempotency-key': randomUUID() }), 'allow');
      check('call-center', 'place a TELESALES order (not theirs)', await S('call-center').call('/orders', 'POST', orderBody(cid, 'TELESALES'), { 'idempotency-key': randomUUID() }), 'deny');
    }
    check('call-center', 'decide an identity check (not theirs)', await S('call-center').call(`/kyc/cases/${GHOST}/decision`, 'POST', { decision: 'APPROVE' }), 'deny');
    check('call-center', 'start a bill run (not theirs)', await S('call-center').call('/billing/runs', 'POST', { accountIds: [GHOST] }), 'deny');
    check('call-center', 'raise a fraud alert (not theirs)', await S('call-center').call('/fraud/alerts', 'POST', { kind: 'MANUAL', summary: 'x' }), 'deny');
    ctx.kycCase = c.json?.kyc?.caseId ?? ctx.kycCase;
    ctx.customer = cid;
  }
  if (has('telesales') && ctx.customer && plan) {
    check('telesales', 'place a TELESALES order', await S('telesales').call('/orders', 'POST', orderBody(ctx.customer, 'TELESALES'), { 'idempotency-key': randomUUID() }), 'allow');
    check('telesales', 'place a call-centre order (not theirs)', await S('telesales').call('/orders', 'POST', orderBody(ctx.customer, 'CALL_CENTER'), { 'idempotency-key': randomUUID() }), 'deny');
    check('telesales', 'create a catalog offer (not theirs)', await S('telesales').call('/catalog', 'POST', {}), 'deny');
  }
  if (has('compliance')) {
    if (ctx.kycCase) check('compliance', 'approve a pending identity check', await S('compliance').call(`/kyc/cases/${ctx.kycCase}/decision`, 'POST', { decision: 'APPROVE' }), 'allow');
    else check('compliance', 'open the identity review queue', await S('compliance').call('/kyc/cases?limit=5'), 'allow');
    check('compliance', 'place an order (not theirs)', await S('compliance').call('/orders', 'POST', { customerId: GHOST, channel: 'CALL_CENTER', lines: [] }), 'deny');
    check('compliance', 'take a payment (not theirs)', await S('compliance').call(`/invoices/${GHOST}/pay`, 'POST', { amountMinor: 100, method: 'CASH' }), 'deny');
  }
  if (has('customer-service') && ctx.customer) {
    const it = check('customer-service', 'log an interaction', await S('customer-service').call('/interactions', 'POST', { customerId: ctx.customer, channel: 'CALL_CENTER', direction: 'INBOUND', subject: 'RBAC test call', summary: 'Logged by the role test', durationSec: 60, occurredAt: new Date().toISOString() }), 'allow');
    const k = check('customer-service', 'open a case', await S('customer-service').call('/cases', 'POST', { customerId: ctx.customer, type: 'GENERAL', subject: 'RBAC test case', severity: 'MINOR_INQUIRY', priority: 'NORMAL', note: 'Role test', channel: 'CALL_CENTER' }), 'allow');
    const kid = k.json?.id ?? k.json?.case?.id;
    if (kid) check('customer-service', 'add a note to the case', await S('customer-service').call(`/cases/${kid}/notes`, 'POST', { text: 'Role test note' }), 'allow');
    check('customer-service', 'start a bill run (not theirs)', await S('customer-service').call('/billing/runs', 'POST', { accountIds: [GHOST] }), 'deny');
    check('customer-service', 'decide an identity check (not theirs)', await S('customer-service').call(`/kyc/cases/${GHOST}/decision`, 'POST', { decision: 'APPROVE' }), 'deny');
  }
  if (has('fraud')) {
    check('fraud', 'raise a fraud alert', await S('fraud').call('/fraud/alerts', 'POST', { kind: 'MANUAL', severity: 'LOW', summary: 'RBAC role test' }), 'allow');
    check('fraud', 'add a blacklist entry', await S('fraud').call('/fraud/blacklist', 'POST', { kind: 'ID_DOCUMENT', value: `BL-${TAG}-${randomBytes(3).toString('hex')}`, reason: 'RBAC role test' }), 'allow');
    check('fraud', 'place an order (not theirs)', await S('fraud').call('/orders', 'POST', { customerId: GHOST, channel: 'CALL_CENTER', lines: [] }), 'deny');
  }
  if (has('billing-ops') && ctx.customer) {
    const acc = (await admin.call(`/customers/${ctx.customer}`)).json?.accounts?.[0]?.id ?? (await admin.call(`/accounts?customerId=${ctx.customer}`)).json?.items?.[0]?.id;
    if (acc) check('billing-ops', 'start a selective bill run', await S('billing-ops').call('/billing/runs', 'POST', { accountIds: [acc], asOf: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), note: `${TAG} role test` }), can('billing-ops', 'billing:run'));
    check('billing-ops', 'approve a bill run', await S('billing-ops').call(`/billing/runs/${GHOST}/approve`, 'POST', { execute: false }), can('billing-ops', 'billing:approve'));
    check('billing-ops', 'decide an identity check (not theirs)', await S('billing-ops').call(`/kyc/cases/${GHOST}/decision`, 'POST', { decision: 'APPROVE' }), 'deny');
    check('billing-ops', 'raise a fraud alert (not theirs)', await S('billing-ops').call('/fraud/alerts', 'POST', { kind: 'MANUAL', summary: 'x' }), 'deny');
  }
  if (has('finance')) {
    check('finance', 'read invoices', await S('finance').call('/invoices?limit=5'), 'allow');
    check('finance', 'take a payment on an invoice', await S('finance').call(`/invoices/${GHOST}/pay`, 'POST', { amountMinor: 100, method: 'CASH' }), can('finance', 'billing:pay'));
    check('finance', 'issue a credit note', await S('finance').call(`/invoices/${GHOST}/credit`, 'POST', { amountMinor: 100, reason: 'RBAC role test' }), can('finance', 'billing:credit'));
    check('finance', 'approve a bill run', await S('finance').call(`/billing/runs/${GHOST}/approve`, 'POST', { execute: false }), can('finance', 'billing:approve'));
    check('finance', 'create a catalog offer (not theirs)', await S('finance').call('/catalog', 'POST', {}), 'deny');
    check('finance', 'create a user (not theirs)', await S('finance').call('/users', 'POST', { username: 'nope', displayName: 'x', roles: ['admin'] }), 'deny');
  }
  if (has('inventory-ops')) {
    check('inventory-ops', 'read stock', await S('inventory-ops').call('/inventory?limit=5'), 'allow');
    check('inventory-ops', 'check a stock file (no change)', await S('inventory-ops').call('/inventory/import', 'POST', { csv: 'location_id,sku,quantity,action\r\nWH-MAIN,RBAC-NONE,1,RECEIVE\r\n', apply: false }), 'allow');
    check('inventory-ops', 'take a payment (not theirs)', await S('inventory-ops').call(`/invoices/${GHOST}/pay`, 'POST', { amountMinor: 100, method: 'CASH' }), 'deny');
  }
  for (const id of ['retail-store', 'retail-manager']) if (has(id) && store && plan && ctx.customer) {
    check(id, 'sell at their own store', await S(id).call('/orders', 'POST', orderBody(ctx.customer, 'RETAIL_ASSISTED', { storeId: store }), { 'idempotency-key': randomUUID() }), 'allow');
    check(id, 'place a call-centre order (not theirs)', await S(id).call('/orders', 'POST', orderBody(ctx.customer, 'CALL_CENTER'), { 'idempotency-key': randomUUID() }), 'deny');
    check(id, 'start a bill run (not theirs)', await S(id).call('/billing/runs', 'POST', { accountIds: [GHOST] }), 'deny');
    check(id, 'read the store desk', await S(id).call('/store/sales'), can(id, 'store:report'));
  }
  if (has('product-configurator')) {
    check('product-configurator', 'read the catalog', await S('product-configurator').call('/catalog?limit=5'), 'allow');
    check('product-configurator', 'create a catalog offer (needs a valid body, so a refusal is fine)', await S('product-configurator').call('/catalog', 'POST', {}), 'allow');
    check('product-configurator', 'take a payment (not theirs)', await S('product-configurator').call(`/invoices/${GHOST}/pay`, 'POST', { amountMinor: 100, method: 'CASH' }), 'deny');
  }
  if (has('admin')) {
    check('admin', 'create a user', await S('admin').call('/users', 'POST', { username: `rb.extra.${TAG}`.toLowerCase(), displayName: `RBAC extra [${TAG}]`, roles: ['call-center'], password: pw() }), 'allow');
    check('admin', 'place an order (not theirs, if admin cannot sell)', await S('admin').call('/orders', 'POST', { customerId: GHOST, channel: 'CALL_CENTER', lines: [] }), roles.find((r) => r.id === 'admin').permissions.includes('order:create:CALL_CENTER') ? 'allow' : 'deny');
  }
  const tryUser = (await admin.call(`/users?q=rb.extra.${TAG}`.toLowerCase())).json.items?.[0]; if (tryUser) made.push(tryUser.id);
}
const txRows = tx.filter((x) => x.role);
log('\nTransactions:');
for (const t of txRows) log(`  ${t.ok ? 'PASS' : 'FAIL'}  ${t.role.padEnd(20)} ${t.what} → ${t.status}${t.expect === 'deny' ? ' (refused as it should be)' : t.worked ? '' : ' (allowed through the permission check; the request itself was refused)'}${t.ok ? '' : '  ' + t.note}`);

if (!KEEP) for (const id of made) await admin.call(`/users/${id}`, 'PATCH', { status: 'DISABLED' });
const sweepBad = mismatches.length, txBad = txRows.filter((t) => !t.ok).length;
log(`\nSweep: ${Object.values(results).reduce((a, r) => a + r.routes, 0)} checks, ${sweepBad} mismatches. Transactions: ${txRows.length - txBad} of ${txRows.length} as expected.`);
if (problems.length) log('Setup problems:\n  ' + problems.join('\n  '));
for (const m of mismatches.slice(0, 40)) log(`  ${m.kind}: ${m.role} ${m.route} needs ${JSON.stringify(m.needs)} → ${m.got}`);
writeFileSync(`rbac-report-${TAG}.json`, JSON.stringify({ base: BASE, tag: TAG, results, mismatches, transactions: txRows, problems }, null, 2));
log(`Report written to rbac-report-${TAG}.json`);
