import * as core from '@meridian/core';
import { DomainError, getDb, type Db } from '@meridian/core';
import { z, ZodError } from 'zod';

export type Ctx = { db: Db; params: Record<string, string>; query: URLSearchParams; body: unknown; actor: string };
type Handler = (c: Ctx) => Promise<unknown | Response>;
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler }

const routes: Route[] = [];
function on(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler });
}

const money = z.number().int();
const uuid = z.string().uuid();
const blank = <T extends z.ZodTypeAny>(t: T) => z.preprocess((v) => (v === '' ? undefined : v), t.optional()); // HTML forms send '' for untouched fields
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const num = (q: URLSearchParams, k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
const str = (q: URLSearchParams, k: string) => q.get(k) || undefined;

// ───────── dashboard / reports ─────────
on('GET', '/dashboard', ({ db }) => core.dashboard(db));
on('GET', '/audit', ({ db, query }) => core.auditLog(db, { entity: str(query, 'entity'), entityId: str(query, 'entityId') }));
on('GET', '/commissions', ({ db }) => core.commissionReport(db));
on('GET', '/meta', async ({ db }) => ({ markets: core.MARKETS, db: db.kind, persistent: db.kind === 'postgres' || !!process.env.MERIDIAN_DATA_DIR, glNames: core.GL_NAMES }));

// ───────── catalog ─────────
on('GET', '/catalog', async ({ db, query }) => ({
  items: await core.listNodes(db, { status: str(query, 'status'), level: str(query, 'level'), kind: str(query, 'kind'), q: str(query, 'q'), market: str(query, 'market'), pathPrefix: str(query, 'path') }),
}));
on('GET', '/catalog/:id', ({ db, params }) => core.getNode(db, params.id!));
on('POST', '/catalog', ({ db, body }) => core.createNode(db, body as core.NodeInput));
on('PATCH', '/catalog/:id', ({ db, params, body }) => core.setStatus(db, params.id!, z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED']) }).parse(body).status));
on('GET', '/catalog/:id/etc', ({ db, params, query }) =>
  core.etcQuoteForOffer(db, params.id!, new Date(query.get('contractStart') ?? Date.now()), new Date(query.get('terminationDate') ?? Date.now())));

// ───────── customers ─────────
const newCustomer = z.object({
  segment: z.enum(['CONSUMER', 'FAMILY', 'ENTERPRISE', 'IOT_ENTERPRISE']), displayName: z.string().min(1).max(200), idDocument: z.string().min(3).max(40),
  marketCode: z.string().length(2).optional(), email: blank(z.string().email()), phone: blank(z.string().max(30)),
  parentCustomerId: uuid.optional(), account: z.object({ name: z.string().optional(), billCycleDay: z.number().int().min(1).max(28).nullable().optional() }).optional(),
});
on('GET', '/customers', ({ db, query }) => core.searchCustomers(db, { q: str(query, 'q'), segment: str(query, 'segment'), limit: num(query, 'limit'), offset: num(query, 'offset') }));
on('POST', '/customers', ({ db, body }) => core.createCustomer(db, newCustomer.parse(body)));
on('GET', '/customers/:id', ({ db, params }) => core.customer360(db, params.id!));
on('PATCH', '/customers/:id', ({ db, params, body }) => core.updateCustomer(db, params.id!, z.object({ displayName: z.string().optional(), email: z.string().email().optional(), phone: z.string().optional(), status: z.enum(['ACTIVE', 'BLOCKED']).optional() }).parse(body)));
on('GET', '/customers/:id/children', ({ db, params, query }) => core.listChildren(db, params.id!, query.get('deep') === '1'));
on('POST', '/customers/:id/accounts', ({ db, params, body }) => core.createAccount(db, params.id!, z.object({ name: z.string().optional(), billCycleDay: z.number().int().min(1).max(28).nullable().optional() }).parse(body)));
on('POST', '/customers/:id/group', ({ db, params, body }) => {
  const b = z.object({ memberCustomerId: uuid, role: z.enum(['OWNER', 'MEMBER', 'DEPARTMENT']).optional() }).parse(body);
  return core.addToGroup(db, params.id!, b.memberCustomerId, b.role).then(() => ({ ok: true }));
});

// ───────── services ─────────
on('GET', '/services', ({ db, query }) => core.listServices(db, { customerId: str(query, 'customerId'), accountId: str(query, 'accountId'), status: str(query, 'status'), q: str(query, 'q'), limit: num(query, 'limit'), offset: num(query, 'offset') }));
const svcAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('suspend'), reason: z.string().optional() }), z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('change-sim'), iccid: z.string() }), z.object({ action: z.literal('change-msisdn'), msisdn: z.string().optional() }),
  z.object({ action: z.literal('transfer'), toCustomerId: uuid, toAccountId: uuid.optional() }),
  z.object({ action: z.literal('terminate'), reason: z.string().optional() }),
  z.object({ action: z.literal('port-out'), recipientOperator: z.string(), portingCode: z.string().optional() }),
  z.object({ action: z.literal('complete-port-out') }), z.object({ action: z.literal('cancel-port-out') }),
]);
on('POST', '/services/:id/actions', async ({ db, params, body, actor }) => {
  const a = svcAction.parse(body); const id = params.id!;
  switch (a.action) {
    case 'suspend': return core.suspendService(db, id, a.reason, actor);
    case 'resume': return core.resumeService(db, id, actor);
    case 'change-sim': return core.changeSim(db, id, a.iccid, actor);
    case 'change-msisdn': return core.changeMsisdn(db, id, a.msisdn, actor);
    case 'transfer': return core.transferOwnership(db, id, a.toCustomerId, a.toAccountId, actor);
    case 'terminate': return core.terminateService(db, id, { reason: a.reason }, actor);
    case 'port-out': return core.requestPortOut(db, id, a, actor);
    case 'complete-port-out': return core.completePortOut(db, id, actor);
    case 'cancel-port-out': return core.cancelPortOut(db, id, actor);
  }
});
on('GET', '/services/:id/etc', async ({ db, params }) => {
  const s = (await db.query('SELECT * FROM services WHERE id=$1', [params.id])).rows[0];
  if (!s) throw new DomainError('NOT_FOUND', 'service not found');
  if (!s.contractTermMonths || !s.contractStart) return { chargeMinor: 0, monthsRemaining: 0, waived: false };
  return core.etcQuoteForOffer(db, s.offerId, new Date(s.contractStart), new Date());
});

