import { createHmac } from 'node:crypto';
import { createUser, getDb, placeOrder, requestPortOut, type Db, type NewUser } from '@meridian/core';
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
  (await call('POST', '/customers', { cookie, body: { context: 'order', segment: 'CONSUMER', displayName: name, idDocument: `ID${n}${Math.random().toString(36).slice(2, 7)}` } })).json.customer.id as string;

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
    const rows = (await call('GET', '/audit?entity=authz', { cookie: await root() })).json.items;
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
    const dealerOne = (await call('POST', '/dealers', { cookie: root_, body: { name: 'Dealer One' } })).json.id as string;
    const dealerTwo = (await call('POST', '/dealers', { cookie: root_, body: { name: 'Dealer Two' } })).json.id as string;
    const d1 = await staff(['dealer'], { dealerId: dealerOne }), d2 = await staff(['dealer'], { dealerId: dealerTwo });
    const ag = (await call('POST', `/dealers/${dealerOne}/agents`, { cookie: root_, body: { name: 'Agent One' } })).json.id;
    const c = await customer(root_);
    const o1 = await call('POST', '/orders', { cookie: s1.cookie, body: { channel: 'RETAIL_ASSISTED', customerId: c, storeId: 'STORE-SG-002', lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH', confirmed: true } } });
    expect(o1.json.storeId).toBe('STORE-SG-001');                  // body's store is ignored
    const od = await call('POST', '/orders', { cookie: d1.cookie, body: { channel: 'DEALER', customerId: c, dealerId: dealerTwo, dealerAgentId: ag, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH', confirmed: true } } });
    expect(od.json.dealerId).toBe(dealerOne);
    expect(od.json.dealerAgentId).toBe(ag);

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
    expect((await call('GET', `/orders?customerId=${c}`, { cookie: agent.cookie })).json.items).toHaveLength(1);
  });
});

describe('order wizard API, partial cancellation and returns', () => {
  it('quotes the full summary, lists eligible add-ons, and cancels part of an order', async () => {
    const agent = await staff(['telesales']); const c = await customer(agent.cookie);
    const lines = [{ offerId: 'plan-phone-24', options: { variantId: 'silver-128' }, payment: { mode: 'INSTALLMENT', months: 12, downPaymentMinor: 5000 } }, { offerId: 'fiber-1g' }];
    const q = await call('POST', '/orders/quote', { cookie: agent.cookie, body: { channel: 'TELESALES', customerId: c, lines } });
    expect(q.status).toBe(200);
    expect(q.json).toMatchObject({ dueNowMinor: 5000 + 5000, needs: { delivery: true, installation: true }, discountMinor: 2990 });
    expect(q.json.lines[0]).toMatchObject({ variant: { colour: 'Silver', storage: '128GB' }, instalmentMinor: 1825, group: 'GOODS' });
    expect(q.json.lines[0].entitlements.length).toBeGreaterThan(0);
    expect(q.json.groups.map((g: any) => g.group).sort()).toEqual(['GOODS', 'INSTALL']);
    expect((await call('POST', '/orders/quote', { cookie: agent.cookie, body: { channel: 'DEALER', customerId: c, lines } })).status).toBe(403); // channel permission still applies

    const add = await call('GET', `/orders/addons?customerId=${c}&offers=plan-phone-24&channel=TELESALES`, { cookie: agent.cookie });
    expect(add.json.items.map((i: any) => i.offer.id)).toContain('device-care');
    const none = await call('GET', `/orders/addons?customerId=${c}&offers=plan-sim-5g&channel=TELESALES`, { cookie: agent.cookie });
    expect(none.json.items.map((i: any) => i.offer.id)).not.toContain('device-care');
    const avail = await call('GET', '/catalog/plan-phone-24/availability', { cookie: agent.cookie });
    expect(avail.json.items.find((v: any) => v.variantId === 'silver-128').available).toBeGreaterThan(0);

    const root_ = await root();
    const placed = await call('POST', '/orders', { cookie: root_, body: { channel: 'TELESALES', customerId: c, lines, deliveryAddress: '1 Road', payment: { method: 'CREDIT_CARD' } } });
    expect(placed.status).toBe(200);
    expect(placed.json.groups.map((g: any) => g.kind).sort()).toEqual(['GOODS', 'INSTALL']);
    await call('POST', `/orders/${placed.json.id}/actions`, { cookie: root_, body: { type: 'ship' } });
    const partial = await call('POST', `/orders/${placed.json.id}/actions`, { cookie: root_, body: { type: 'cancel', reason: 'no fibre please' } });
    expect(partial.status).toBe(200);
    expect(partial.json.groups.find((g: any) => g.kind === 'INSTALL').status).toBe('CANCELLED');
    expect(partial.json.groups.find((g: any) => g.kind === 'GOODS').status).toBe('LOCKED');
    const refused = await call('POST', `/orders/${placed.json.id}/actions`, { cookie: root_, body: { type: 'cancel', groups: ['GOODS'] } });
    expect(refused.status).toBe(422);
    expect(refused.json.error.message).toMatch(/point of no return/);
    await call('POST', `/orders/${placed.json.id}/actions`, { cookie: root_, body: { type: 'deliver' } });
    const ret = await call('POST', `/orders/${placed.json.id}/actions`, { cookie: root_, body: { type: 'return', reason: 'screen scratched', deductionMinor: 1000 } });
    expect(ret.status).toBe(200);
    expect(ret.json.groups.find((g: any) => g.kind === 'GOODS').status).toBe('RETURNED');
    expect((await call('POST', `/orders/${placed.json.id}/actions`, { cookie: agent.cookie, body: { type: 'return', reason: 'again please' } })).status).toBe(403); // telesales cannot cancel or return
  });

  it('manages bundle rules (catalog editors only) and sweeps late installations', async () => {
    const root_ = await root();
    const agent = await staff(['telesales']);
    const body = { id: 'watch-fibre', name: 'Fibre + watch: 5.00 off the watch', when: ['kind:FIBER', 'kind:WEARABLE'], target: 'kind:WEARABLE', amountMinor: 500 };
    expect((await call('POST', '/bundle-rules', { cookie: agent.cookie, body })).status).toBe(403);
    expect((await call('POST', '/bundle-rules', { cookie: root_, body: { ...body, percentBps: 100 } })).status).toBe(400); // a percentage or an amount, not both
    expect((await call('POST', '/bundle-rules', { cookie: root_, body })).status).toBe(200);
    expect((await call('GET', '/bundle-rules', { cookie: agent.cookie })).json.items.map((r: any) => r.id)).toEqual(expect.arrayContaining(['fibre-plus-phone', 'watch-fibre']));
    expect((await call('PATCH', '/bundle-rules/watch-fibre', { cookie: root_, body: { ...body, amountMinor: 700 } })).json.amountMinor).toBe(700);
    expect((await call('DELETE', '/bundle-rules/watch-fibre', { cookie: root_ })).status).toBe(200);
    expect((await call('POST', '/jobs/sweep-orders', { cookie: agent.cookie })).status).toBe(403);
    expect((await call('POST', '/jobs/sweep-orders', { cookie: root_ })).json).toMatchObject({ atRisk: expect.any(Number), cancelled: expect.any(Number) });
  });
});

describe('cancellation rules in settings', () => {
  it('lets only the super user manage the rule base, validates rules, and applies changes to real orders', async () => {
    const root_ = await root();
    const admin = await staff(['admin']);
    expect((await call('GET', '/settings/cancellation', { cookie: admin.cookie })).status).toBe(403);
    const v = await call('GET', '/settings/cancellation', { cookie: root_ });
    expect(v.status).toBe(200);
    expect(v.json.rules.length).toBeGreaterThan(10);
    expect(v.json.facts.map((f: any) => f.id)).toContain('hoursToVisit');
    expect(v.json.descriptions['goods-return-window']).toMatch(/within 14 days of delivery/);

    const rule = { id: 'tele-fibre-approval', name: 'Telesales fibre needs approval', action: 'CANCEL', group: 'INSTALL', priority: 1, when: [{ fact: 'groupStatus', op: 'eq', value: 'PENDING' }, { fact: 'channel', op: 'eq', value: 'TELESALES' }], outcome: { allow: true, requiresOverride: true } };
    expect((await call('POST', '/settings/cancellation/rules', { cookie: root_, body: { ...rule, outcome: { allow: false, feeFixedMinor: 5 } } })).status).toBe(400);
    expect((await call('POST', '/settings/cancellation/rules', { cookie: root_, body: { ...rule, when: [{ fact: 'hoursToVisit', op: 'in', value: ['x'] }] } })).status).toBe(400);
    const made = await call('POST', '/settings/cancellation/rules', { cookie: root_, body: rule });
    expect(made.status).toBe(200);
    const mine = made.json.rules.find((r: any) => r.id === rule.id);
    expect(mine.priority).toBeGreaterThan(0);
    expect((await call('POST', '/settings/cancellation/rules', { cookie: root_, body: rule })).status).toBe(400); // duplicate id

    const c = await customer(root_);
    const o = await call('POST', '/orders', { cookie: root_, body: { channel: 'TELESALES', customerId: c, lines: [{ offerId: 'fiber-1g' }], payment: { method: 'CASH', confirmed: true, reference: 'R-1' } } });
    expect(o.json.groups.find((g: any) => g.kind === 'INSTALL')).toMatchObject({ ruleId: 'tele-fibre-approval' });

    const sim = await call('POST', '/settings/cancellation/simulate', { cookie: root_, body: { action: 'CANCEL', group: 'INSTALL', facts: { groupStatus: 'PENDING', channel: 'TELESALES' }, paidMinor: 5000 } });
    expect(sim.json.decision).toMatchObject({ allow: false, needsOverride: true, rule: { id: 'tele-fibre-approval' } });
    expect((await call('POST', '/settings/cancellation/simulate', { cookie: root_, body: { action: 'CANCEL', group: 'INSTALL', facts: { groupStatus: 'PENDING', channel: 'TELESALES' }, paidMinor: 5000, canOverride: true } })).json.decision.allow).toBe(true);

    expect((await call('PATCH', `/settings/cancellation/rules/${rule.id}`, { cookie: root_, body: { ...rule, enabled: false } })).json.rules.find((r: any) => r.id === rule.id).enabled).toBe(false);
    await call('POST', `/settings/cancellation/rules/${rule.id}/move`, { cookie: root_, body: { direction: 'up' } });
    expect((await call('DELETE', `/settings/cancellation/rules/${rule.id}`, { cookie: root_ })).json.rules.some((r: any) => r.id === rule.id)).toBe(false);
    expect((await call('POST', '/settings/cancellation/default', { cookie: root_, body: { defaultAllow: true } })).json.settings.defaultAllow).toBe(true);
    const reset = await call('POST', '/settings/cancellation/reset', { cookie: root_ });
    expect(reset.json.settings.defaultAllow).toBe(false);
    expect(reset.json.rules.length).toBe(v.json.rules.length);
    expect((await call('GET', '/audit?entity=settings', { cookie: root_ })).json.items.some((a: any) => a.action === 'CANCELLATION_RULES_RESET')).toBe(true);
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
    const top = await call('GET', '/catalog/browse', { cookie: agent.cookie });
    expect(top.status).toBe(200);
    expect(JSON.stringify(top.json)).not.toContain('draft-net');
    expect(JSON.stringify((await call('GET', '/catalog/search?q=draft', { cookie: agent.cookie })).json)).not.toContain('draft-net');
    expect((await call('GET', '/catalog/draft-net/detail', { cookie: agent.cookie })).status).toBe(404);
    expect(JSON.stringify((await call('GET', '/catalog/browse', { cookie: c })).json)).toContain('draft-net');
    expect((await call('PATCH', '/catalog/draft-net', { cookie: agent.cookie, body: { name: 'x' } })).status).toBe(403);
    expect((await call('DELETE', '/catalog/draft-net', { cookie: agent.cookie })).status).toBe(403);
  });
});

describe('settings and branding', () => {
  // Smallest valid PNG header with a 480x120 IHDR.
  const png = () => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(480, 0); ihdr.writeUInt32BE(120, 4); ihdr[8] = 8; ihdr[9] = 6;
    const len = Buffer.alloc(4); len.writeUInt32BE(13);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, Buffer.from('IHDR'), ihdr, Buffer.alloc(16)]);
  };

  it('the housekeeping job needs the billing-run permission', async () => {
    const su = await root();
    expect((await call('POST', '/jobs/expire-applications', { cookie: (await staff(['retail-store'], { storeId: 'STORE-SG-001' })).cookie, body: {} })).status).toBe(403);
    const r = await call('POST', '/jobs/expire-applications', { cookie: su, body: {} });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ expired: expect.any(Number), cancelledOrders: expect.any(Number) });
  });

  it('only the super user reaches settings; administrators and everyone else are refused', async () => {
    const admin = await staff(['admin']);
    for (const [m, p] of [['GET', '/settings'], ['POST', '/settings/regional'], ['POST', '/settings/branding'], ['POST', '/settings/logo'], ['DELETE', '/settings/logo']] as const) {
      expect((await call(m, p, { cookie: admin.cookie, body: {} })).status, `admin ${m} ${p}`).toBe(403);
      expect((await call(m, p, { body: {} })).status, `anon ${m} ${p}`).toBe(401);
    }
    const su = await root();
    const s = await call('GET', '/settings', { cookie: su });
    expect(s.status).toBe(200);
    expect(s.json.themes).toHaveLength(8);
    expect(s.json.logoGuidance).toMatchObject({ width: 480, height: 120 });
    expect((await call('GET', '/auth/me', { cookie: su })).json.user.modules.some((m: any) => m.id === 'settings')).toBe(true);
    expect((await call('GET', '/auth/me', { cookie: admin.cookie })).json.user.modules.some((m: any) => m.id === 'settings')).toBe(false);
  });

  it('branding is public (login screen), and the logo is served safely', async () => {
    const su = await root();
    expect((await call('POST', '/settings/branding', { cookie: su, body: { name: 'Acme Mobile', theme: 'violet' } })).status).toBe(200);
    expect((await call('POST', '/settings/branding', { cookie: su, body: { name: 'Acme', theme: 'neon' } })).status).toBe(400);
    const up = await call('POST', '/settings/logo', { cookie: su, body: { dataBase64: png().toString('base64') } });
    expect(up.status).toBe(200);
    expect((await call('POST', '/settings/logo', { cookie: su, body: { dataBase64: Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64') } })).status).toBe(400);
    const pub = await call('GET', '/branding', { origin: null });
    expect(pub.status).toBe(200);
    expect(pub.json).toMatchObject({ name: 'Acme Mobile', theme: 'violet', regional: { currency: expect.any(String) } });
    expect(pub.json.logoUrl).toMatch(/^\/api\/branding\/logo\?v=/);
    const img = await call('GET', '/branding/logo', { origin: null });
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    expect(img.headers.get('content-security-policy')).toContain('sandbox');
    expect((await call('DELETE', '/settings/logo', { cookie: su })).json.logoUrl).toBeNull();
    expect((await call('GET', '/branding/logo', { origin: null })).status).toBe(404);
  });

  it('saves regional settings, validates them, and records the change in the audit log', async () => {
    const su = await root();
    const cur = (await call('GET', '/settings', { cookie: su })).json.regional;
    const { exponent: _e, ...base } = cur;
    const bad = await call('POST', '/settings/regional', { cookie: su, body: { ...base, thousandSeparator: '.', decimalSeparator: '.' } });
    expect(bad.status).toBe(400);
    // Earlier tests booked orders, so the currency itself is locked...
    const locked = await call('POST', '/settings/regional', { cookie: su, body: { ...base, currency: 'EUR', symbol: '€' } });
    expect(locked.status).toBe(422);
    expect(locked.json.error.message).toMatch(/cannot change/);
    // ...but how amounts and dates are written stays editable.
    const ok = await call('POST', '/settings/regional', { cookie: su, body: { ...base, symbolPosition: 'after', symbolSpacing: true, thousandSeparator: '.', decimalSeparator: ',', decimals: 2, taxName: 'VAT', timezone: 'Europe/Berlin', dateFormat: 'DD.MM.YYYY' } });
    expect(ok.status).toBe(200);
    expect((await call('GET', '/branding', { origin: null })).json.regional).toMatchObject({ currency: cur.currency, symbolPosition: 'after', decimalSeparator: ',', dateFormat: 'DD.MM.YYYY' });
    const audit = (await call('GET', '/audit?entity=settings', { cookie: su })).json;
    expect(JSON.stringify(audit)).toContain('regional');
  });
});

describe('segments, customer creation and groups', () => {
  it('creates customers outside an order only when the operator allows it', async () => {
    const admin = await root();
    const agent = await staff(['telesales']);
    const make = (extra: object = {}) => call('POST', '/customers', { cookie: agent.cookie, body: { segment: 'CONSUMER', displayName: 'Walk Up', idDocument: `W${++n}${Math.random().toString(36).slice(2, 7)}`, ...extra } });
    expect((await call('GET', '/meta', { cookie: agent.cookie })).json.customers).toMatchObject({ allowCreateWithoutOrder: false });
    expect((await make()).status).toBe(422);                              // the Customers screen cannot create one
    expect((await make({ context: 'order' })).status).toBe(200);           // the order wizard can
    expect((await call('POST', '/settings/customers', { cookie: agent.cookie, body: { allowCreateWithoutOrder: true } })).status).toBe(403);
    expect((await call('POST', '/settings/customers', { cookie: admin, body: { allowCreateWithoutOrder: true } })).status).toBe(200);
    expect((await make()).status).toBe(200);
    await call('POST', '/settings/customers', { cookie: admin, body: { allowCreateWithoutOrder: false } });
  });

  it('lets the super user maintain segments and staff move a customer between them', async () => {
    const admin = await root();
    const agent = await staff(['customer-service']);
    expect((await call('GET', '/segments', { cookie: agent.cookie })).json.map((s: any) => s.id)).toEqual(['CONSUMER', 'ENTERPRISE', 'IOT']);
    expect((await call('POST', '/settings/segments', { cookie: agent.cookie, body: { name: 'VIP' } })).status).toBe(403);
    const vip = (await call('POST', '/settings/segments', { cookie: admin, body: { name: 'VIP', description: 'Top customers' } })).json;
    expect(vip.id).toBe('VIP');
    expect((await call('GET', '/settings/customers', { cookie: admin })).json.segments.find((s: any) => s.id === 'VIP')).toMatchObject({ customers: 0 });
    const c = await customer(admin);
    const move = (reason: string) => call('POST', `/customers/${c}/segment`, { cookie: agent.cookie, body: { segment: 'VIP', reason } });
    expect((await move('')).status).toBe(400);
    expect((await move('Spends over $500 a month')).status).toBe(200);
    expect((await call('GET', `/customers/${c}/segment-history`, { cookie: agent.cookie })).json.items[0]).toMatchObject({ fromSegment: 'CONSUMER', toSegment: 'VIP', changedBy: agent.username });
    expect((await call('GET', '/customers?segment=VIP', { cookie: agent.cookie })).json.items.map((x: any) => x.id)).toEqual([c]);
    const facts = (await call('GET', '/settings/cancellation', { cookie: admin })).json.facts;
    expect(facts.find((f: any) => f.id === 'segment').values.map((v: any) => v[0])).toContain('VIP');
  });

  it('manages a group of services through the API, with the principal rule enforced', async () => {
    const admin = await root();
    const cs = await staff(['customer-service']);
    const c = await customer(admin);
    const acct = (await call('GET', `/customers/${c}/accounts`, { cookie: admin })).json.items[0].id;
    const svc: string[] = [];
    for (let i = 0; i < 3; i++) {
      const o = (await call('POST', '/orders', { cookie: admin, body: { channel: 'CALL_CENTER', customerId: c, accountId: acct, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH', confirmed: true } } })).json;
      svc.push((await db.query('SELECT id FROM services WHERE order_id=$1', [o.id])).rows[0]!.id);
    }
    const make = await call('POST', `/accounts/${acct}/groups`, { cookie: cs.cookie, body: { name: 'Home', principalServiceId: svc[0], supplementaryServiceIds: [svc[1]], benefits: { allowances: { dataGb: 50, voiceMinutes: null }, discountBps: 1000 } } });
    expect(make.status).toBe(200);
    expect(make.json.benefits).toEqual({ allowances: { dataGb: 50 }, discountBps: 1000 });
    const gid = make.json.id;
    expect((await call('POST', `/groups/${gid}/members`, { cookie: cs.cookie, body: { serviceId: svc[2] } })).json.members).toHaveLength(3);
    expect((await call('DELETE', `/groups/${gid}/members/${svc[0]}`, { cookie: cs.cookie })).status).toBe(422); // the principal cannot leave first
    expect((await call('POST', `/groups/${gid}/principal`, { cookie: cs.cookie, body: { serviceId: svc[1] } })).status).toBe(200);
    expect((await call('DELETE', `/groups/${gid}/members/${svc[0]}`, { cookie: cs.cookie })).status).toBe(200);
    expect((await call('GET', `/accounts/${acct}/groups`, { cookie: cs.cookie })).json.items.map((g: any) => g.name)).toEqual(['Home']);
    const noRights = await staff(['finance']);
    expect((await call('POST', `/groups/${gid}/members`, { cookie: noRights.cookie, body: { serviceId: svc[0] } })).status).toBe(403);
    expect((await call('DELETE', `/groups/${gid}`, { cookie: cs.cookie })).status).toBe(200);
  });
});

describe('the customer form follows the settings', () => {
  it('asks for what Settings asks for, drops what is hidden, and offers only the bill cycles that are switched on', async () => {
    const admin = await root();
    const staffUser = await staff(['product-configurator']);
    const newC = (body: Record<string, unknown>) => call('POST', '/customers', { cookie: admin, body: { context: 'order', segment: 'CONSUMER', displayName: 'Form Test', idDocument: `FT${Math.random().toString(36).slice(2, 9)}`, ...body } });
    expect((await call('POST', '/settings/customers', { cookie: staffUser.cookie, body: { allowCreateWithoutOrder: false } })).status).toBe(403);
    expect((await call('POST', '/settings/customers', { cookie: admin, body: { allowCreateWithoutOrder: false, fields: { postcode: 'required', gender: 'hidden', dateOfBirth: 'required' } } })).json.fields).toMatchObject({ postcode: 'required', gender: 'hidden' });
    const missing = await newC({ address: { line1: '1 Road' } });
    expect(missing.status).toBe(400);
    expect(missing.json.error.message).toMatch(/Date of birth is required\. Postcode is required\./);
    const ok = await newC({ dateOfBirth: '1991-02-03', gender: 'FEMALE', address: { line1: '1 Jalan Ampang', postcode: '50450', city: 'Kuala Lumpur', country: 'MY' } });
    expect(ok.status).toBe(200);
    expect(ok.json.customer).toMatchObject({ dateOfBirth: '1991-02-03', address: { postcode: '50450', country: 'MY' } });
    expect(ok.json.customer.gender ?? null).toBeNull(); // hidden in Settings, so not kept
    expect((await call('GET', '/meta', { cookie: admin })).json.customers.fields.postcode).toBe('required');

    expect((await call('POST', '/settings/bill-cycles', { cookie: admin, body: { days: [1, 15, 25], daily: false, defaultCycle: 15 } })).status).toBe(200);
    const off = await newC({ dateOfBirth: '1991-02-03', address: { postcode: '1' }, account: { billCycleDay: 7 } });
    expect(off.status).toBe(400);
    expect(off.json.error.message).toMatch(/Bill cycle day 7 is not offered/);
    const dflt = await newC({ dateOfBirth: '1991-02-03', address: { postcode: '1' } });
    expect(dflt.json.account.billCycleDay).toBe(15); // the operator's default
    expect((await call('GET', '/meta', { cookie: staffUser.cookie })).json.billCycles).toEqual({ days: [1, 15, 25], daily: false, defaultCycle: 15 });
    await call('POST', '/settings/bill-cycles', { cookie: admin, body: { days: Array.from({ length: 28 }, (_, i) => i + 1), daily: true, defaultCycle: 1 } });
    await call('POST', '/settings/customers', { cookie: admin, body: { allowCreateWithoutOrder: false, fields: { postcode: 'optional', gender: 'optional', dateOfBirth: 'optional' } } });
  });
});

describe('which offers a login can sell', () => {
  it('is decided by its market, which an administrator can see and change', async () => {
    const admin = await root();
    expect((await call('POST', '/settings/markets', { cookie: admin, body: { multiple: true } })).status).toBe(200);
    const made = await call('POST', '/users', { cookie: admin, body: { username: 'market.seller', displayName: 'Market Seller', roles: ['call-center'] } });
    expect(made.status).toBe(200);
    const id = made.json.user.id as string;
    const mk = (id2: string, markets: string[]) => call('POST', '/catalog', { cookie: admin, body: { level: 'OFFER', id: id2, name: id2, parentId: 'grp-sim-only', kind: 'SIM_ONLY', status: 'DRAFT', markets, prices: [{ type: 'RECURRING', amount: { amountMinor: 1000, currency: 'SGD' }, taxInclusive: true, periodMonths: 1 }], contract: { termMonths: 0 }, characteristics: {}, fulfilment: { options: [] } } });
    expect((await mk('only-my-plan', ['MY'])).status).toBe(200);
    expect((await call('PATCH', '/catalog/only-my-plan', { cookie: admin, body: { status: 'ACTIVE' } })).status).toBe(200);
    const sees = async (market: string) => (await call('GET', `/catalog?status=ACTIVE&market=${market}&kind=SIM_ONLY&q=only-my-plan`, { cookie: admin })).json.items.map((o: any) => o.id);
    expect(await sees('SG')).not.toContain('only-my-plan'); // sold in Malaysia only
    expect(await sees('MY')).toContain('only-my-plan');
    const changed = await call('PATCH', `/users/${id}`, { cookie: admin, body: { marketCode: 'MY' } });
    expect(changed.status).toBe(200);
    expect(changed.json.marketCode).toBe('MY');
    expect((await call('PATCH', `/users/${id}`, { cookie: admin, body: { marketCode: 'ZZ' } })).status).toBe(400);

    // Switched back to one market: the same offer is sold to everyone and no market is asked for.
    expect((await call('POST', '/settings/markets', { cookie: admin, body: { multiple: false } })).status).toBe(200);
    expect((await call('GET', '/meta', { cookie: admin })).json.multiMarket).toBe(false);
    expect(await sees('SG')).toContain('only-my-plan');
    expect(await sees('MY')).toContain('only-my-plan');
    const another = await call('POST', '/users', { cookie: admin, body: { username: 'market.single', displayName: 'Single Seller', roles: ['call-center'], marketCode: 'TH' } });
    expect(another.json.user.marketCode).toBe('SG');
    // Add a market, make it the default, and see it in /meta.
    const cfg = (await call('GET', '/settings/markets', { cookie: admin })).json;
    expect(cfg.markets.map((m: any) => m.code)).toContain('SG');
    const added = await call('POST', '/settings/markets', { cookie: admin, body: { multiple: true, defaultMarket: 'JP', markets: [...cfg.markets, { code: 'JP', name: 'Japan', dialCode: '+81', taxName: 'Consumption tax', taxBps: 1000 }] } });
    expect(added.status).toBe(200);
    const meta = (await call('GET', '/meta', { cookie: admin })).json;
    expect([meta.defaultMarket, meta.markets.JP.name]).toEqual(['JP', 'Japan']);
    expect((await call('POST', '/settings/markets', { cookie: admin, body: { multiple: true, markets: cfg.markets.filter((m: any) => m.code !== 'SG') } })).status).toBe(400);
    expect((await call('POST', '/settings/markets', { cookie: admin, body: { multiple: false } })).status).toBe(200);
    expect((await call('POST', '/settings/markets', { cookie: await staff(['call-center']).then((s) => s.cookie), body: { multiple: true } })).status).toBe(403);
  });
});

describe('refusing an offer', () => {
  it('lists the rules it broke, and accepts manufacturer part numbers with a slash as stock SKUs', async () => {
    const cfg = await staff(['product-configurator']);
    const base = { level: 'OFFER', parentId: 'grp-electronics', kind: 'PHYSICAL_GOOD', markets: [], prices: [{ type: 'ONE_TIME', amount: { amountMinor: 599900, currency: 'SGD' }, taxInclusive: true }], contract: { termMonths: 0 }, characteristics: {}, fulfilment: { options: ['SHIP'], inventorySkus: [] } };
    const bad = await call('POST', '/catalog', { cookie: cfg.cookie, body: { ...base, id: 'slash-bad', name: 'Bad SKU', variants: [{ id: 'black-256gb', colour: 'Black', storage: '256GB', sku: 'MJW 44*LL' }] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/^invalid offer: variant Black 256GB: “MJW 44\*LL” is not a valid stock SKU/);
    const ok = await call('POST', '/catalog', { cookie: cfg.cookie, body: { ...base, id: 'slash-ok', name: 'Part number SKU', fulfilment: { options: ['SHIP'], inventorySkus: ['MJW44LL/A'] }, variants: [{ id: 'black-256gb', colour: 'Black', storage: '256GB', sku: 'MJW44LL/A' }, { id: 'black-512gb', colour: 'Black', storage: '512GB', sku: 'MJW54LL/A', priceDeltaMinor: 30000 }] } });
    expect(ok.status).toBe(200);
    expect(ok.json.variants.map((v: any) => v.sku)).toEqual(['MJW44LL/A', 'MJW54LL/A']);
  });
});

describe('catalog configuration', () => {
  it('lets the super user maintain offer types and fulfilment options, and offers use them', async () => {
    const admin = await root();
    const cfg = await staff(['product-configurator']);
    expect((await call('GET', '/settings/catalog', { cookie: cfg.cookie })).status).toBe(403);         // only the super user configures
    const view = (await call('GET', '/catalog-config', { cookie: cfg.cookie })).json;                  // but whoever works on the catalog can read the lists
    expect(view.types.map((t: any) => t.id)).toContain('SIM_ONLY');
    expect(view.options.map((o: any) => o.id)).toEqual(['SHIP', 'COLLECT', 'INSTALL', 'SIM']);
    const t = await call('POST', '/settings/offer-types', { cookie: admin, body: { name: 'Prepaid top-up', template: 'VAS' } });
    expect(t.status).toBe(200);
    const o = await call('POST', '/settings/fulfilment-options', { cookie: admin, body: { name: 'Locker', mechanic: 'COLLECT', tracksStock: true } });
    expect(o.json.id).toBe('LOCKER');
    const base = { level: 'OFFER', parentId: 'grp-sim-only', kind: t.json.id, markets: [], prices: [{ type: 'RECURRING', amount: { amountMinor: 500, currency: 'SGD' }, taxInclusive: true, periodMonths: 1 }], contract: { termMonths: 0 }, characteristics: {}, fulfilment: { options: [] } };
    const made = await call('POST', '/catalog', { cookie: cfg.cookie, body: { ...base, id: 'prepaid-topup-5', name: 'Top-up 5' } });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ kind: 'PREPAID_TOP_UP', template: 'VAS' });
    const goods = await call('POST', '/catalog', { cookie: cfg.cookie, body: { ...base, id: 'locker-good', name: 'Locker good', kind: 'PHYSICAL_GOOD', prices: [{ type: 'ONE_TIME', amount: { amountMinor: 900, currency: 'SGD' }, taxInclusive: true }], fulfilment: { options: ['LOCKER'], inventorySkus: ['LK-1'] } } });
    expect(goods.json.fulfilment).toMatchObject({ requiresCollection: true, requiresShipping: false, options: ['LOCKER'] });
    expect((await call('POST', '/catalog', { cookie: cfg.cookie, body: { ...base, id: 'eur-plan', name: 'Euro plan', kind: 'SIM_ONLY', prices: [{ type: 'RECURRING', amount: { amountMinor: 500, currency: 'EUR' }, taxInclusive: true, periodMonths: 1 }] } })).status).toBe(400); // wrong currency
    expect((await call('PATCH', `/settings/offer-types/${t.json.id}`, { cookie: admin, body: { status: 'INACTIVE' } })).status).toBe(200);
    expect((await call('POST', '/catalog', { cookie: cfg.cookie, body: { ...base, id: 'prepaid-topup-10', name: 'Top-up 10' } })).status).toBe(400); // switched off
    expect((await call('DELETE', `/settings/offer-types/${t.json.id}`, { cookie: admin })).status).toBe(422); // an offer uses it
    const facts = (await call('GET', '/settings/cancellation', { cookie: admin })).json.facts;
    expect(facts.find((f: any) => f.id === 'offerKinds').values.map((v: any) => v[0])).toContain('PREPAID_TOP_UP');
  });
});

describe('stores', () => {
  it('lets an administrator keep stores and pick one when creating store staff', async () => {
    const admin = await staff(['admin']);
    const nobody = await staff(['finance']);
    expect((await call('POST', '/stores', { cookie: nobody.cookie, body: { name: 'Nope' } })).status).toBe(403);
    expect((await call('GET', '/stores', { cookie: nobody.cookie })).status).toBe(403);
    const st = await call('POST', '/stores', { cookie: admin.cookie, body: { id: 'IGNORED', name: 'Clementi Mall', address: '3155 Commonwealth Ave West' } });
    expect(st.status).toBe(200);
    expect(st.json.id).toMatch(/^STORE-\d{5}$/);
    const id = st.json.id as string;
    expect((await call('GET', '/stores?q=clem&status=ACTIVE', { cookie: admin.cookie })).json.items.map((s: any) => s.id)).toEqual([id]);
    // a store user is created against it and then sees only its orders
    const made = await call('POST', '/users', { cookie: admin.cookie, body: { username: `clerk.${++n}`, displayName: 'Clerk', roles: ['retail-store'], storeId: id } });
    expect(made.status).toBe(200);
    expect((await call('POST', '/users', { cookie: admin.cookie, body: { username: `clerk.${++n}`, displayName: 'Ghost', roles: ['retail-store'], storeId: 'STORE-NOPE' } })).status).toBe(400);
    expect((await call('DELETE', `/stores/${id}`, { cookie: admin.cookie })).status).toBe(422); // has staff: switch it off instead
    expect((await call('PATCH', `/stores/${id}`, { cookie: admin.cookie, body: { status: 'INACTIVE' } })).json.status).toBe('INACTIVE');
    const empty = (await call('POST', '/stores', { cookie: admin.cookie, body: { name: 'Pop-up' } })).json.id;
    expect((await call('DELETE', `/stores/${empty}`, { cookie: admin.cookie })).status).toBe(200);
  });

  it('refuses a sale at a store that is switched off', async () => {
    const root_ = await root();
    const shop = await staff(['retail-store'], { storeId: 'STORE-SG-002' });
    await call('PATCH', '/stores/STORE-SG-002', { cookie: root_, body: { status: 'INACTIVE' } });
    const sale = await call('POST', '/orders', { cookie: shop.cookie, body: { channel: 'RETAIL_ASSISTED', customerId: await customer(root_), lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH', confirmed: true } } });
    expect(sale.status).toBe(400);
    expect(sale.json.error.message).toMatch(/switched off/);
    await call('PATCH', '/stores/STORE-SG-002', { cookie: root_, body: { status: 'ACTIVE' } });
  });
});

describe('dealers, and who an order is sold by', () => {
  it('keeps dealers and agents in the CRM and requires both on a dealer order', async () => {
    const admin = await root();
    const desk = await staff(['dealer-desk']);
    const plain = await staff(['telesales']);
    expect((await call('POST', '/dealers', { cookie: plain.cookie, body: { name: 'Orbit' } })).status).toBe(403);
    expect((await call('GET', '/dealers', { cookie: plain.cookie })).status).toBe(403);
    expect((await call('POST', '/dealers', { cookie: desk.cookie, body: { name: '  ' } })).status).toBe(400);
    const d = await call('POST', '/dealers', { cookie: desk.cookie, body: { id: 'CHOSEN-BY-CALLER', name: 'Orbit Mobile' } });
    expect(d.status).toBe(200);
    expect(d.json.id).toMatch(/^DLR-\d{5}$/);                                                      // issued by the system; a requested id is ignored
    const ORBIT = d.json.id as string;
    const next = (await call('POST', '/dealers', { cookie: desk.cookie, body: { name: 'Next' } })).json.id as string;
    expect(Number(next.slice(4))).toBe(Number(ORBIT.slice(4)) + 1);
    const a1 = (await call('POST', `/dealers/${ORBIT}/agents`, { cookie: desk.cookie, body: { name: 'Marcus' } })).json;
    expect(a1.id).toBe(`${ORBIT}-A001`);
    expect((await call('GET', '/dealers?q=orbit', { cookie: desk.cookie })).json.items.map((x: any) => x.id)).toEqual([ORBIT]);
    const cust = await customer(admin);
    const sale = (extra: object) => call('POST', '/orders', { cookie: desk.cookie, body: { channel: 'DEALER', customerId: cust, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH', confirmed: true }, ...extra } });
    expect((await sale({ dealerId: ORBIT })).status).toBe(400);                                  // no agent
    expect((await sale({ dealerId: 'GHOST', dealerAgentId: a1.id })).status).toBe(400);           // unknown dealer
    const OTHER = (await call('POST', '/dealers', { cookie: desk.cookie, body: { name: 'Other' } })).json.id as string;
    const other = (await call('POST', `/dealers/${OTHER}/agents`, { cookie: desk.cookie, body: { name: 'Sam' } })).json;
    expect((await sale({ dealerId: ORBIT, dealerAgentId: other.id })).status).toBe(400);        // someone else's agent
    const ok = await sale({ dealerId: ORBIT, dealerAgentId: a1.id });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ dealerId: ORBIT, dealerAgentId: a1.id, salespersonId: desk.username });
    await call('PATCH', `/dealer-agents/${a1.id}`, { cookie: desk.cookie, body: { status: 'INACTIVE' } });
    expect((await sale({ dealerId: ORBIT, dealerAgentId: a1.id })).status).toBe(400);          // inactive agent
    expect((await call('GET', `/dealers/${ORBIT}/agents?status=ACTIVE`, { cookie: desk.cookie })).json.items).toHaveLength(0);
  });

  it('rings a quick sale up at the signed-in store and keeps self-serve out of the CRM', async () => {
    const admin = await root();
    const shop = await staff(['retail-store'], { storeId: 'STORE-SG-001' });
    const body = { channel: 'QUICK_SALE', lines: [{ offerId: 'good-toaster' }], payment: { method: 'CASH', confirmed: true } };
    const r = await call('POST', '/orders', { cookie: shop.cookie, body: { ...body, storeId: 'STORE-SG-002' } });
    expect(r.json).toMatchObject({ storeId: 'STORE-SG-001', salespersonId: shop.username });      // the store comes from the login, not the request
    expect((await call('POST', '/orders', { cookie: admin, body: { ...body, storeId: 'STORE-SG-002' } })).status).toBe(400); // no store on the login: no quick sale
    expect((await call('POST', '/orders', { cookie: admin, body: { ...body, channel: 'SELF_SERVE', customerId: await customer(admin) } })).status).toBe(400);
  });
});

describe('store-front API, KYC review and assisted sales', () => {
  const png = () => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 6;
    const len = Buffer.alloc(4); len.writeUInt32BE(13);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, Buffer.from('IHDR'), ihdr, Buffer.alloc(40)]).toString('base64');
  };
  const person = (id: string) => ({ fullName: 'Sam Lee', dateOfBirth: '1991-02-03', idType: 'NATIONAL_ID', idNumber: id, idExpiry: '2099-01-01', email: 'sam@example.com', phone: '+6598765432' });
  const bearer = (key: string, token?: string) => ({ authorization: `Bearer ${key}`, ...(token ? { 'x-application-token': token } : {}) });
  let key = '';

  it('API keys are minted only by the super user and gate every store route', async () => {
    const su = await root();
    const admin = await staff(['admin']);
    expect((await call('POST', '/settings/api-clients', { cookie: admin.cookie, body: { name: 'x' } })).status).toBe(403);
    expect((await call('GET', '/store/catalog', { origin: null })).status).toBe(401);
    expect((await call('GET', '/store/catalog', { origin: null, headers: bearer('mk_test_aaaaaaaaaa_' + 'x'.repeat(40)) })).status).toBe(401);
    const made = await call('POST', '/settings/api-clients', { cookie: su, body: { name: 'External shop' } });
    expect(made.status).toBe(201);
    key = made.json.key;
    expect(JSON.stringify((await call('GET', '/settings/store', { cookie: su })).json)).not.toContain(key.slice(-16));
    // browser-style cross-origin calls are not how this API is used, but a key works without an Origin header and a session cookie does not
    const cat = await call('GET', '/store/catalog', { origin: null, headers: bearer(key) });
    expect(cat.status).toBe(200);
    expect(cat.json.offers.some((o: any) => o.id === 'plan-sim-5g')).toBe(true);
    expect((await call('GET', '/store/catalog', { cookie: su, origin: null })).status).toBe(401); // a staff session is not an API key
    const cfg = (await call('GET', '/store/config', { origin: null, headers: bearer(key) })).json;
    expect(cfg.brand.name).toBeTruthy();
    expect(JSON.stringify(cfg)).not.toMatch(/sk_|whsec_/);
  });

  it('a shopper signs up, passes KYC review and pays; prices come only from the server', async () => {
    const su = await root();
    const officer = await staff(['compliance']);
    const created = await call('POST', '/store/applications', { origin: null, headers: bearer(key), body: { lines: [{ offerId: 'plan-sim-5g' }] } });
    expect(created.status).toBe(201);
    const { id, token } = created.json;
    const H = bearer(key, token);
    // the application is private to its key AND token
    expect((await call('GET', `/store/applications/${id}`, { origin: null, headers: bearer(key) })).status).toBe(404);
    expect((await call('GET', `/store/applications/${id}`, { origin: null, headers: bearer(key, 'nope') })).status).toBe(404);
    // a client-supplied price is ignored (and unknown fields do not fail)
    const patched = await call('PATCH', `/store/applications/${id}`, { origin: null, headers: H, body: { personal: person('S7654321Z'), address: { line1: '1 Main St', city: 'Singapore', postcode: '018989', country: 'SG' }, consent: { acceptedTerms: true, privacyAccepted: true, marketingOptIn: false } } });
    expect(patched.status).toBe(200);
    expect(patched.json.quote.upfrontMinor).toBe(1000);
    expect(JSON.stringify(patched.json)).not.toContain('S7654321Z');
    expect((await call('POST', `/store/applications/${id}/documents`, { origin: null, headers: H, body: { kind: 'ID_FRONT', dataBase64: Buffer.from('<svg/>').toString('base64') } })).status).toBe(400);
    for (const kind of ['ID_FRONT', 'ID_BACK', 'SELFIE']) expect((await call('POST', `/store/applications/${id}/documents`, { origin: null, headers: H, body: { kind, dataBase64: png() } })).status, kind).toBe(200);
    const submitted = await call('POST', `/store/applications/${id}/kyc`, { origin: null, headers: H });
    expect(submitted.json.status).toBe('KYC_REVIEW');
    expect((await call('POST', `/store/applications/${id}/checkout`, { origin: null, headers: H })).status).toBe(422); // not before approval

    // review queue: only compliance (and the super user); sales roles cannot
    const retail = await staff(['retail-store'], { storeId: 'STORE-SG-001' });
    expect((await call('GET', '/kyc/cases', { cookie: retail.cookie })).status).toBe(403);
    const queue = await call('GET', '/kyc/cases?status=PENDING', { cookie: officer.cookie });
    const kase = queue.json.items.find((c: any) => c.applicationId === id);
    expect(kase).toBeTruthy();
    const detail = await call('GET', `/kyc/cases/${kase.id}`, { cookie: officer.cookie });
    expect(detail.json.idNumber).toBe('S7654321Z');
    const img = await call('GET', `/kyc/documents/${detail.json.documents[0].id}`, { cookie: officer.cookie });
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('content-security-policy')).toContain('sandbox');
    expect((await call('GET', `/kyc/documents/${detail.json.documents[0].id}`, { cookie: retail.cookie })).status).toBe(403);
    expect((await call('POST', `/kyc/cases/${kase.id}/decision`, { cookie: officer.cookie, body: { decision: 'APPROVE' } })).status).toBe(200);
    expect((await call('POST', `/kyc/cases/${kase.id}/decision`, { cookie: su, body: { decision: 'REJECT', reason: 'late' } })).status).toBe(409);

    const co = await call('POST', `/store/applications/${id}/checkout`, { origin: null, headers: H, body: {} });
    expect(co.status).toBe(200);
    expect(co.json.payment).toMatchObject({ gateway: 'test', amountMinor: 1000, currency: expect.any(String) });
    expect(co.json.application.order.state).toBe('PAYMENT_PENDING');
    const paid = await call('POST', `/store/applications/${id}/payment/test`, { origin: null, headers: H, body: { outcome: 'succeed' } });
    expect(paid.json.order.state).toBe('COMPLETED');
    expect(paid.json.order.numbers[0]).toMatch(/^\+\d+/);
  });

  it('a signed Stripe webhook confirms payment; a forged one does not', async () => {
    const core = await import('@meridian/core');
    const env = { MERIDIAN_STRIPE_SECRET_KEY: 'sk_test_x', MERIDIAN_STRIPE_WEBHOOK_SECRET: 'whsec_routersecret', MERIDIAN_STRIPE_PUBLISHABLE_KEY: 'pk_test_x' };
    Object.assign(process.env, env);
    const su = await root();
    const s = (await call('GET', '/settings/store', { cookie: su })).json.store;
    expect((await call('POST', '/settings/store', { cookie: su, body: { ...s, gateways: { enabled: ['stripe'], default: 'stripe' } } })).status).toBe(200);
    core.setGatewayFetch(async () => ({ ok: true, status: 200, json: async () => ({ id: 'pi_router_1', client_secret: 'pi_router_1_secret' }) }));
    try {
      const created = (await call('POST', '/store/applications', { origin: null, headers: bearer(key), body: { lines: [{ offerId: 'plan-sim-5g' }] } })).json;
      const H = bearer(key, created.token);
      await call('PATCH', `/store/applications/${created.id}`, { origin: null, headers: H, body: { personal: person('S1112223Q'), consent: { acceptedTerms: true, privacyAccepted: true, marketingOptIn: false } } });
      for (const kind of ['ID_FRONT', 'ID_BACK', 'SELFIE']) await call('POST', `/store/applications/${created.id}/documents`, { origin: null, headers: H, body: { kind, dataBase64: png() } });
      await call('POST', `/store/applications/${created.id}/kyc`, { origin: null, headers: H });
      const kase = (await call('GET', '/kyc/cases?status=PENDING', { cookie: su })).json.items.find((c: any) => c.applicationId === created.id);
      await call('POST', `/kyc/cases/${kase.id}/decision`, { cookie: su, body: { decision: 'APPROVE' } });
      const co = await call('POST', `/store/applications/${created.id}/checkout`, { origin: null, headers: H, body: {} });
      expect(co.json.payment).toMatchObject({ gateway: 'stripe', clientSecret: 'pi_router_1_secret', publicConfig: { publishableKey: 'pk_test_x' } });
      expect((await call('POST', `/store/applications/${created.id}/payment/test`, { origin: null, headers: H, body: { outcome: 'succeed' } })).status).toBe(422); // the active intent is Stripe, so there is no test payment to confirm

      const raw = JSON.stringify({ id: 'evt_router_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_router_1', amount: 1000, amount_received: 1000, currency: 'sgd' } } });
      const forged = await call('POST', '/webhooks/gateway/stripe', { origin: null, raw, headers: { 'stripe-signature': core.stripeSignature(raw, 'whsec_wrong') } });
      expect(forged.status).toBe(401);
      expect((await call('POST', '/webhooks/gateway/stripe', { origin: null, raw })).status).toBe(401);
      const ok = await call('POST', '/webhooks/gateway/stripe', { origin: null, raw, headers: { 'stripe-signature': core.stripeSignature(raw, 'whsec_routersecret') } });
      expect(ok.status).toBe(200);
      expect((await call('GET', `/store/applications/${created.id}`, { origin: null, headers: H })).json.order.state).toBe('COMPLETED');
      const replay = await call('POST', '/webhooks/gateway/stripe', { origin: null, raw, headers: { 'stripe-signature': core.stripeSignature(raw, 'whsec_routersecret') } });
      expect(replay.json.handled).toBe(false);
      expect((await call('POST', '/webhooks/gateway/test', { origin: null, raw })).status).toBe(404);
    } finally {
      core.setGatewayFetch(null);
      for (const k of Object.keys(env)) delete process.env[k];
      await call('POST', '/settings/store', { cookie: su, body: { ...s } });
    }
  });

  it('a shop assistant completes the sale with the customer present, within their own store', async () => {
    const a = await staff(['retail-store'], { storeId: 'STORE-SG-001' });
    const other = await staff(['retail-store'], { storeId: 'STORE-SG-002' });
    const created = await call('POST', '/assisted/applications', { cookie: a.cookie, body: { lines: [{ offerId: 'plan-sim-5g' }] } });
    expect(created.status).toBe(201);
    const id = created.json.id;
    expect((await call('GET', `/assisted/applications/${id}`, { cookie: other.cookie })).status).toBe(404);
    await call('PATCH', `/assisted/applications/${id}`, { cookie: a.cookie, body: { personal: person('S4445556H'), consent: { acceptedTerms: true, privacyAccepted: true, marketingOptIn: false } } });
    expect((await call('POST', `/assisted/applications/${id}/kyc`, { cookie: a.cookie, body: { idSighted: true, faceMatches: false } })).status).toBe(422);
    expect((await call('POST', `/assisted/applications/${id}/kyc`, { cookie: a.cookie, body: { idSighted: true, faceMatches: true } })).json.status).toBe('KYC_APPROVED');
    // without the customer's authority the order cannot be placed
    const noAuth = await call('POST', `/assisted/applications/${id}/checkout`, { cookie: a.cookie, body: { payment: { method: 'CASH', confirmed: true, reference: 'R-1' } } });
    expect(noAuth.status).toBe(422);
    expect(noAuth.json.error.message).toMatch(/authorise/);
    expect((await call('PATCH', `/assisted/applications/${id}`, { cookie: a.cookie, body: { personal: person('S0000000A') } })).status).toBe(422); // identity is frozen once KYC is approved
    await call('PATCH', `/assisted/applications/${id}`, { cookie: a.cookie, body: { consent: { acceptedTerms: true, privacyAccepted: true, marketingOptIn: false, authorisedAssistant: true } } }); // the customer authorises, last
    const done = await call('POST', `/assisted/applications/${id}/checkout`, { cookie: a.cookie, body: { payment: { method: 'CASH', confirmed: true, reference: 'R-1' } } });
    expect(done.status).toBe(200);
    expect(done.json.order.state).toBe('COMPLETED');
    const order = (await call('GET', `/orders/${done.json.order.id}`, { cookie: a.cookie })).json;
    expect(order).toMatchObject({ channel: 'RETAIL_ASSISTED', storeId: 'STORE-SG-001', salespersonId: a.username });
    // compliance officers and other roles cannot run assisted sales
    const officer = await staff(['compliance']);
    expect((await call('POST', '/assisted/applications', { cookie: officer.cookie, body: { lines: [{ offerId: 'plan-sim-5g' }] } })).status).toBe(403);
    expect((await call('GET', '/auth/me', { cookie: a.cookie })).json.user.modules.map((m: any) => m.id)).not.toContain('assisted'); // every CRM order is assisted: there is no separate menu for it
  });
});

describe('offer line items API', () => {
  it('creates, edits, copies and removes line items; an offer detail lists them', async () => {
    const c = await root();
    const made = await call('POST', '/catalog', { cookie: c, body: { level: 'LINE_ITEM', id: 'plan-sim-5g-bonus', name: 'Bonus data', parentId: 'plan-sim-5g', itemType: 'DATA', quantity: 20, unit: 'GB' } });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ level: 'LINE_ITEM', itemType: 'DATA', quantity: 20 });
    expect((await call('POST', '/catalog', { cookie: c, body: { level: 'LINE_ITEM', id: 'x1', name: 'Bad', parentId: 'grp-sim-only', itemType: 'DATA' } })).status).toBe(400);
    expect((await call('POST', '/catalog', { cookie: c, body: { level: 'LINE_ITEM', id: 'x2', name: 'Bad', parentId: 'plan-sim-5g', itemType: 'TELEPORT' } })).status).toBe(400);
    const patched = await call('PATCH', '/catalog/plan-sim-5g-bonus', { cookie: c, body: { unlimited: true, name: 'Unlimited bonus' } });
    expect(patched.json).toMatchObject({ unlimited: true, name: 'Unlimited bonus' });
    const detail = (await call('GET', '/catalog/plan-sim-5g/detail', { cookie: c })).json;
    expect(detail.lineItems.map((x: any) => x.id)).toContain('plan-sim-5g-bonus');

    const agent = await staff(['call-center']);
    expect((await call('PATCH', '/catalog/plan-sim-5g-bonus', { cookie: agent.cookie, body: { name: 'x' } })).status).toBe(403);
    // a role that can only read the catalog never sees draft/retired line items
    await call('PATCH', '/catalog/plan-sim-5g-bonus', { cookie: c, body: { status: 'RETIRED' } });
    const seen = (await call('GET', '/catalog/plan-sim-5g/detail', { cookie: agent.cookie })).json;
    expect(seen.lineItems.map((x: any) => x.id)).not.toContain('plan-sim-5g-bonus');

    await call('POST', '/catalog', { cookie: c, body: { level: 'OFFER', id: 'copy-target', name: 'Copy', parentId: 'grp-vas', markets: ['SG'], kind: 'VAS', prices: [{ type: 'RECURRING', amount: { amountMinor: 100, currency: 'SGD' }, periodMonths: 1, taxInclusive: true }], fulfilment: { requiresShipping: false, requiresInstallation: false, requiresSimActivation: false, inventorySkus: [] } } });
    const copied = await call('POST', '/catalog/copy-target/line-items/copy-from', { cookie: c, body: { fromId: 'plan-sim-5g' } });
    expect(copied.json.copied).toBeGreaterThan(0);
    expect((await call('DELETE', '/catalog/plan-sim-5g-bonus', { cookie: c })).status).toBe(200);
  });
});

describe('maintaining roles and permissions', () => {
  it('lets an administrator change what a role can do, enforced on the next request, and reset it', async () => {
    const admin = await root();
    const seller = await staff(['call-center']);
    const roles = (await call('GET', '/roles', { cookie: admin })).json;
    const cc = roles.find((r: any) => r.id === 'call-center');
    expect(cc.permissions).toContain('billing:pay');
    expect((await call('GET', '/invoices?limit=1', { cookie: seller.cookie })).status).toBe(200);
    const changed = await call('PATCH', '/roles/call-center', { cookie: admin, body: { permissions: cc.permissions.filter((p: string) => p !== 'billing:read') } });
    expect(changed.status).toBe(200);
    expect(changed.json.customised).toBe(true);
    expect((await call('GET', '/invoices?limit=1', { cookie: seller.cookie })).status).toBe(403);
    expect((await call('PATCH', '/roles/call-center', { cookie: seller.cookie, body: { permissions: [] } })).status).toBe(403);
    expect((await call('PATCH', '/roles/call-center', { cookie: admin, body: { permissions: ['settings:manage'] } })).status).toBe(400);
    expect((await call('POST', '/roles/call-center/reset', { cookie: admin })).json.customised).toBe(false);
    expect((await call('GET', '/invoices?limit=1', { cookie: seller.cookie })).status).toBe(200);
  });

  it('creates a role, assigns it to a user, and refuses to delete it while it is held', async () => {
    const admin = await root();
    const made = await call('POST', '/roles', { cookie: admin, body: { name: 'Billing Viewer', scope: 'staff', home: '/billing', permissions: ['dashboard:read', 'billing:read'] } });
    expect(made.status).toBe(200);
    expect(made.json.id).toBe('billing-viewer');
    expect((await call('GET', '/roles', { cookie: admin })).json.some((r: any) => r.id === 'billing-viewer' && r.custom)).toBe(true);
    const u = await staff(['billing-viewer']);
    expect((await call('GET', '/invoices?limit=1', { cookie: u.cookie })).status).toBe(200);
    expect((await call('GET', '/customers?limit=1', { cookie: u.cookie })).status).toBe(403);
    expect((await call('GET', '/auth/me', { cookie: u.cookie })).json.user.home).toBe('/billing');
    expect((await call('DELETE', '/roles/billing-viewer', { cookie: admin })).status).toBe(422);
    expect((await call('POST', '/roles', { cookie: u.cookie, body: { name: 'Nope' } })).status).toBe(403);
    await db.query(`DELETE FROM sessions WHERE user_id=$1`, [u.id]);
    await db.query(`DELETE FROM users WHERE id=$1`, [u.id]);
    expect((await call('DELETE', '/roles/billing-viewer', { cookie: admin })).status).toBe(200);
  });
});

describe('operations support: warehouses and write-offs', () => {
  it('lets Operations Support keep warehouses and write stock off, and keeps stores from doing either', async () => {
    const ops = await staff(['inventory-ops']);
    const shop = await staff(['retail-store'], { storeId: 'STORE-SG-001' });
    const wh = await call('POST', '/warehouses', { cookie: ops.cookie, body: { name: 'Johor DC', address: 'JB' } });
    expect(wh.status).toBe(200);
    expect((await call('POST', '/warehouses', { cookie: shop.cookie, body: { name: 'Sneaky DC' } })).status).toBe(403);
    expect((await call('GET', '/warehouses', { cookie: shop.cookie })).status).toBe(200);
    const id = wh.json.id as string;

    expect((await call('POST', '/inventory/adjust', { cookie: ops.cookie, body: { locationId: id, sku: 'ROUTER-9', delta: 8, note: 'GRN 5' } })).status).toBe(200);
    expect((await call('POST', '/inventory/adjust', { cookie: ops.cookie, body: { locationId: id, sku: 'ROUTER-9', delta: -1 } })).status).toBe(400); // reducing stock is a write-off
    expect((await call('POST', '/inventory/write-off', { cookie: shop.cookie, body: { locationId: 'STORE-SG-001', sku: 'PHONE-X1-128', quantity: 1, reason: 'LOST' } })).status).toBe(403);
    expect((await call('POST', '/inventory/write-off', { cookie: ops.cookie, body: { locationId: id, sku: 'ROUTER-9', quantity: 2, reason: 'DAMAGED', note: 'dropped' } })).status).toBe(200);
    expect((await call('POST', '/inventory/write-off', { cookie: ops.cookie, body: { locationId: id, sku: 'ROUTER-9', quantity: 2, reason: 'OTHER' } })).status).toBe(400);

    const moves = (await call('GET', `/inventory/movements?locationId=${id}`, { cookie: ops.cookie })).json.items;
    expect(moves.map((m: any) => [m.kind, m.delta])).toEqual([['WRITE_OFF', -2], ['RECEIPT', 8]]);
    expect((await call('GET', `/inventory/movements?locationId=${id}`, { cookie: shop.cookie })).json.items.every((m: any) => m.locationId === 'STORE-SG-001')).toBe(true); // a store sees only its own movements, whatever it asks for

    expect((await call('DELETE', `/warehouses/${id}`, { cookie: ops.cookie })).status).toBe(422); // still holds 6
    expect((await call('POST', '/inventory/write-off', { cookie: ops.cookie, body: { locationId: id, sku: 'ROUTER-9', quantity: 6, reason: 'EXPIRED' } })).status).toBe(200);
    expect((await call('DELETE', `/warehouses/${id}`, { cookie: ops.cookie })).status).toBe(200);
  });
});

describe('service lifecycle API', () => {
  it('lets a customer pause and resume their own line, keeps imposed suspensions for staff, and gates exceptions', async () => {
    const root_ = await root();
    const A = await customer(root_, 'Traveller A'), B = await customer(root_, 'Traveller B');
    const portal = async (cid: string, username: string) => {
      const password = `Portal-Passphrase-${++n}-Zq`; const { user } = await createUser(db, 't', { username, displayName: username, roles: ['self-serve'], customerId: cid, password });
      await db.query('UPDATE users SET must_change_password=false WHERE id=$1', [user.id]); return (await signIn(username, password, `10.7.${++n}.1`)).cookie!;
    };
    const a = await portal(A, 'traveller.a'), b = await portal(B, 'traveller.b');
    const sold = await placeOrder(db, { customerId: A, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'x' }, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] });
    const id = sold.services[0].id as string;
    const act = (cookie: string, body: object) => call('POST', `/services/${id}/actions`, { cookie, body });

    expect((await act(b, { action: 'suspend-voluntary', months: 1 })).status).toBe(404); // someone else's line
    expect((await act(a, { action: 'suspend-voluntary', months: 7 })).status).toBe(422);   // over the cap
    const paused = await act(a, { action: 'suspend-voluntary', months: 3 });
    expect([paused.status, paused.json.status, paused.json.suspensionKind]).toEqual([200, 'SUSPENDED', 'VOLUNTARY']);
    const how = (await call('GET', `/services/${id}/restoration`, { cookie: a })).json;
    expect([how.customerCanResume, how.reason]).toEqual([true, 'VOLUNTARY']);
    expect((await act(a, { action: 'terminate' })).status).toBe(403); // a customer cannot end a contract this way
    expect((await act(a, { action: 'resume' })).json.status).toBe('ACTIVE');

    const agent = await staff(['call-center']);
    expect((await act(agent.cookie, { action: 'suspend', reason: 'FRAUD' })).json.suspensionKind).toBe('FRAUD');
    const refused = await act(a, { action: 'resume' });
    expect(refused.status).toBe(422);
    expect(refused.json.error.message).toMatch(/only be lifted by our staff/);
    expect((await act(agent.cookie, { action: 'resume' })).json.status).toBe('ACTIVE');
    expect((await act(agent.cookie, { action: 'terminate' })).status).toBe(403); // escalate to customer service

    const cs = await staff(['customer-service']);
    expect((await act(cs.cookie, { action: 'terminate', reason: 'cancel', etcAdjust: { waive: true, reason: 'retention' } })).json.waived).toBeDefined();
    const log = (await call('GET', `/services/${id}/lifecycle`, { cookie: cs.cookie })).json.items.map((e: any) => e.action);
    expect(log).toEqual(expect.arrayContaining(['SUSPEND', 'RESUME', 'TERMINATE']));
  });

  it('takes credit-limit readings, shows the dunning ladder, confirms a port-out once, and keeps the rules in Settings', async () => {
    const root_ = await root();
    const A = await customer(root_, 'Ladder A');
    const sold = await placeOrder(db, { customerId: A, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'x' }, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] });
    const id = sold.services[0].id as string;
    const acct = (await db.query('SELECT id FROM accounts WHERE customer_id=$1', [A])).rows[0]!.id as string;
    expect((await call('PATCH', `/accounts/${acct}/credit-limit`, { cookie: root_, body: { creditLimitMinor: 10000 } })).status).toBe(200);
    const warn = await call('POST', `/accounts/${acct}/credit-check`, { cookie: root_, body: { unbilledUsageMinor: 8500 } });
    expect([warn.json.state, warn.json.actions.warned]).toEqual(['WARNED', true]);
    const block = await call('POST', `/accounts/${acct}/credit-check`, { cookie: root_, body: { unbilledUsageMinor: 10000 } });
    expect([block.json.state, block.json.actions.barred]).toEqual(['BLOCKED', 1]);
    expect((await call('GET', `/services/${id}`, { cookie: root_ })).json.barLevel).toBe('SOFT');
    expect((await call('GET', '/lifecycle/outbox?pending=1&kind=NETWORK', { cookie: root_ })).json.items.some((m: any) => m.instruction === 'BAR_OUTGOING')).toBe(true);
    expect((await call('GET', `/accounts/${acct}/dunning`, { cookie: root_ })).json.ladder.map((s: any) => [s.action, s.day])).toEqual([['REMIND', 1], ['SOFT_BAR', 7], ['HARD_BAR', 14], ['FINAL_NOTICE', 30], ['TERMINATE', 45]]);

    await requestPortOut(db, id, { recipientOperator: 'OtherTel' }, 'agent');
    const first = await call('POST', '/mnp/port-out/confirmation', { cookie: root_, body: { serviceId: id, reference: 'NCH-1' } });
    expect([first.status, first.json.alreadyDone]).toEqual([200, false]);
    expect((await call('POST', '/mnp/port-out/confirmation', { cookie: root_, body: { serviceId: id, reference: 'NCH-1' } })).json.alreadyDone).toBe(true);

    const cfg = (await call('GET', '/settings/lifecycle', { cookie: root_ })).json;
    expect(cfg.voluntary.maxMonths).toBe(6);
    const bad = await call('POST', '/settings/lifecycle', { cookie: root_, body: { ...cfg, dunning: [{ action: 'HARD_BAR', day: 14 }, { action: 'SOFT_BAR', day: 20 }] } });
    expect(bad.status).toBe(400);
    expect((await call('POST', '/settings/lifecycle', { cookie: root_, body: { ...cfg, voluntary: { ...cfg.voluntary, maxMonths: 12 } } })).json.voluntary.maxMonths).toBe(12);
    await call('POST', '/settings/lifecycle', { cookie: root_, body: cfg });
    const ops = await staff(['call-center']);
    expect((await call('POST', `/accounts/${acct}/credit-check`, { cookie: ops.cookie, body: { unbilledUsageMinor: 1 } })).status).toBe(403);
  });
});

