import { createHmac } from 'node:crypto';
import { createUser, getDb, type Db, type NewUser } from '@meridian/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from './router';

const SU = { username: 'root-admin', password: 'Correct-Horse-Battery-9' };
process.env.MERIDIAN_SUPERUSER_USERNAME = SU.username;
process.env.MERIDIAN_SUPERUSER_PASSWORD = SU.password;
process.env.MERIDIAN_SEED = 'starter';
process.env.MERIDIAN_PAYMENT_MODE = 'simulated';
delete process.env.DATABASE_URL;

const ORIGIN = 'http://localhost';
let db: Db;
beforeAll(async () => { db = await getDb(); });
afterAll(async () => { await db.close(); });

interface Res { status: number; json: any; headers: Headers; text: string }
async function call(method: string, path: string, o: { body?: unknown; cookie?: string; origin?: string | null; headers?: Record<string, string>; raw?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json', host: 'localhost', ...(o.headers ?? {}) };
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.cookie) headers.cookie = o.cookie;
  const body = method === 'GET' || method === 'HEAD' ? undefined : (o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)));
  const res = await dispatch(new Request(`http://localhost/api${path}`, { method, headers, body }), path.split('?')[0]!.split('/').filter(Boolean));
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, headers: res.headers, text };
}
const cookieOf = (r: Res) => /(?:__Host-)?meridian_session=[^;]+/.exec(r.headers.get('set-cookie') ?? '')?.[0];

async function signIn(username: string, password: string, ip = '10.0.0.1') {
  const r = await call('POST', '/auth/login', { body: { username, password }, headers: { 'x-forwarded-for': ip } });
  return { res: r, cookie: cookieOf(r) };
}
let n = 0;
/** A working staff user: created through the admin API path, past the forced password change. */
async function staff(roles: string[], extra: Partial<NewUser> = {}) {
  const username = `u${++n}.${roles[0]}`.slice(0, 40);
  const password = `Passphrase-${n}-Strong-Enough`;
  const { user } = await createUser(db, 'test', { username, displayName: username, roles, password, ...extra });
  await db.query('UPDATE users SET must_change_password=false WHERE id=$1', [user.id]);
  const { cookie } = await signIn(username, password, `10.1.${n}.1`);
  return { id: user.id as string, username, cookie: cookie!, password };
}
const root = async () => (await signIn(SU.username, SU.password, '10.9.9.9')).cookie!;

const customer = async (cookie: string, name = `Cust ${++n}`) =>
  (await call('POST', '/customers', { cookie, body: { segment: 'CONSUMER', displayName: name, idDocument: `ID${n}${Math.random().toString(36).slice(2, 7)}` } })).json.customer.id as string;