// ───────── orders ─────────
const orderBody = z.object({
  customerId: uuid.optional(), accountId: uuid.optional(), channel: z.enum(['SELF_SERVE', 'RETAIL_ASSISTED', 'QUICK_SALE', 'TELESALES', 'DEALER', 'CALL_CENTER']),
  marketCode: z.string().length(2).optional(),
  lines: z.array(z.object({ offerId: z.string(), quantity: z.number().int().min(1).optional(), msisdn: z.string().optional(), serialNumber: z.string().optional() })).min(1),
  payment: z.object({ method: z.enum(['CREDIT_CARD', 'CASH', 'QR', 'INSTALLMENT']), installmentMonths: z.number().int().optional(), reference: z.string().optional() }),
  attribution: z.object({ storeId: z.string().optional(), salespersonId: z.string().optional(), dealerId: z.string().optional() }).optional(),
  deliveryAddress: z.string().optional(),
});
on('GET', '/orders', ({ db, query }) => core.listOrders(db, { customerId: str(query, 'customerId'), state: str(query, 'state'), channel: str(query, 'channel'), limit: num(query, 'limit'), offset: num(query, 'offset') }));
on('POST', '/orders', ({ db, body, actor }) => core.placeOrder(db, { ...orderBody.parse(body), actor }));
on('GET', '/orders/:id', ({ db, params }) => core.getOrder(db, params.id!));
const orderAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('confirm_payment'), reference: z.string().optional() }), z.object({ type: z.literal('schedule_installation'), slot: z.string() }),
  z.object({ type: z.literal('dispatch_technician') }), z.object({ type: z.literal('complete_installation') }),
  z.object({ type: z.literal('ship'), trackingNumber: z.string().optional() }), z.object({ type: z.literal('deliver') }),
  z.object({ type: z.literal('cancel'), reason: z.string().default('cancelled by user') }),
]);
on('POST', '/orders/:id/actions', ({ db, params, body, actor }) => {
  const a = orderAction.parse(body);
  return a.type === 'cancel' ? core.cancelOrder(db, params.id!, a.reason, actor) : core.advanceOrder(db, params.id!, a, actor);
});

