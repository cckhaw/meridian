#!/usr/bin/env node
/**
 * Fills a Meridian system with a realistic load of transactions through its public API, so every module has data to look at:
 * customers (with identity photographs and KYC decisions), orders on every channel, service changes, groups, cases, interactions, bill runs,
 * invoices, payments, credits, dealers and fraud entries.
 *
 *   BASE=https://meridian.example.com ADMIN_USER=root ADMIN_PASS=… node scripts/load-test/run.mjs [--customers 60] [--seed 7] [--tag LT] [--dry]
 *   (ADMIN_OTP=123456 if the admin account asks for a second factor)
 *
 * It uses the products already in the system (nothing is invented) and tags everything it creates: customer names end in “[LT]”, ID numbers carry the
 * tag, references start with LT-. It needs an administrator (to create three short-lived staff logins: compliance, finance and agent, which it disables
 * again at the end) and never deletes anything. Run it against a copy first.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null)).filter(Boolean));
const BASE = (process.env.BASE ?? args.base ?? 'http://localhost:3111').replace(/\/$/, '');
const N = Number(args.customers ?? 60);
const TAG = String(args.tag ?? 'LT');
const DRY = !!args.dry;
const KEEP_USERS = !!args['keep-users'];

// ─────────────────────────── small helpers ───────────────────────────
let seed = Number(args.seed ?? Date.now() % 100000);
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = {};
const errors = {};
const note = (k, ok, err) => { (stats[k] ??= { ok: 0, failed: 0 })[ok ? 'ok' : 'failed']++; if (!ok) { const e = (errors[k] ??= []); if (e.length < 3 && !e.includes(err)) e.push(err); } };
const log = (...a) => console.log(...a);

class Session {
  constructor(name) { this.name = name; this.cookie = ''; }
  async call(path, method = 'GET', body, headers = {}) {
    const r = await fetch(`${BASE}/api${path}`, { method, headers: { 'content-type': 'application/json', origin: BASE, ...(this.cookie ? { cookie: this.cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
    const set = r.headers.get('set-cookie'); const m = set && /((?:__Host-)?meridian_session=[^;]+)/.exec(set); if (m) this.cookie = m[1];
    return { status: r.status, ok: r.status < 300, json };
  }
  async login(username, password, otp) {
    let r = await this.call('/auth/login', 'POST', { username, password });
    if (r.json?.mfaRequired) {
      if (!otp) throw new Error(`${username} needs a second factor: set ADMIN_OTP`);
      r = await this.call('/auth/verify-2fa', 'POST', { challenge: r.json.challenge.token, code: otp });
    }
    if (!r.ok) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    this.user = r.json.user; return this;
  }
}
/** Runs one step and records whether it worked, so one bad call does not stop the load. */
async function step(key, fn) {
  try { const r = await fn(); if (r && r.status && r.status >= 300) { note(key, false, `${r.status} ${r.json?.error?.message ?? JSON.stringify(r.json).slice(0, 120)}`); return null; } note(key, true); return r; }
  catch (e) { note(key, false, String(e.message).slice(0, 160)); return null; }
}
async function pool(items, size, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

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

// ─────────────────────────── start ───────────────────────────
const t0 = Date.now();
const admin = new Session('admin');
await admin.login(process.env.ADMIN_USER ?? 'root', process.env.ADMIN_PASS ?? '', process.env.ADMIN_OTP);
log(`Signed in to ${BASE} as ${admin.user.username}. Target: ${N} customers, tag ${TAG}${DRY ? ' (dry run: nothing is written)' : ''}.`);

const me = admin.user;
const market = me.marketCode ?? 'MY';
const meta = (await admin.call('/meta')).json;
const segments = (await admin.call('/settings/segments')).json;
const segList = (segments.items ?? segments ?? []).filter?.((s) => s && s.id) ?? [];
const individualSeg = (segList.find((s) => s.individual) ?? { id: 'CONSUMER' }).id;
const companySeg = segList.find((s) => !s.individual && /enterprise|business|corporate|sme/i.test(s.id + s.name))?.id ?? segList.find((s) => !s.individual)?.id;
const billDays = meta.billCycles?.days ?? Array.from({ length: 28 }, (_, i) => i + 1);

// ── products already in the system ──
const catalog = [];
for (let cursor = '', i = 0; i < 20; i++) {
  const r = await admin.call(`/catalog?limit=50&status=ACTIVE&forSale=1&market=${market}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  catalog.push(...(r.json.items ?? [])); cursor = r.json.nextCursor; if (!cursor) break;
}
log(`Found ${catalog.length} offers on sale in market ${market}.`);
if (!catalog.length) throw new Error('No offers on sale: create products first.');
const sellable = [];
for (const o of catalog) {
  const q = await admin.call('/orders/quote', 'POST', { channel: 'CALL_CENTER', lines: [{ offerId: o.id, ...(o.variants?.length ? { options: { variantId: o.variants[0].id } } : {}) }] });
  if (q.ok) sellable.push({ ...o, needs: q.json.needs ?? {} });
}
const isGroup = (o) => !!o.group?.isGroupOffer;
const hasSim = (o) => !!o.fulfilment?.requiresSimActivation;
const plans = sellable.filter((o) => hasSim(o) && !isGroup(o) && !o.variants?.length && (o.prices ?? []).some((p) => p.type === 'RECURRING'));
const devices = sellable.filter((o) => o.variants?.length);
const fibre = sellable.filter((o) => o.fulfilment?.requiresInstallation);
const goods = sellable.filter((o) => !hasSim(o) && !o.variants?.length && !o.fulfilment?.requiresInstallation && (o.prices ?? []).some((p) => p.type === 'ONE_TIME') && !(o.prices ?? []).some((p) => p.type === 'RECURRING'));
const groupPlans = sellable.filter(isGroup);
log(`Sellable: ${plans.length} plans, ${devices.length} devices, ${fibre.length} fibre, ${goods.length} goods, ${groupPlans.length} group plans.`);
if (DRY) { log('Dry run done.'); process.exit(0); }

// ── staff for the work that needs a second person ──
const pw = () => `Lt-${randomBytes(9).toString('base64url')}-9a!`;
const made = [];
async function staffUser(username, roles) {
  const password = pw();
  let r = await admin.call('/users', 'POST', { username, displayName: `Load test ${roles[0]}`, roles, password });
  if (!r.ok) {   // left over from an earlier run: give it a new password
    const list = (await admin.call(`/users?q=${username}`)).json; const u = (list.items ?? []).find((x) => x.username === username);
    if (!u) throw new Error(`cannot create ${username}: ${JSON.stringify(r.json).slice(0, 150)}`);
    await admin.call(`/users/${u.id}`, 'PATCH', { status: 'ACTIVE', roles });
    r = await admin.call(`/users/${u.id}/reset-password`, 'POST', {});
    const temp = r.json.temporaryPassword ?? r.json.password; if (!temp) throw new Error(`cannot reset ${username}`);
    const s = new Session(username); await s.login(username, temp);
    await s.call('/auth/change-password', 'POST', { current: temp, next: password }); const s2 = new Session(username); await s2.login(username, password); made.push(r.json.id ?? u.id); return s2;
  }
  const s = new Session(username);
  const first = await s.call('/auth/login', 'POST', { username, password });
  if (first.json?.user?.mustChangePassword) { const next = pw(); await s.call('/auth/change-password', 'POST', { current: password, next }); const s2 = new Session(username); await s2.login(username, next); made.push(r.json.id); return s2; }
  s.user = first.json.user; made.push(r.json.id); return s;
}
const compliance = await staffUser('lt.compliance', ['compliance']);
const finance = await staffUser('lt.finance', ['finance']);
const agent = await staffUser('lt.agent', ['customer-service']);

// ── dealers (for the dealer channel and commissions) ──
const dealers = [];
for (const name of [`Metro Mobile Sdn Bhd [${TAG}]`, `Kedai Telefon Maju [${TAG}]`, `Northern Connect [${TAG}]`]) {
  const d = await step('dealers', () => admin.call('/dealers', 'POST', { name, contactName: pick(FIRST), email: `${name.split(' ')[0].toLowerCase()}@example.com`.replace(/[^a-z0-9@.]/g, ''), phone: `+6012${between(1000000, 9999999)}` }));
  if (!d) continue;
  const agents = [];
  for (let k = 0; k < 2; k++) { const a = await step('dealer agents', () => admin.call(`/dealers/${d.json.id}/agents`, 'POST', { name: `${pick(FIRST)} ${pick(LAST)}`, email: `agent${k}.${d.json.id.slice(0, 4)}@example.com`.toLowerCase() })); if (a) agents.push(a.json.id); }
  dealers.push({ id: d.json.id, agents });
}
const stores = ((await admin.call('/stores?limit=20')).json.items ?? []).filter((s) => !s.status || s.status === 'ACTIVE');

// ─────────────────────────── customers ───────────────────────────
const customers = [];
const usedIds = new Set();
const nric = (i) => { let v; do { v = `${between(70, 99)}${String(between(1, 12)).padStart(2, '0')}${String(between(1, 28)).padStart(2, '0')}${between(10, 14)}${String(between(1000, 9999))}${TAG}${i}`; } while (usedIds.has(v)); usedIds.add(v); return v; };
async function newCustomer(i) {
  const company = !!companySeg && chance(0.15);
  const [city, postcode, state] = pick(CITIES);
  const first = pick(FIRST), last = pick(LAST);
  const name = company ? `${pick(COMPANIES)} ${between(1, 99)} [${TAG}]` : `${first} ${last} [${TAG}]`;
  const dob = `${between(1960, 2002)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`;
  const idType = company ? 'NATIONAL_ID' : pick(['NATIONAL_ID', 'NATIONAL_ID', 'NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENCE']);
  const kinds = company ? ['COMPANY_REGISTRATION', 'ID_FRONT', 'ID_BACK'] : idType === 'PASSPORT' ? ['ID_FRONT', 'SELFIE'] : ['ID_FRONT', 'ID_BACK', 'SELFIE'];
  const body = {
    context: 'order', segment: company ? companySeg : individualSeg, displayName: name, idDocument: nric(i),
    email: `${first}.${last}.${i}@example.com`.toLowerCase().replace(/[^a-z0-9@.]/g, ''), phone: `+60${between(11, 19)}${between(1000000, 9999999)}`, dateOfBirth: dob, gender: pick(['FEMALE', 'MALE']),
    address: { line1: `${between(1, 99)} Jalan ${pick(LAST)}`, city, postcode, state, country: 'MY' },
    account: { billCycleDay: pick(billDays) },
    identity: { idType, idExpiry: idType === 'PASSPORT' || chance(0.5) ? `${between(2028, 2035)}-0${between(1, 9)}-15` : undefined, nationality: 'Malaysian', dateOfBirth: dob, documents: kinds.map((kind) => ({ kind, dataBase64: jpeg(), capture: capture() })) },
  };
  const r = await step('customers created', () => admin.call('/customers', 'POST', body));
  if (!r) return;
  customers.push({ id: r.json.customer.id, name, company, kycCase: r.json.kyc?.caseId, kyc: r.json.kyc?.status, accountId: r.json.account?.id ?? null, orders: [], services: [] });
}
log(`Creating ${N} customers…`);
await pool(Array.from({ length: N }, (_, i) => i), 4, newCustomer);

// ── identity reviews ──
log('Reviewing identity checks…');
for (const c of customers) {
  if (!c.kycCase || c.kyc !== 'PENDING') continue;
  const roll = rnd();
  if (roll < 0.72) { const r = await step('kyc approved', () => compliance.call(`/kyc/cases/${c.kycCase}/decision`, 'POST', { decision: 'APPROVE' })); if (r) c.verified = true; }
  else if (roll < 0.80) await step('kyc rejected', () => compliance.call(`/kyc/cases/${c.kycCase}/decision`, 'POST', { decision: 'REJECT', reason: pick(['The ID photo is cut off', 'Selfie does not match the ID', 'ID looks altered']), reasonCode: pick(['UNREADABLE', 'MISMATCH', 'SUSPECTED_FRAUD']) }));
  else if (roll < 0.87) await step('kyc sent back', () => compliance.call(`/kyc/cases/${c.kycCase}/decision`, 'POST', { decision: 'RETURN', reason: 'Please retake the back of the ID in better light', reasonCode: 'UNREADABLE' }));
  // the rest stay waiting, so the review queue has work in it
}
const approved = customers.filter((c) => c.verified);
const waiting = customers.filter((c) => !c.verified && c.kyc === 'PENDING');

// ─────────────────────────── orders ───────────────────────────
const channels = ['CALL_CENTER', 'CALL_CENTER', 'TELESALES', ...(stores.length ? ['RETAIL_ASSISTED', 'RETAIL_ASSISTED'] : []), ...(dealers.length ? ['DEALER', 'DEALER'] : [])];
function basket(c) {
  const lines = []; const roll = rnd();
  if (roll < 0.45 && plans.length) lines.push({ offerId: pick(plans).id });
  else if (roll < 0.62 && devices.length && plans.length) { const d = pick(devices); lines.push({ offerId: d.id, options: { variantId: pick(d.variants).id } }); if (chance(0.5)) lines.push({ offerId: pick(plans).id }); }
  else if (roll < 0.74 && fibre.length) lines.push({ offerId: pick(fibre).id });
  else if (roll < 0.84 && goods.length) lines.push({ offerId: pick(goods).id, quantity: between(1, 2) });
  else if (plans.length) { lines.push({ offerId: pick(plans).id }); if (goods.length && chance(0.4)) lines.push({ offerId: pick(goods).id }); }
  else if (goods.length) lines.push({ offerId: pick(goods).id });
  return lines;
}
async function placeOrder(c, forcedLines) {
  const lines = forcedLines ?? basket(c); if (!lines.length) return null;
  const channel = pick(channels);
  const body = { customerId: c.id, ...(c.accountId ? { accountId: c.accountId } : {}), channel, lines, payment: { method: pick(['CASH', 'CASH', 'QR', 'CREDIT_CARD']), reference: `${TAG}-${randomBytes(3).toString('hex')}`, confirmed: true } };
  if (channel === 'RETAIL_ASSISTED') body.storeId = pick(stores).id;
  if (channel === 'DEALER') { const d = pick(dealers); body.dealerId = d.id; if (d.agents.length) body.dealerAgentId = pick(d.agents); }
  const q = (await admin.call('/orders/quote', 'POST', { channel, customerId: c.id, ...(body.accountId ? { accountId: body.accountId } : {}), lines })).json;
  if (q?.needs?.delivery) body.deliveryAddress = `${between(1, 99)} Jalan ${pick(LAST)}, ${pick(CITIES)[0]}`;
  if (q?.needs?.installation) body.installationSlot = futureDate(between(3, 20));
  if (q?.deliveryMethods?.includes('SHIP') === false && q?.deliveryMethods?.includes('COLLECT')) body.delivery = { method: 'COLLECT', pickupStoreId: stores[0]?.id };
  const r = await step('orders placed', () => admin.call('/orders', 'POST', body, { 'idempotency-key': randomUUID() }));
  if (r) c.orders.push(r.json.id);
  return r;
}
log('Placing orders…');
const buyers = [...approved, ...waiting.slice(0, Math.ceil(waiting.length / 2))];   // some customers order while their identity is still being reviewed: the order waits
const jobs = [];
for (const c of buyers) { const n = c.verified ? between(1, 3) : 1; for (let k = 0; k < n; k++) jobs.push(c); }
await pool(jobs, 4, (c) => placeOrder(c));

// order lifecycle: some cancelled, returns left alone
const orderIds = customers.flatMap((c) => c.orders.map((id) => ({ id, c })));
for (const { id } of orderIds.filter(() => chance(0.07))) await step('orders cancelled', () => admin.call(`/orders/${id}/actions`, 'POST', { type: 'cancel', reason: pick(['Customer changed their mind', 'Found a better offer', 'Ordered by mistake']) }));

// ── services ──
log('Reading services…');
for (const c of customers) { const s = await admin.call(`/services?customerId=${c.id}&limit=50`); c.services = (s.json.items ?? []).filter((x) => x.status !== 'TERMINATED'); if (!c.accountId && c.services[0]) c.accountId = c.services[0].accountId; }
const withSvc = customers.filter((c) => c.services.length);
log(`${withSvc.length} customers have a live service.`);

// service changes
for (const c of withSvc) {
  const s = c.services.find((x) => x.type === 'MOBILE' && x.status === 'ACTIVE'); if (!s) continue;
  const roll = rnd();
  if (roll < 0.12) { const r = await step('services suspended', () => admin.call(`/services/${s.id}/actions`, 'POST', { action: 'suspend', reason: pick(['LOST_STOLEN', 'FRAUD_SUSPECTED', 'CUSTOMER_REQUEST']) })); if (r && chance(0.6)) await step('services resumed', () => admin.call(`/services/${s.id}/actions`, 'POST', { action: 'resume' })); }
  else if (roll < 0.20) await step('voluntary suspensions', () => admin.call(`/services/${s.id}/actions`, 'POST', { action: 'suspend-voluntary', months: between(1, 6) }));
  else if (roll < 0.34 && plans.length > 1) { const to = pick(plans.filter((p) => p.id !== s.offerId)); if (to) await step('plan changes', () => admin.call(`/services/${s.id}/change-plan`, 'POST', { targetOfferId: to.id, effective: pick(['IMMEDIATE', 'NEXT_BILL_CYCLE']), acceptContractTerms: true })); }
  else if (roll < 0.40 && groupPlans.length) await step('moved to a group plan', () => admin.call(`/services/${s.id}/upgrade-to-group`, 'POST', { offerId: pick(groupPlans).id }));
  else if (roll < 0.45) await step('services terminated', () => admin.call(`/services/${s.id}/actions`, 'POST', { action: 'terminate', reason: 'Customer left the operator' }));
}

// group plans with members, ordered as a family
for (const c of approved.slice(0, 6)) {
  if (!groupPlans.length || !plans.length) break;
  const gp = pick(groupPlans); const allowed = gp.group.allowedMemberOfferIds?.length ? gp.group.allowedMemberOfferIds : [plans[0].id];
  await placeOrder(c, [{ offerId: gp.id, members: Array.from({ length: Math.min(between(1, 3), gp.group.maxGroupMembers) }, () => ({ offerId: pick(allowed), simType: 'ESIM' })) }]);
}

// ─────────────────────────── interactions and cases ───────────────────────────
log('Logging interactions and opening cases…');
const caseMeta = (await admin.call('/cases/meta')).json;
const issueTypes = caseMeta.issueTypes ?? caseMeta.types ?? [];
const caseCustomers = withSvc.length ? withSvc : approved;
const interactionIds = [];
for (const c of customers.filter(() => chance(0.8))) {
  for (let k = 0; k < between(1, 4); k++) {
    const r = await step('interactions logged', () => agent.call('/interactions', 'POST', { customerId: c.id, channel: pick(['CALL_CENTER', 'WHATSAPP', 'EMAIL', 'IN_STORE', 'MOBILE_APP', 'WEB_SELF_SERVE']), direction: pick(['INBOUND', 'INBOUND', 'OUTBOUND']), subject: pick(INTERACTIONS), summary: 'Logged by the load test.', durationSec: between(30, 900), occurredAt: iso(between(0, 60)), ...(c.services[0] && chance(0.4) ? { serviceId: c.services[0].id } : {}) }));
    if (r) interactionIds.push({ id: r.json.id, customerId: c.id });
  }
}
const cases = [];
for (let i = 0; i < Math.max(12, Math.round(N * 0.7)); i++) {
  const c = pick(caseCustomers.length ? caseCustomers : customers); if (!c) break;
  const type = pick(['GENERAL', 'GENERAL', 'BILLING_REFUND', 'FIBER_ASSURANCE', 'MNP_PORT_OUT']);
  const it = issueTypes.length ? pick(issueTypes) : null;
  const r = await step('cases opened', () => agent.call('/cases', 'POST', { customerId: c.id, ...(c.services[0] && chance(0.5) ? { serviceId: c.services[0].id } : {}), type, ...(it?.id ? { issueTypeId: it.id } : {}), subject: pick(SUBJECTS[type]), severity: pick(['CRITICAL_OUTAGE', 'MAJOR_DEGRADATION', 'MINOR_INQUIRY', 'MINOR_INQUIRY']), priority: pick(['LOW', 'NORMAL', 'NORMAL', 'HIGH', 'URGENT']), note: 'Opened by the load test.', channel: pick(['CALL_CENTER', 'WHATSAPP', 'EMAIL']) }));
  if (r) cases.push({ id: r.json.id ?? r.json.case?.id, customerId: c.id, type });
}
for (const k of cases.filter((x) => x.id)) {
  const roll = rnd();
  await step('cases assigned', () => agent.call(`/cases/${k.id}/assign`, 'POST', { assignee: 'lt.agent' }));
  await step('case notes', () => agent.call(`/cases/${k.id}/notes`, 'POST', { text: pick(['Called the customer, no answer.', 'Checked the network: no outage in the area.', 'Waiting for the customer to send a photo.', 'Escalated to the second line.']) }));
  const path = roll < 0.25 || k.type === 'BILLING_REFUND' ? [] : roll < 0.5 ? ['IN_PROGRESS'] : roll < 0.65 ? ['IN_PROGRESS', 'PENDING_CUSTOMER'] : roll < 0.9 ? ['IN_PROGRESS', 'RESOLVED'] : ['IN_PROGRESS', 'RESOLVED', 'CLOSED_VERIFIED'];
  for (const st of path) await step('case status changes', () => agent.call(`/cases/${k.id}/status`, 'POST', { status: st, note: 'Updated by the load test.', ...(st === 'RESOLVED' ? { resolution: 'Resolved after checking with the customer.' } : {}) }));
}
const loose = interactionIds.filter(() => chance(0.1)).slice(0, 8);
for (const it of loose) await step('cases from interactions', () => agent.call(`/interactions/${it.id}/case`, 'POST', { subject: 'Follow-up from a call', severity: 'MINOR_INQUIRY' }));

// ─────────────────────────── billing ───────────────────────────
log('Running billing…');
const accountIds = [...new Set(customers.map((c) => c.accountId).filter(Boolean))];
const invoices = [];
if (accountIds.length) {
  const run = await step('bill runs created', () => admin.call('/billing/runs', 'POST', { accountIds: accountIds.slice(0, 500), asOf: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), note: `${TAG} load test` }));
  if (run) {
    const id = run.json.id ?? run.json.run?.id;
    for (let i = 0; i < 40; i++) { const w = await admin.call(`/billing/runs/${id}/work`, 'POST'); if (!w.json.busy && w.json.status && !['QUEUED', 'MOCKING', 'RUNNING'].includes(w.json.status)) break; await sleep(500); }
    await step('bill runs submitted', () => admin.call(`/billing/runs/${id}/submit`, 'POST', { note: 'Load test' }));
    const ap = await step('bill runs approved', () => finance.call(`/billing/runs/${id}/approve`, 'POST', { note: 'Load test', execute: true }));
    if (ap) for (let i = 0; i < 40; i++) { const w = await admin.call(`/billing/runs/${id}/work`, 'POST'); if (!w.json.busy && ['COMPLETED', 'DONE', 'EXECUTED', 'BILLED'].includes(w.json.status)) break; await sleep(500); }
    log(`  bill run ${id}: ${(await admin.call(`/billing/runs/${id}`)).json.status}`);
  }
  for (const c of customers.filter((x) => x.accountId)) {
    const r = await admin.call(`/invoices?customerId=${c.id}&limit=20`);
    for (const inv of r.json.items ?? []) invoices.push({ ...inv, customerId: c.id });
  }
}
log(`${invoices.length} invoices exist for these customers.`);

// payments, part payments, credits; the rest stay open so there is something to chase
for (const inv of invoices) {
  const open = inv.balanceMinor ?? inv.outstandingMinor ?? inv.totalMinor; if (!open || open <= 0) continue;
  const roll = rnd();
  if (roll < 0.55) await step('invoices paid', () => admin.call(`/invoices/${inv.id}/pay`, 'POST', { method: pick(['CASH', 'QR', 'CREDIT_CARD']), reference: `${TAG}-${randomBytes(3).toString('hex')}`, idempotencyKey: randomUUID() }));
  else if (roll < 0.68 && open > 200) await step('part payments', () => admin.call(`/invoices/${inv.id}/pay`, 'POST', { amountMinor: Math.floor(open / 2), method: 'CASH', reference: `${TAG}-${randomBytes(3).toString('hex')}`, idempotencyKey: randomUUID() }));
  else if (roll < 0.76 && open > 500) await step('credit notes', () => admin.call(`/invoices/${inv.id}/credit`, 'POST', { amountMinor: Math.min(open, between(100, 500)), reason: 'Goodwill credit after a complaint' }));
}
// refund requests on billing cases
for (const k of cases.filter((x) => x.id && x.type === 'BILLING_REFUND').slice(0, 10)) {
  const inv = invoices.find((i) => i.customerId === k.customerId); if (!inv) continue;
  const total = inv.totalMinor ?? 1000;
  const r = await step('refunds requested', () => agent.call(`/cases/${k.id}/refunds`, 'POST', { invoiceId: inv.id, amountMinor: Math.max(100, Math.floor(total / 4)), reason: 'Customer was charged twice' }));
  if (r && /PENDING/.test(String(r.json.status ?? '')) && chance(0.6)) await step('refunds decided', () => admin.call(`/refunds/${r.json.id}/decision`, 'POST', { decision: chance(0.8) ? 'APPROVE' : 'REJECT', note: 'Reviewed by the load test' }));
}

// ─────────────────────────── collections, fraud, porting ───────────────────────────
log('Collections and fraud…');
await step('dunning run', () => admin.call('/billing/dunning', 'POST', {}));
for (const a of accountIds.filter(() => chance(0.15)).slice(0, 15)) await step('collections run', () => admin.call(`/accounts/${a}/collections/run`, 'POST', {}));
await step('fraud scan', () => admin.call('/fraud/scan', 'POST', {}));
for (const c of withSvc.filter(() => chance(0.1)).slice(0, 8)) await step('fraud alerts raised', () => admin.call('/fraud/alerts', 'POST', { serviceId: c.services[0].id, kind: pick(['SIM_SWAP_ANOMALY', 'USAGE_SPIKE', 'MANUAL', 'OTHER']), severity: pick(['LOW', 'MEDIUM', 'HIGH']), summary: 'Raised by the load test.' }));
for (let i = 0; i < 4; i++) await step('blacklist entries', () => admin.call('/fraud/blacklist', 'POST', { kind: 'ID_DOCUMENT', value: `BL-${TAG}-${randomBytes(4).toString('hex')}`, reason: 'Known fraud pattern (load test)' }));

// ─────────────────────────── tidy up ───────────────────────────
if (!KEEP_USERS) for (const id of made) await admin.call(`/users/${id}`, 'PATCH', { status: 'DISABLED' });

const counts = {};
for (const [k, p] of [['customers', '/customers?limit=1'], ['orders', '/orders?limit=1'], ['cases', '/cases?limit=1'], ['interactions', '/interactions?limit=1'], ['invoices', '/invoices?limit=1']]) { const r = await admin.call(p); counts[k] = r.json.total ?? r.json.count ?? undefined; }
const report = { base: BASE, tag: TAG, minutes: Math.round((Date.now() - t0) / 600) / 100, stats, errors, customers: customers.length, customersApproved: approved.length, customersWaiting: waiting.length, dealers: dealers.length, invoices: invoices.length, sample: customers.slice(0, 5).map((c) => ({ id: c.id, name: c.name })) };
writeFileSync(`load-test-report-${TAG}.json`, JSON.stringify(report, null, 2));
log('\nDone in', report.minutes, 'min. What happened:');
for (const [k, v] of Object.entries(stats)) log(`  ${k.padEnd(26)} ${String(v.ok).padStart(5)} ok${v.failed ? `, ${v.failed} failed` : ''}`);
if (Object.keys(errors).length) { log('\nSome calls were refused (first examples):'); for (const [k, e] of Object.entries(errors)) log(`  ${k}: ${e.join(' | ')}`); }
log(`\nReport written to load-test-report-${TAG}.json`);