describe('authentication', () => {
  it('serves health without a session but nothing else', async () => {
    expect((await call('GET', '/health', { origin: null })).status).toBe(200);
    for (const p of ['/dashboard', '/customers', '/orders', '/invoices', '/users', '/catalog', '/auth/me']) expect((await call('GET', p)).status, p).toBe(401);
    expect((await call('GET', '/nope')).status).toBe(404);
  });

  it('super user signs in from the environment and gets an HttpOnly SameSite cookie', async () => {
    const r = await call('POST', '/auth/login', { body: SU });
    expect(r.status).toBe(200);
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/SameSite=Lax/); expect(sc).toMatch(/Path=\//);
    expect(r.json.user).toMatchObject({ username: SU.username, isSuperuser: true });
    expect(r.json.user.modules.map((m: any) => m.id)).toEqual(expect.arrayContaining(['users', 'finance', 'customers', 'audit']));
    expect(r.text).not.toMatch(/password_?hash|scrypt/i);
    const me = await call('GET', '/auth/me', { cookie: cookieOf(r) });
    expect(me.json.user.username).toBe(SU.username);
  });

  it('rejects bad credentials with one generic message, and throttles guessing', async () => {
    const a = await signIn(SU.username, 'wrong-password-123', '10.7.7.1');
    const b = await signIn('no.such.user', 'wrong-password-123', '10.7.7.2');
    expect(a.res.status).toBe(401); expect(b.res.status).toBe(401);
    expect(a.res.json.error.message).toBe(b.res.json.error.message);
    let last = 0;
    for (let i = 0; i < 14; i++) last = (await signIn('guess.target', 'wrong-password-123', `10.8.8.${i}`)).res.status;
    expect(last).toBe(429);
  });

  it('blocks cross-site and missing-origin state changes (CSRF)', async () => {
    expect((await call('POST', '/auth/login', { body: SU, origin: null })).status).toBe(403);
    expect((await call('POST', '/auth/login', { body: SU, origin: 'https://evil.example' })).status).toBe(403);
    const ck = await root();
    expect((await call('POST', '/customers', { cookie: ck, origin: 'https://evil.example', body: {} })).status).toBe(403);
  });

  it('logout ends the session server-side', async () => {
    const u = await staff(['call-center']);
    expect((await call('GET', '/customers', { cookie: u.cookie })).status).toBe(200);
    await call('POST', '/auth/logout', { cookie: u.cookie, body: {} });
    expect((await call('GET', '/customers', { cookie: u.cookie })).status).toBe(401);
  });

  it('forces a new user to change the temporary password before doing anything', async () => {
    const ck = await root();
    const created = await call('POST', '/users', { cookie: ck, body: { username: 'new.agent', displayName: 'New Agent', roles: ['call-center'] } });
    expect(created.status).toBe(200);
    const temp = created.json.temporaryPassword as string;
    const s = await signIn('new.agent', temp, '10.3.3.3');
    expect(s.res.json.user.mustChangePassword).toBe(true);
    expect(s.res.json.user.home).toBe('/change-password');
    expect((await call('GET', '/customers', { cookie: s.cookie })).json.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await call('POST', '/auth/change-password', { cookie: s.cookie, body: { current: temp, next: 'short' } })).status).toBe(400);
    expect((await call('POST', '/auth/change-password', { cookie: s.cookie, body: { current: temp, next: 'My-Own-Passphrase-2024' } })).status).toBe(200);
    expect((await call('GET', '/customers', { cookie: s.cookie })).status).toBe(401); // old session is gone
    const again = await signIn('new.agent', 'My-Own-Passphrase-2024', '10.3.3.4');
    expect((await call('GET', '/customers', { cookie: again.cookie })).status).toBe(200);
  });
});