// ───────── billing ─────────
on('GET', '/invoices', ({ db, query }) => core.listInvoices(db, { customerId: str(query, 'customerId'), accountId: str(query, 'accountId'), status: str(query, 'status'), limit: num(query, 'limit'), offset: num(query, 'offset') }));
on('GET', '/invoices/:id', ({ db, params }) => core.getInvoice(db, params.id!));
on('POST', '/invoices/:id/pay', ({ db, params, body, actor }) => core.payInvoice(db, params.id!, z.object({ amountMinor: money.optional(), method: z.enum(['CASH', 'CREDIT_CARD', 'QR']), reference: z.string().optional(), idempotencyKey: z.string().optional() }).parse(body), actor));
on('POST', '/invoices/:id/credit', ({ db, params, body, actor }) => {
  const b = z.object({ amountMinor: money, reason: z.string(), caseId: uuid.optional() }).parse(body);
  return core.creditInvoice(db, params.id!, b.amountMinor, b.reason, actor, b.caseId);
});
on('POST', '/billing/run', ({ db, body }) => { const b = z.object({ asOf: date.optional(), accountId: uuid.optional() }).parse(body ?? {}); return core.runBillCycle(db, b.asOf, { accountId: b.accountId }); });
on('POST', '/billing/dunning', ({ db, body }) => core.runDunning(db, z.object({ asOf: date.optional() }).parse(body ?? {}).asOf));

// ───────── finance ─────────
on('GET', '/gl', ({ db, query }) => core.listGl(db, { exported: query.get('exported') === null ? undefined : query.get('exported') === '1', limit: num(query, 'limit'), offset: num(query, 'offset') }));
on('GET', '/gl/reconcile', ({ db }) => core.reconcile(db));
on('GET', '/gl/batches', async ({ db }) => ({ items: await core.listBatches(db) }));
on('GET', '/gl/batches/:id/csv', async ({ db, params }) => csv(await core.getBatchCsv(db, params.id!), `meridian-gl-${params.id!.slice(0, 8)}.csv`));
on('POST', '/gl/export', async ({ db }) => {
  const { batch, csv: body } = await core.exportGl(db);
  if (!batch) return Response.json({ batch: null, message: 'nothing to export' });
  return csv(body, `meridian-gl-${batch.id.slice(0, 8)}.csv`, { 'x-batch-id': batch.id, 'x-entry-count': String(batch.entryCount) });
});
const csv = (body: string, name: string, extra: Record<string, string> = {}) =>
  new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, ...extra } });

// ───────── cases / inventory ─────────
on('GET', '/cases', ({ db, query }) => core.listCases(db, { customerId: str(query, 'customerId'), status: str(query, 'status'), type: str(query, 'type'), limit: num(query, 'limit'), offset: num(query, 'offset') }));
on('POST', '/cases', ({ db, body, actor }) => core.createCase(db, z.object({ customerId: uuid, serviceId: uuid.optional(), type: z.enum(core.CASE_TYPES), subject: z.string().min(1), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(), note: z.string().optional() }).parse(body), actor));
on('GET', '/cases/:id', ({ db, params }) => core.getCase(db, params.id!));
on('PATCH', '/cases/:id', ({ db, params, body, actor }) => core.updateCase(db, params.id!, z.object({ status: z.string().optional(), priority: z.string().optional(), note: z.string().optional() }).parse(body), actor));
on('GET', '/inventory', ({ db, query }) => core.listStock(db, { locationId: str(query, 'locationId'), sku: str(query, 'sku') }).then((items) => ({ items })));
on('POST', '/inventory/adjust', ({ db, body }) => { const b = z.object({ locationId: z.string().min(1), sku: z.string().min(1), delta: z.number().int() }).parse(body); return core.adjustStock(db, b.locationId, b.sku, b.delta); });

// ───────── dispatcher ─────────
function fail(status: number, code: string, message: string, details?: unknown) {
  return Response.json({ error: { code, message, details } }, { status });
}

export async function dispatch(req: Request, path: string[]): Promise<Response> {
  const url = new URL(req.url);
  const p = '/' + path.join('/');
  const matches = routes.filter((r) => r.re.test(p));
  if (!matches.length) return fail(404, 'NOT_FOUND', `no route ${p}`);
  const route = matches.find((r) => r.method === req.method);
  if (!route) return fail(405, 'METHOD_NOT_ALLOWED', `${req.method} not allowed on ${p}`);
  const m = route.re.exec(p)!;
  const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
  try {
    let body: unknown;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const text = await req.text();
      if (text) { try { body = JSON.parse(text); } catch { return fail(400, 'INVALID', 'request body is not valid JSON'); } }
    }
    const actor = req.headers.get('x-meridian-actor')?.slice(0, 60) || 'web';
    const out = await route.handler({ db: await getDb(), params, query: url.searchParams, body, actor });
    return out instanceof Response ? out : Response.json(out ?? { ok: true });
  } catch (e) {
    if (e instanceof DomainError) return fail(e.status, e.code, e.message, e.details);
    if (e instanceof ZodError) return fail(400, 'INVALID', e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    console.error(`[api] ${req.method} ${p}`, e);
    return fail(500, 'INTERNAL', 'unexpected server error');
  }
}