describe('role-based access', () => {
  it('a call-center agent can work the Customer 360 but nothing outside their role', async () => {
    const agent = await staff(['call-center']);
    const c = await customer(await root());   // call-center agents serve existing customers; onboarding is a sales role
    expect((await call('POST', '/customers', { cookie: agent.cookie, body: { segment: 'CONSUMER', displayName: 'x', idDocument: 'S0000000A' } })).status).toBe(403);
    const r360 = await call('GET', `/customers/${c}`, { cookie: agent.cookie });
    expect(r360.status).toBe(200);
    expect(r360.json.customer.displayName).toMatch(/Cust/);
    expect((await call('GET', '/services?customerId=' + c, { cookie: agent.cookie })).status).toBe(200);
    expect((await call('POST', '/cases', { cookie: agent.cookie, body: { customerId: c, type: 'GENERAL', subject: 'Billing question' } })).status).toBe(200);
    for (const [m, p] of [['GET', '/gl'], ['GET', '/gl/reconcile'], ['POST', '/gl/export'], ['GET', '/users'], ['POST', '/users'], ['POST', '/billing/run'], ['GET', '/audit'], ['POST', '/catalog'], ['GET', '/commissions'], ['POST', '/inventory/adjust']] as const)
      expect((await call(m, p, { cookie: agent.cookie, body: {} })).status, `${m} ${p}`).toBe(403);
    const inv = (await call('GET', '/invoices', { cookie: agent.cookie }));
    expect(inv.status).toBe(200);
    expect((await call('POST', `/invoices/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/credit`, { cookie: agent.cookie, body: { amountMinor: 100, reason: 'test' } })).status).toBe(403); // no credit permission
  });

  it('each channel needs its own permission, and the seller is taken from the session, not the request', async () => {
    const tele = await staff(['telesales']); const dealer = await staff(['dealer'], { dealerId: 'D-1' }); const retail = await staff(['retail-store'], { storeId: 'STORE-SG-001' });
    const c = await customer(tele.cookie);
    const order = (cookie: string, channel: string, extra: object = {}) => call('POST', '/orders', { cookie, body: { channel, customerId: c, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH', confirmed: true }, ...extra } });
    expect((await order(tele.cookie, 'RETAIL_ASSISTED')).status).toBe(403);
    expect((await order(dealer.cookie, 'TELESALES')).status).toBe(403);
    expect((await order(retail.cookie, 'DEALER')).status).toBe(403);
    const ok = await order(tele.cookie, 'TELESALES', { salespersonId: 'someone-else', attribution: { salespersonId: 'someone-else' } });
    expect(ok.status).toBe(200);
    expect(ok.json.salespersonId).toBe(tele.username);
    expect(ok.json.createdBy).toBe(tele.username);
  });

  it('customer service can refund within a limit; billing and finance can exceed it; call center cannot', async () => {
    const root_ = await root();
    const c = await customer(root_);
    const acct = (await call('GET', `/customers/${c}`, { cookie: root_ })).json.accounts[0].id;
    await db.query('UPDATE accounts SET bill_cycle_day=1 WHERE id=$1', [acct]);
    const o = await call('POST', '/orders', { cookie: root_, body: { channel: 'CALL_CENTER', customerId: c, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH', confirmed: true, reference: 'R1' } } });
    expect(o.json.state).toBe('COMPLETED');
    await db.query(`UPDATE services SET activated_at = now() - interval '100 days' WHERE customer_id=$1`, [c]);
    const day = new Date().toISOString().slice(0, 10);
    await db.query('UPDATE accounts SET bill_cycle_day=$2 WHERE id=$1', [acct, Number(day.slice(8))]);
    await call('POST', '/billing/run', { cookie: root_, body: { asOf: day, accountId: acct } });
    const inv = (await call('GET', `/invoices?customerId=${c}`, { cookie: root_ })).json.items[0];
    expect(inv.totalMinor).toBeGreaterThan(0);

    const cs = await staff(['customer-service']); const bo = await staff(['billing-ops']); const cc = await staff(['call-center']);
    const credit = (cookie: string, amountMinor: number) => call('POST', `/invoices/${inv.id}/credit`, { cookie, body: { amountMinor, reason: 'goodwill gesture' } });
    expect((await credit(cc.cookie, 100)).status).toBe(403);
    await db.query('UPDATE invoices SET total_minor = 50000, net_minor = 45872, tax_minor = 4128 WHERE id=$1', [inv.id]);
    expect((await credit(cs.cookie, 20_001)).status).toBe(403);
    expect((await credit(cs.cookie, 20_000)).status).toBe(200);
    expect((await credit(bo.cookie, 25_000)).status).toBe(200);
  });

  it('only user administrators manage users, and changes take effect immediately', async () => {
    const admin = await staff(['admin']); const agent = await staff(['call-center']);
    expect((await call('GET', '/users', { cookie: agent.cookie })).status).toBe(403);
    expect((await call('GET', '/users', { cookie: admin.cookie })).status).toBe(200);
    expect((await call('GET', '/customers', { cookie: agent.cookie })).status).toBe(200);
    await call('PATCH', `/users/${agent.id}`, { cookie: admin.cookie, body: { roles: ['finance'] } });
    expect((await call('GET', '/customers', { cookie: agent.cookie })).status).toBe(401);          // session revoked on role change
    const re = await signIn(agent.username, agent.password, '10.5.5.5');
    expect((await call('GET', '/customers', { cookie: re.cookie })).status).toBe(200);              // finance can search customers
    expect((await call('GET', '/gl/reconcile', { cookie: re.cookie })).status).toBe(200);            // ...and now reaches finance
    await call('PATCH', `/users/${agent.id}`, { cookie: admin.cookie, body: { status: 'DISABLED' } });
    expect((await signIn(agent.username, agent.password, '10.5.5.6')).res.status).toBe(401);
    // the super user can never be listed or edited through the API
    const list = (await call('GET', '/users', { cookie: admin.cookie })).json.items;
    expect(list.some((u: any) => u.username === SU.username)).toBe(false);
  });

  it('administrators cannot escalate: no self-edits, and only the super user manages administrators', async () => {
    const admin = await staff(['admin']); const other = await staff(['admin']); const agent = await staff(['call-center']);
    expect((await call('PATCH', `/users/${admin.id}`, { cookie: admin.cookie, body: { roles: ['admin', 'finance'] } })).status).toBe(403);   // cannot edit self
    expect((await call('POST', `/users/${admin.id}/reset-password`, { cookie: admin.cookie, body: {} })).status).toBe(403);
    expect((await call('POST', '/users', { cookie: admin.cookie, body: { username: 'shadow.admin', displayName: 'S', roles: ['admin'] } })).status).toBe(403);   // cannot mint admins
    expect((await call('PATCH', `/users/${agent.id}`, { cookie: admin.cookie, body: { roles: ['admin'] } })).status).toBe(403);                               // cannot promote
    expect((await call('PATCH', `/users/${other.id}`, { cookie: admin.cookie, body: { status: 'DISABLED' } })).status).toBe(403);                              // cannot touch another admin
    expect((await call('PATCH', `/users/${agent.id}`, { cookie: admin.cookie, body: { displayName: 'Renamed Agent' } })).status).toBe(200);                    // ordinary staff are fine
    const su = await root();
    expect((await call('POST', '/users', { cookie: su, body: { username: 'second.admin', displayName: 'Second', roles: ['admin'] } })).status).toBe(200);     // the super user can
  });

  it('records denied attempts in the audit log', async () => {
    const agent = await staff(['call-center']);
    await call('GET', '/gl/reconcile', { cookie: agent.cookie });
    const rows = (await call('GET', '/audit?entity=authz', { cookie: await root() })).json;
    expect(rows.some((r: any) => r.actor === agent.username && r.action === 'DENIED')).toBe(true);
  });

  it('dashboards only contain what the role may see', async () => {
    const f = (await call('GET', '/dashboard', { cookie: (await staff(['finance'])).cookie })).json;
    expect(f).toHaveProperty('ledgerRevenueMinor'); expect(f).toHaveProperty('receivableMinor'); expect(f).not.toHaveProperty('openCases'); expect(f).not.toHaveProperty('recentOrders');
    const cc = (await call('GET', '/dashboard', { cookie: (await staff(['call-center'])).cookie })).json;
    expect(cc).toHaveProperty('openCases'); expect(cc).not.toHaveProperty('ledgerRevenueMinor');
    expect((await call('GET', '/dashboard', { cookie: (await staff(['dealer'], { dealerId: 'DLR-9' })).cookie })).status).toBe(403);
  });
});

describe('data scope', () => {
  it('a portal customer can only ever reach their own records', async () => {
    const root_ = await root();
    const A = await customer(root_, 'Portal A'), B = await customer(root_, 'Portal B');
    const mk = async (cid: string, username: string) => {
      const password = `Portal-Passphrase-${++n}-Zq`; const { user } = await createUser(db, 't', { username, displayName: username, roles: ['self-serve'], customerId: cid, password });
      await db.query('UPDATE users SET must_change_password=false WHERE id=$1', [user.id]); return (await signIn(username, password, `10.6.${++n}.1`)).cookie!;
    };
    const a = await mk(A, 'portal.a'), b = await mk(B, 'portal.b');
    const orderB = await call('POST', '/orders', { cookie: b, body: { channel: 'SELF_SERVE', lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CREDIT_CARD' } } });
    expect(orderB.status).toBe(200);
    expect(orderB.json.customerId).toBe(B);

    expect((await call('GET', `/customers/${B}`, { cookie: a })).status).toBe(404);
    expect((await call('GET', `/customers/${A}`, { cookie: a })).status).toBe(200);
    expect((await call('GET', '/customers?q=Portal', { cookie: a })).status).toBe(403);       // cannot search other customers
    expect((await call('GET', `/orders/${orderB.json.id}`, { cookie: a })).status).toBe(404);
    expect((await call('POST', `/orders/${orderB.json.id}/actions`, { cookie: a, body: { type: 'cancel' } })).status).toBe(404);
    expect((await call('GET', '/orders', { cookie: a })).json.items.every((o: any) => o.customerId === A)).toBe(true);
    expect((await call('GET', `/orders?customerId=${B}`, { cookie: a })).json.items.every((o: any) => o.customerId === A)).toBe(true);   // filter override ignored
    expect((await call('GET', `/services?customerId=${B}`, { cookie: a })).json.items.every((s: any) => s.customerId === A)).toBe(true);
    // placing an order "for" someone else lands on their own account; a retail channel is not theirs to use
    const forged = await call('POST', '/orders', { cookie: a, body: { channel: 'SELF_SERVE', customerId: B, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CREDIT_CARD' } } });
    expect(forged.json.customerId).toBe(A);
    expect((await call('POST', '/orders', { cookie: a, body: { channel: 'RETAIL_ASSISTED', lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH' } } })).status).toBe(403);
    const inv = (await call('GET', '/invoices', { cookie: a })); expect(inv.status).toBe(200);
    expect((await call('POST', '/cases', { cookie: a, body: { customerId: B, type: 'GENERAL', subject: 'x' } })).json.customerId).toBe(A);
    for (const [m, p] of [['POST', '/invoices/x/pay'], ['PATCH', '/customers/' + A], ['POST', '/services/x/actions'], ['GET', '/users'], ['GET', '/audit'], ['GET', '/inventory'], ['GET', '/gl']] as const)
      expect([403, 404, 400]).toContain((await call(m, p, { cookie: a, body: {} })).status);
    expect((await call('GET', '/catalog?status=DRAFT', { cookie: a })).json.items.every((o: any) => o.status === 'ACTIVE')).toBe(true);
    const nav = (await call('GET', '/auth/me', { cookie: a })).json.user.modules.map((m: any) => m.id);
    expect(nav).toContain('account'); expect(nav).not.toContain('customers'); expect(nav).not.toContain('finance');
  });

  it('store and dealer users only see their own orders, stock and commission', async () => {
    const root_ = await root();
    const s1 = await staff(['retail-store'], { storeId: 'STORE-SG-001' }), s2 = await staff(['retail-store'], { storeId: 'STORE-SG-002' });
    const d1 = await staff(['dealer'], { dealerId: 'DLR-1' }), d2 = await staff(['dealer'], { dealerId: 'DLR-2' });
    const c = await customer(root_);
    const o1 = await call('POST', '/orders', { cookie: s1.cookie, body: { channel: 'RETAIL_ASSISTED', customerId: c, storeId: 'STORE-SG-002', lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH', confirmed: true } } });
    expect(o1.json.storeId).toBe('STORE-SG-001');                  // body's store is ignored
    const od = await call('POST', '/orders', { cookie: d1.cookie, body: { channel: 'DEALER', customerId: c, dealerId: 'DLR-2', lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH', confirmed: true } } });
    expect(od.json.dealerId).toBe('DLR-1');

    expect((await call('GET', `/orders/${o1.json.id}`, { cookie: s2.cookie })).status).toBe(404);
    expect((await call('GET', '/orders', { cookie: s2.cookie })).json.items.some((o: any) => o.id === o1.json.id)).toBe(false);
    expect((await call('GET', `/orders/${od.json.id}`, { cookie: d2.cookie })).status).toBe(404);
    expect((await call('GET', `/orders/${od.json.id}`, { cookie: d1.cookie })).status).toBe(200);
    const dl = (await call('GET', '/orders', { cookie: d1.cookie })).json;
    expect(dl.items.map((o: any) => o.id)).toEqual([od.json.id]);       // exactly this dealer's order, nothing else in the system
    expect((await call('GET', '/inventory', { cookie: s1.cookie })).json.items.every((i: any) => i.locationId === 'STORE-SG-001')).toBe(true);
    expect((await call('GET', '/inventory?locationId=WH-MAIN', { cookie: s1.cookie })).json.items.every((i: any) => i.locationId === 'STORE-SG-001')).toBe(true);
    expect((await call('POST', '/inventory/adjust', { cookie: s1.cookie, body: { locationId: 'STORE-SG-002', sku: 'PHONE-X1-128', delta: 1 } })).status).toBe(403);
    expect((await call('POST', '/inventory/adjust', { cookie: s1.cookie, body: { locationId: 'STORE-SG-001', sku: 'PHONE-X1-128', delta: 1 } })).status).toBe(200);
    expect((await call('GET', '/commissions', { cookie: d1.cookie })).json.every((r: any) => r.agent === d1.username || r.agent === '-')).toBe(true);
    expect((await call('GET', '/commissions', { cookie: d2.cookie })).json).toEqual([]);
  });
});

describe('orders, payments and retries', () => {
  it('in manual payment mode nothing is captured without a reference from a cashier', async () => {
    process.env.MERIDIAN_PAYMENT_MODE = 'manual';
    try {
      const retail = await staff(['retail-store'], { storeId: 'STORE-SG-001' });
      const c = await customer(retail.cookie);
      const body = (payment: object) => ({ channel: 'RETAIL_ASSISTED', customerId: c, lines: [{ offerId: 'plan-sim-5g' }], payment });
      expect((await call('POST', '/orders', { cookie: retail.cookie, body: body({ method: 'CREDIT_CARD', confirmed: true }) })).status).toBe(400);   // approval code required
      const pending = await call('POST', '/orders', { cookie: retail.cookie, body: body({ method: 'CREDIT_CARD' }) });
      expect(pending.json.state).toBe('PAYMENT_PENDING');
      expect((await call('POST', `/orders/${pending.json.id}/actions`, { cookie: retail.cookie, body: { type: 'confirm_payment' } })).status).toBe(400);
      const paid = await call('POST', `/orders/${pending.json.id}/actions`, { cookie: retail.cookie, body: { type: 'confirm_payment', reference: 'APPR-889123' } });
      expect(paid.json.state).toBe('COMPLETED');
      const ok = await call('POST', '/orders', { cookie: retail.cookie, body: body({ method: 'CASH', confirmed: true, reference: 'RCPT-1' }) });
      expect(ok.json.state).toBe('COMPLETED');
      // a customer can place an order but can never confirm their own payment
      const root_ = await root(); const A = await customer(root_);
      const { user } = await createUser(db, 't', { username: 'portal.pay', displayName: 'p', roles: ['self-serve'], customerId: A, password: 'Portal-Pay-Passphrase-1' });
      await db.query('UPDATE users SET must_change_password=false WHERE id=$1', [user.id]);
      const pc = (await signIn('portal.pay', 'Portal-Pay-Passphrase-1', '10.4.4.4')).cookie!;
      const po = await call('POST', '/orders', { cookie: pc, body: { channel: 'SELF_SERVE', lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CREDIT_CARD', confirmed: true, reference: 'FREE' } } });
      expect(po.json.state).toBe('PAYMENT_PENDING');
      expect((await call('POST', `/orders/${po.json.id}/actions`, { cookie: pc, body: { type: 'confirm_payment', reference: 'FREE' } })).status).toBe(403);
    } finally { process.env.MERIDIAN_PAYMENT_MODE = 'simulated'; }
  });

  it('the payment webhook confirms orders only with a valid, fresh, matching signed request', async () => {
    process.env.MERIDIAN_PAYMENT_MODE = 'manual';
    const secret = 'webhook-secret-0123456789';
    try {
      const root_ = await root(); const c = await customer(root_);
      const o = await call('POST', '/orders', { cookie: root_, body: { channel: 'CALL_CENTER', customerId: c, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CREDIT_CARD' } } });
      expect(o.json.state).toBe('PAYMENT_PENDING');
      const send = (payload: object, key = secret, sigOverride?: string) => {
        const raw = JSON.stringify(payload);
        const sig = sigOverride ?? 'sha256=' + createHmac('sha256', key).update(raw).digest('hex');
        return call('POST', '/webhooks/payment', { raw, origin: null, headers: { 'x-meridian-signature': sig } });
      };
      const p = { kind: 'order', id: o.json.id, amountMinor: o.json.totalMinor, reference: 'PSP-REF-1', method: 'CREDIT_CARD', timestamp: Date.now() };
      expect((await send(p)).status).toBe(404);                                  // disabled until a secret is configured
      process.env.MERIDIAN_PAYMENT_WEBHOOK_SECRET = secret;
      expect((await send(p, 'wrong-secret-0123456789')).status).toBe(401);
      expect((await send(p, secret, 'sha256=deadbeef')).status).toBe(401);
      expect((await send({ ...p, amountMinor: 1 })).status).toBe(422);          // amount must match
      expect((await send({ ...p, timestamp: Date.now() - 3_600_000 })).status).toBe(422); // stale
      const ok = await send(p);
      expect(ok.status).toBe(200); expect(ok.json.state).toBe('COMPLETED');
      expect((await send(p)).json.note).toBe('already processed');             // replay is harmless
    } finally { delete process.env.MERIDIAN_PAYMENT_WEBHOOK_SECRET; process.env.MERIDIAN_PAYMENT_MODE = 'simulated'; }
  });

  it('retrying a submitted order with the same idempotency key does not create a second order', async () => {
    const agent = await staff(['telesales']); const c = await customer(agent.cookie);
    const send = () => call('POST', '/orders', { cookie: agent.cookie, headers: { 'idempotency-key': 'form-abc-123' }, body: { channel: 'TELESALES', customerId: c, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH', confirmed: true } } });
    const a = await send(), b = await send();
    expect(b.json.id).toBe(a.json.id);
    expect(b.headers.get('x-idempotent-replay')).toBe('true');
    expect((await call('GET', `/orders?customerId=${c}`, { cookie: agent.cookie })).json.total).toBe(1);
  });
});

describe('production safety', () => {
  it('refuses to serve a production deployment that is misconfigured (but still answers the liveness probe)', async () => {
    const keep = { ...process.env };
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production'; delete process.env.DATABASE_URL; delete process.env.MERIDIAN_ID_PEPPER; delete process.env.MERIDIAN_ALLOW_EMBEDDED_DB;
      const r = await call('GET', '/customers');
      expect(r.status).toBe(503); expect(r.json.error.code).toBe('MISCONFIGURED');
      expect(r.text).not.toMatch(/DATABASE_URL|PEPPER/);                 // details go to the log, not to the browser
      expect((await call('POST', '/auth/login', { body: SU })).status).toBe(503);
      expect((await call('GET', '/health', { origin: null })).status).toBe(200);
    } finally { process.env = keep; }
  });
});

describe('catalog hierarchy and dependencies', () => {
  it('edits, moves, reorders and deletes at every level, and refuses unsafe changes', async () => {
    const c = await root();
    const mk = (body: unknown) => call('POST', '/catalog', { cookie: c, body });
    expect((await mk({ level: 'NETWORK_TYPE', id: 'sat', name: 'Satellite', networkType: 'none' })).status).toBe(200);
    expect((await mk({ level: 'CATEGORY', id: 'sat-roam', name: 'Roaming', parentId: 'sat' })).status).toBe(200);
    expect((await mk({ level: 'GROUP', id: 'grp-sat-a', name: 'Plans A', parentId: 'sat-roam' })).status).toBe(200);
    // Renaming keeps ids (paths derive from ids); moving re-parents.
    expect((await call('PATCH', '/catalog/sat-roam', { cookie: c, body: { name: 'Roaming 2' } })).json.name).toBe('Roaming 2');
    expect((await mk({ level: 'CATEGORY', id: 'sat-b', name: 'B', parentId: 'sat' })).status).toBe(200);
    const moved = await call('POST', '/catalog/grp-sat-a/move', { cookie: c, body: { parentId: 'sat-b' } });
    expect(moved.status).toBe(200);
    expect(moved.json.path).toBe('sat/sat-b/grp-sat-a');
    expect((await call('POST', '/catalog/sat-b/reorder', { cookie: c, body: { direction: 'up' } })).status).toBe(200);
    // Non-empty nodes cannot be deleted; empty ones can.
    expect((await call('DELETE', '/catalog/sat-b', { cookie: c })).status).toBeGreaterThanOrEqual(400);
    expect((await call('DELETE', '/catalog/sat-roam', { cookie: c })).status).toBe(200);
    expect((await call('GET', '/catalog/sat-roam', { cookie: c })).status).toBe(404);
  });

  it('stores dependencies on an offer and rejects cycles and unknown targets', async () => {
    const c = await root();
    const offer = (id: string, extra: Record<string, unknown> = {}) => call('POST', '/catalog', { cookie: c, body: {
      level: 'OFFER', id, name: id, parentId: 'grp-insurance', markets: ['SG'], kind: 'VAS', prices: [{ type: 'RECURRING', amount: { amountMinor: 500, currency: 'SGD' }, periodMinutes: undefined, periodMonths: 1, taxInclusive: true }],
      fulfilment: { requiresShipping: false, requiresInstallation: false, requiresSimActivation: false, inventorySkus: [] }, ...extra } });
    expect((await offer('care-a', { requires: ['grp-device'] })).status).toBe(200);
    expect((await offer('care-b', { requires: ['no-such-offer'] })).status).toBeGreaterThanOrEqual(400);
    expect((await offer('care-c', { requires: ['care-a'] })).status).toBe(200);
    const cyc = await call('PATCH', '/catalog/care-a', { cookie: c, body: { requires: ['care-c'] } });
    expect(cyc.status).toBeGreaterThanOrEqual(400);
    expect((await call('PATCH', '/catalog/care-a', { cookie: c, body: { description: 'ok', salesChannels: ['SELF_SERVE'] } })).json.salesChannels).toEqual(['SELF_SERVE']);
  });

  it('hides unsold structure from roles without catalog:write', async () => {
    const c = await root();
    await call('POST', '/catalog', { cookie: c, body: { level: 'NETWORK_TYPE', id: 'draft-net', name: 'Draft net', networkType: 'none', status: 'DRAFT' } });
    const agent = await staff(['call-center']);
    const tree = await call('GET', '/catalog/tree', { cookie: agent.cookie });
    expect(tree.status).toBe(200);
    expect(JSON.stringify(tree.json)).not.toContain('draft-net');
    expect((await call('PATCH', '/catalog/draft-net', { cookie: agent.cookie, body: { name: 'x' } })).status).toBe(403);
    expect((await call('DELETE', '/catalog/draft-net', { cookie: agent.cookie })).status).toBe(403);
  });
});
