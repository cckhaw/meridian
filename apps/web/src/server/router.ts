import { createHmac, timingSafeEqual } from 'node:crypto';
import * as core from '@meridian/core';
import { DomainError, forbidden, getDb, type Db, type Permission, type SessionUser } from '@meridian/core';
import { formatMoney, LINE_ITEM_TYPES, THEMES } from '@meridian/types';
import { z, ZodError } from 'zod';
import { assertCustomer, assertOrder } from './access';
import { clearCookie, clientIp, readToken, sameOrigin, sessionCookie } from './session';

export type Ctx = { db: Db; user: SessionUser; params: Record<string, string>; query: URLSearchParams; body: unknown; req: Request };
type PublicCtx = Omit<Ctx, 'user'> & { user: SessionUser | null; raw: string; client?: core.ApiClient };
type Handler = (c: Ctx) => Promise<unknown | Response> | unknown;

interface Route {
  method: string; re: RegExp; keys: string[];
  /** Any-of. `null` = any signed-in user. */
  perm: Permission[] | null;
  public?: boolean;
  /** Reachable while a password change is pending. */
  allowMustChange?: boolean;
  /** Skip the Origin check (machine-to-machine webhooks authenticate by signature instead). */
  noCsrf?: boolean;
  /** Authenticated by an API key (`Authorization: Bearer mk_…`), for the externally hosted store-front, instead of a browser session. */
  client?: boolean;
  /** Larger request bodies (document uploads). */
  maxBody?: number;
  handler: Handler | ((c: PublicCtx) => Promise<unknown | Response> | unknown);
}
const routes: Route[] = [];

function route(method: string, path: string, perm: Permission | Permission[] | null, handler: Handler, extra: Partial<Route> = {}) {
  const keys: string[] = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, perm: perm === null ? null : Array.isArray(perm) ? perm : [perm], handler, ...extra });
}
const get = (p: string, perm: Permission | Permission[] | null, h: Handler) => route('GET', p, perm, h);
const post = (p: string, perm: Permission | Permission[] | null, h: Handler, extra?: Partial<Route>) => route('POST', p, perm, h, extra);
const patch = (p: string, perm: Permission | Permission[] | null, h: Handler) => route('PATCH', p, perm, h);
const open = (method: string, p: string, h: (c: PublicCtx) => Promise<unknown | Response> | unknown, extra: Partial<Route> = {}) => route(method, p, null, h as Handler, { public: true, ...extra });

const money = z.number().int();
const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const blank = <T extends z.ZodTypeAny>(t: T) => z.preprocess((v) => (v === '' ? undefined : v), t.optional()); // HTML forms send '' for untouched fields
const num = (q: URLSearchParams, k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
const str = (q: URLSearchParams, k: string) => q.get(k) || undefined;
const need = (u: SessionUser, p: Permission) => { if (!u.permissions.has(p)) throw forbidden(`Your role does not allow this (${p}).`); };

// ───────────────────────── public: health and auth ─────────────────────────
open('GET', '/health', () => ({ status: 'ok' }));
open('GET', '/ready', async () => { const db = await getDb(); await db.query('SELECT 1'); return { status: 'ready' }; });

open('POST', '/auth/login', async ({ db, body, req }) => {
  const b = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(1024) }).parse(body);
  try {
    const r = await core.login(db, { username: b.username, password: b.password, ip: clientIp(req), userAgent: req.headers.get('user-agent') ?? undefined });
    return new Response(JSON.stringify({ user: core.publicUser(r.user) }), { headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie(req, r.token, r.expiresAt), 'cache-control': 'no-store' } });
  } catch (e) {
    if (e instanceof DomainError && e.code === 'REJECTED') return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: e.message } }), { status: 401, headers: { 'content-type': 'application/json' } });
    if (e instanceof core.RateLimited) return new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: e.message } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(e.retryAfterSeconds) } });
    throw e;
  }
});

post('/auth/logout', null, async ({ db, req }) => {
  await core.logout(db, readToken(req));
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'set-cookie': clearCookie(req) } });
}, { allowMustChange: true });

route('GET', '/auth/me', null, ({ user }) => ({ user: core.publicUser(user) }), { allowMustChange: true });

post('/auth/change-password', null, async ({ db, user, body, req }) => {
  const b = z.object({ current: z.string().max(1024), next: z.string().max(1024) }).parse(body);
  await core.changePassword(db, user, b.current, b.next);
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'set-cookie': clearCookie(req) } }); // all sessions ended: sign in again
}, { allowMustChange: true });

// ───────────────────────── payment provider webhook ─────────────────────────
/**
 * A payment provider (or your PSP integration) confirms money received. Authenticated by HMAC-SHA256 of the raw body with
 * MERIDIAN_PAYMENT_WEBHOOK_SECRET, sent as `x-meridian-signature: sha256=<hex>`. Replays are harmless: confirmation is idempotent per reference.
 */
open('POST', '/webhooks/payment', async ({ db, raw, req }) => {
  const secret = process.env.MERIDIAN_PAYMENT_WEBHOOK_SECRET;
  if (!secret || secret.length < 16) throw new DomainError('NOT_FOUND', 'not found'); // disabled unless configured
  const sig = (req.headers.get('x-meridian-signature') ?? '').replace(/^sha256=/, '');
  const want = createHmac('sha256', secret).update(raw).digest();
  const got = Buffer.from(sig, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new DomainError('UNAUTHENTICATED', 'invalid signature');
  const b = z.object({ kind: z.enum(['order', 'invoice']), id: uuid, amountMinor: money.positive(), reference: z.string().min(3).max(100), method: z.enum(['CREDIT_CARD', 'QR', 'CASH']).default('CREDIT_CARD'), timestamp: z.number().int() }).parse(JSON.parse(raw));
  if (Math.abs(Date.now() - b.timestamp) > 5 * 60_000) throw new DomainError('REJECTED', 'stale webhook'); // bounds replay
  if (b.kind === 'order') {
    const o = await core.getOrder(db, b.id);
    if (o.totalMinor !== b.amountMinor) throw new DomainError('REJECTED', `amount ${b.amountMinor} does not match the order total ${o.totalMinor}`);
    if (o.state !== 'PAYMENT_PENDING') return { ok: true, state: o.state, note: 'already processed' };
    const r = await core.advanceOrder(db, b.id, { type: 'confirm_payment', reference: b.reference }, 'psp');
    return { ok: true, state: r.state };
  }
  const inv = await core.payInvoice(db, b.id, { amountMinor: b.amountMinor, method: b.method, reference: b.reference, idempotencyKey: `psp-${b.reference}` }, 'psp');
  return { ok: true, status: inv.status };
}, { noCsrf: true });

// ───────────────────────── dealers and their agents (master data kept in the CRM) ─────────────────────────
const dealerBody = z.object({ name: z.string().min(1).max(120), contactName: blank(z.string().max(120)), email: blank(z.string().email().max(200)), phone: blank(z.string().max(40)) });
const dealerOnly = (u: SessionUser, id: string) => { if (u.scope.dealerId && u.scope.dealerId !== id) throw forbidden('That dealer is not yours.'); };
get('/dealers', 'dealer:read', async ({ db, user, query }) => {
  if (user.scope.dealerId) return { items: [await core.getDealer(db, user.scope.dealerId)], nextCursor: null }; // a dealer's own login sees only that dealer
  return core.listDealers(db, { q: str(query, 'q'), status: str(query, 'status'), limit: num(query, 'limit'), cursor: str(query, 'cursor') });
});
post('/dealers', 'dealer:manage', async ({ db, user, body }) => core.createDealer(db, user.username, dealerBody.parse(body)));
patch('/dealers/:id', 'dealer:manage', ({ db, user, params, body }) => core.updateDealer(db, user.username, params.id!, dealerBody.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() }).parse(body)));
get('/dealers/:id/agents', 'dealer:read', ({ db, user, params, query }) => { dealerOnly(user, params.id!); return core.listAgents(db, params.id!, { status: str(query, 'status'), q: str(query, 'q'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }); });
post('/dealers/:id/agents', 'dealer:manage', ({ db, user, params, body }) => core.createAgent(db, user.username, params.id!, z.object({ name: z.string().min(1).max(120), email: blank(z.string().email().max(200)), phone: blank(z.string().max(40)) }).parse(body)));
patch('/dealer-agents/:id', 'dealer:manage', ({ db, user, params, body }) => core.updateAgent(db, user.username, params.id!, z.object({ name: z.string().min(1).max(120), email: blank(z.string().email().max(200)), phone: blank(z.string().max(40)), status: z.enum(['ACTIVE', 'INACTIVE']) }).partial().parse(body)));

// ── bulk loading and downloading of dealers, agents and stores (CSV: a template, the current data, a check that changes nothing, then the load) ──
const importBody = z.object({ csv: z.string().min(1).max(2_000_000), apply: z.boolean().default(false) });
const staffOnly = (u: SessionUser) => { if (u.scope.dealerId) throw forbidden('Dealers are managed by the operator’s staff.'); };
get('/dealers/import-template', 'dealer:manage', async ({ db, user }) => { staffOnly(user); return csv(await core.dealersFile(db, { channel: user.permissions.has('commission:configure') }), 'meridian-dealers-import-template.csv'); });
get('/dealers/export', 'dealer:manage', async ({ db, user }) => { staffOnly(user); return csv(await core.dealersFile(db, { withData: true, actor: user.username, channel: user.permissions.has('commission:configure') }), 'meridian-dealers-export.csv'); });
post('/dealers/import', 'dealer:manage', ({ db, user, body }) => { staffOnly(user); const b = importBody.parse(body); return core.importDealers(db, b.csv, { apply: b.apply, actor: user.username, channel: user.permissions.has('commission:configure') }); }, { maxBody: 2_500_000 });
get('/dealer-agents/import-template', 'dealer:manage', async ({ db }) => csv(await core.agentsFile(db, {}), 'meridian-agents-import-template.csv'));
get('/dealer-agents/export', 'dealer:manage', async ({ db, user }) => csv(await core.agentsFile(db, { withData: true, actor: user.username, dealerId: user.scope.dealerId ?? null }), 'meridian-agents-export.csv'));
post('/dealer-agents/import', 'dealer:manage', ({ db, user, body }) => { const b = importBody.parse(body); return core.importAgents(db, b.csv, { apply: b.apply, actor: user.username, dealerId: user.scope.dealerId ?? null }); }, { maxBody: 2_500_000 });
get('/stores/import-template', 'store:manage', async ({ db }) => csv(await core.storesFile(db, {}), 'meridian-stores-import-template.csv'));
get('/stores/export', 'store:manage', async ({ db, user }) => csv(await core.storesFile(db, { withData: true, actor: user.username }), 'meridian-stores-export.csv'));
post('/stores/import', 'store:manage', ({ db, user, body }) => { const b = importBody.parse(body); return core.importStores(db, b.csv, { apply: b.apply, actor: user.username }); }, { maxBody: 2_500_000 });

// ───────────────────────── retail stores (master data kept in the CRM) ─────────────────────────
const storeBody = z.object({ name: z.string().min(1).max(120), address: blank(z.string().max(300)), phone: blank(z.string().max(40)), marketCode: blank(z.string().length(2)) });
// Whoever sets up staff or sells over a counter needs to find a store; only store:manage may change one.
get('/stores', ['store:manage', 'user:manage', 'order:create:RETAIL_ASSISTED', 'order:create:QUICK_SALE'], ({ db, query }) => core.listStores(db, { q: str(query, 'q'), status: str(query, 'status'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
post('/stores', 'store:manage', ({ db, user, body }) => core.createStore(db, user.username, storeBody.parse(body)));
patch('/stores/:id', 'store:manage', ({ db, user, params, body }) => core.updateStore(db, user.username, params.id!, storeBody.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() }).parse(body)));
route('DELETE', '/stores/:id', 'store:manage', async ({ db, user, params }) => { await core.deleteStore(db, user.username, params.id!); return { ok: true }; });

// ───────────────────────── dashboard / reports ─────────────────────────
get('/dashboard', 'dashboard:read', async ({ db, user }) => {
  const d = await core.dashboard(db);
  const has = (p: Permission) => user.permissions.has(p);
  return {
    ...(has('customer:search') ? { customers: d.customers, activeServices: d.activeServices, suspendedServices: d.suspendedServices } : {}),
    ...(has('order:read') ? { openOrders: d.openOrders, ordersByState: d.ordersByState, recentOrders: d.recentOrders } : {}),
    ...(has('billing:read') ? { receivableMinor: d.receivableMinor, overdueMinor: d.overdueMinor } : {}),
    ...(has('finance:read') ? { ledgerRevenueMinor: d.ledgerRevenueMinor } : {}),
    ...(has('case:read') ? { openCases: d.openCases } : {}),
    ...(has('catalog:read') ? { mrrMinor: d.mrrMinor, topOffers: d.topOffers } : {}),
  };
});
get('/audit', 'audit:read', ({ db, query }) => core.auditLog(db, { entity: str(query, 'entity'), entityId: str(query, 'entityId'), actor: str(query, 'actor'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/commissions', 'commission:read', ({ db, user }) => core.commissionReport(db, { storeId: user.scope.storeId, dealerId: user.scope.dealerId }));
get('/meta', null, async ({ db, user }) => ({ ...await (async () => { const m = await core.getMarketSettings(db); return { markets: Object.fromEntries(m.markets.map((x) => [x.code, x])), multiMarket: m.multiple, defaultMarket: m.defaultMarket }; })(), glNames: core.GL_NAMES, marketCode: user.marketCode, paymentMode: core.paymentMode(), cardLink: (await core.activeGateways(db, process.env, 'CRM')).list.some((g) => !!g.createPaymentLink), customers: await core.getCustomerSettings(db), billCycles: await core.getBillCycles(db) }));

// ───────────────────────── users and roles ─────────────────────────
get('/roles', 'user:manage', ({ db }) => core.listRoles(db));
get('/roles/permissions', 'user:manage', () => ({ permissions: core.permissionCatalogue(), landing: core.MODULES.map((m) => ({ href: m.href, label: m.label })) }));
const roleBody = z.object({ name: z.string().max(60).optional(), summary: z.string().max(300).optional(), scope: z.enum(['staff', 'store', 'dealer']).optional(), home: z.string().max(80).optional(), permissions: z.array(z.string().max(60)).max(80).optional(), creditLimitMinor: z.number().int().min(0).nullable().optional(), copyFrom: z.string().max(60).optional() });
post('/roles', 'user:manage', ({ db, user, body }) => core.createCustomRole(db, user.username, roleBody.parse(body)));
patch('/roles/:id', 'user:manage', ({ db, user, params, body }) => core.updateRole(db, user.username, params.id!, roleBody.parse(body)));
route('DELETE', '/roles/:id', 'user:manage', ({ db, user, params }) => core.deleteCustomRole(db, user.username, params.id!));
post('/roles/:id/reset', 'user:manage', ({ db, user, params }) => core.resetRole(db, user.username, params.id!));
get('/users', 'user:manage', ({ db, query }) => core.listUsers(db, { q: str(query, 'q'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
const newUser = z.object({
  username: z.string().min(3).max(50), displayName: z.string().min(1).max(100), email: blank(z.string().email()), roles: z.array(z.string()).min(1),
  storeId: blank(z.string().max(50)), dealerId: blank(z.string().max(50)), customerId: blank(uuid), marketCode: blank(z.string().length(2)), password: blank(z.string().max(128)),
});
/**
 * Guards against privilege escalation through user administration:
 *  - nobody edits their own account here (the super user's password lives in the environment, others use "Change password");
 *  - only the super user may grant or remove the Administrator role, so administrators cannot multiply themselves.
 * Everything here is audited.
 */
const touchesAdminRole = (roles?: string[]) => !!roles?.includes('admin');
const guardUserChange = async (c: Ctx, targetId: string | null, roles?: string[]) => {
  if (c.user.isSuperuser) return;
  if (targetId && targetId === c.user.id) throw forbidden('You cannot change your own account. Ask another administrator.');
  const target = targetId ? (await c.db.query('SELECT roles FROM users WHERE id=$1', [targetId])).rows[0] : null;
  if (touchesAdminRole(roles) || touchesAdminRole(target?.roles)) throw forbidden('Only the super user can grant, change or remove administrators.');
};
post('/users', 'user:manage', async (c) => { const b = newUser.parse(c.body); await guardUserChange(c, null, b.roles); return core.createUser(c.db, c.user.username, b); });
patch('/users/:id', 'user:manage', async (c) => {
  const b = z.object({
    displayName: blank(z.string().min(1).max(100)), email: blank(z.string().email()), roles: z.array(z.string()).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    storeId: z.string().max(50).nullable().optional(), dealerId: z.string().max(50).nullable().optional(), marketCode: blank(z.string().length(2)),
  }).parse(c.body);
  await guardUserChange(c, c.params.id!, b.roles);
  return core.updateUser(c.db, c.user.username, c.params.id!, b);
});
post('/users/:id/reset-password', 'user:manage', async (c) => { await guardUserChange(c, c.params.id!); return core.resetPassword(c.db, c.user.username, c.params.id!); });
post('/users/:id/unlock', 'user:manage', async (c) => { await guardUserChange(c, c.params.id!); await core.unlockUser(c.db, c.user.username, c.params.id!); return { ok: true }; });

// ───────────────────────── catalog ─────────────────────────
const CHANNEL_ENUM = z.enum(core.CHANNELS);
const priceSchema = z.object({ type: z.enum(['ONE_TIME', 'RECURRING', 'USAGE']), amount: z.object({ amountMinor: z.number().int().min(0), currency: z.string().length(3) }), periodMonths: z.number().int().min(1).max(60).optional(), taxInclusive: z.boolean() });
const contractSchema = z.object({
  termMonths: z.union([z.literal(0), z.literal(12), z.literal(24), z.literal(36)]),
  etc: z.object({ method: z.enum(['SUBSIDY_AMORTISED', 'REMAINING_RECURRING_PERCENT', 'RECURRING_PLUS_SUBSIDY']), percentOfRemaining: z.number().min(0).max(100).optional(), capSubsidyFraction: z.number().min(0).max(1).optional(), waiveInLastMonths: z.number().int().min(0).max(12).optional() }).optional(),
  subsidy: z.object({ deviceRetailPrice: z.object({ amountMinor: z.number().int().min(0), currency: z.string().length(3) }), subsidyAmount: z.object({ amountMinor: z.number().int().min(0), currency: z.string().length(3) }) }).optional(),
});
// The flags are derived from `options` when they are given (the offer wizard); older callers may still send only the flags.
const fulfilmentSchema = z.object({ requiresShipping: z.boolean().default(false), requiresInstallation: z.boolean().default(false), requiresSimActivation: z.boolean().default(false), requiresCollection: z.boolean().optional(),
  options: z.array(z.string().max(40)).max(12).optional(), inventorySkus: z.array(z.string().max(50)).max(20).default([]) });
const variantSchema = z.object({ id: z.string().max(40), colour: z.string().min(1).max(40), storage: z.string().max(20).optional(), sku: z.string().max(50), priceDeltaMinor: z.number().int().optional() });
const dealSchema = z.object({ termMonths: z.number().int(), subsidyMinor: z.number().int(), waiveInLastMonths: z.number().int().min(0).max(35).optional() });
const offerFields = {
  kind: z.string().min(1).max(40), // an offer type id (Settings → Catalog → Offer types)
  description: z.string().max(500).optional(), prices: z.array(priceSchema).max(10), contract: contractSchema.optional(), fulfilment: fulfilmentSchema,
  partnerCode: z.string().max(50).optional(), validityDays: z.number().int().min(1).max(3650).optional(), ocs: z.object({ planCode: z.string().max(60), params: z.record(z.union([z.string().max(100), z.number(), z.boolean()])).optional() }).optional(), characteristics: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  requires: z.array(z.string().max(80)).max(20).default([]), excludes: z.array(z.string().max(80)).max(20).default([]), salesChannels: z.array(CHANNEL_ENUM).default([]), variants: z.array(variantSchema).max(40).default([]), deals: z.array(dealSchema).max(3).default([]), suspension: z.object({ mode: z.enum(['PAUSE', 'MAINTENANCE_FEE']), monthlyFeeMinor: z.number().int().min(0).max(100_000_000).optional() }).optional(),
  group: z.object({ isGroupOffer: z.boolean(), maxGroupMembers: z.number().int().min(1).max(20), allowedMemberOfferIds: z.array(z.string().max(70)).max(50).default([]), sharedPoolQuotaGb: z.number().min(0).max(100_000).optional() }).nullable().optional(),
};
const lineItemFields = {
  itemType: z.enum(LINE_ITEM_TYPES), description: z.string().max(300).optional(), quantity: z.number().int().min(1).max(1_000_000).optional(),
  unit: z.string().max(20).optional(), unlimited: z.boolean().optional(), sku: z.string().max(50).optional(),
};
const nodeInput = z.discriminatedUnion('level', [
  z.object({ level: z.literal('LINE_ITEM'), id: z.string().max(70), name: z.string().min(1).max(100), parentId: z.string(), status: z.enum(['DRAFT', 'ACTIVE']).optional(), ...lineItemFields }),
  z.object({ level: z.literal('NETWORK_TYPE'), id: z.string().max(60), name: z.string().min(1).max(100), networkType: z.enum(['mobile', 'fiber', 'iot', 'none']), status: z.enum(['DRAFT', 'ACTIVE']).optional() }),
  z.object({ level: z.literal('CATEGORY'), id: z.string().max(60), name: z.string().min(1).max(100), parentId: z.string(), status: z.enum(['DRAFT', 'ACTIVE']).optional() }),
  z.object({ level: z.literal('GROUP'), id: z.string().max(60), name: z.string().min(1).max(100), parentId: z.string(), status: z.enum(['DRAFT', 'ACTIVE']).optional() }),
  z.object({ level: z.literal('OFFER'), id: z.string().max(60), name: z.string().min(1).max(100), parentId: z.string(), status: z.enum(['DRAFT', 'SCHEDULED', 'ACTIVE']).optional(), activeFrom: z.string().max(40).optional(), markets: z.array(z.string().length(2)).default([]), ...offerFields }),
]);
const nodePatch = z.object({
  itemType: z.enum(LINE_ITEM_TYPES).optional(), quantity: z.number().int().min(1).max(1_000_000).nullable().optional(), unit: z.string().max(20).optional(), unlimited: z.boolean().optional(), sku: z.string().max(50).optional(),
  status: z.enum(['DRAFT', 'SCHEDULED', 'ACTIVE', 'RETIRED']).optional(), activeFrom: z.string().max(40).optional(), name: z.string().min(1).max(100).optional(), networkType: z.enum(['mobile', 'fiber', 'iot', 'none']).optional(), markets: z.array(z.string().length(2)).optional(),
  kind: offerFields.kind.optional(), description: z.string().max(500).optional(), prices: z.array(priceSchema).max(10).optional(), contract: contractSchema.optional(), fulfilment: fulfilmentSchema.optional(),
  partnerCode: z.string().max(50).optional(), validityDays: z.number().int().min(1).max(3650).optional(), ocs: z.object({ planCode: z.string().max(60), params: z.record(z.union([z.string().max(100), z.number(), z.boolean()])).nullable().optional() }).nullable().optional(), characteristics: offerFields.characteristics, requires: z.array(z.string().max(80)).max(20).optional(), excludes: z.array(z.string().max(80)).max(20).optional(), salesChannels: z.array(CHANNEL_ENUM).optional(), variants: z.array(variantSchema).max(40).optional(), deals: z.array(dealSchema).max(3).optional(), suspension: offerFields.suspension, group: offerFields.group,
});

/** Sales-only roles see only live nodes; editors see everything. */
const liveOnly = (user: { permissions: Set<string> }) => !user.permissions.has('catalog:write');
get('/catalog', 'catalog:read', ({ db, user, query }) => core.pageOffers(db, { status: liveOnly(user) ? 'ACTIVE' : str(query, 'status'), kind: str(query, 'kind'), notKind: str(query, 'notKind'), step: str(query, 'step'), outright: query.get('outright') === '1', q: str(query, 'q'), market: str(query, 'market'), channel: str(query, 'channel'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
// The catalog browser loads one level at a time: children of a node, word search, one node's detail. Nothing returns the whole tree.
get('/catalog/browse', 'catalog:read', ({ db, user, query }) => core.browseChildren(db, { parentId: str(query, 'parent') || null, activeOnly: liveOnly(user), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/catalog/search', 'catalog:read', ({ db, user, query }) => core.searchNodes(db, { q: str(query, 'q') ?? '', level: str(query, 'level'), activeOnly: liveOnly(user), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/catalog/summary', 'catalog:read', ({ db, user }) => core.catalogSummary(db, { activeOnly: liveOnly(user) }));
get('/catalog/:id/availability', 'catalog:read', ({ db, user, params, query }) => core.variantAvailability(db, params.id!, user.scope.storeId ?? str(query, 'location') ?? core.MAIN_WAREHOUSE).then((items) => ({ items })));
const ruleBody = z.object({ id: z.string().max(60), name: z.string().max(120), status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED']).optional(), when: z.array(z.string().max(90)).max(6), target: z.string().max(90), percentBps: z.number().int().optional(), amountMinor: z.number().int().optional() });
get('/bundle-rules', 'catalog:read', async ({ db, user }) => ({ items: await core.listBundleRules(db, liveOnly(user) ? 'ACTIVE' : undefined) }));
post('/bundle-rules', 'catalog:write', async ({ db, user, body }) => { const r = await core.saveBundleRule(db, ruleBody.parse(body), true); await core.audit(db, user.username, 'catalog', r.id, 'BUNDLE_RULE_CREATED'); return r; });
patch('/bundle-rules/:id', 'catalog:write', async ({ db, user, params, body }) => { const r = await core.saveBundleRule(db, { ...ruleBody.parse({ ...(body as object), id: params.id }) }, false); await core.audit(db, user.username, 'catalog', r.id, 'BUNDLE_RULE_UPDATED'); return r; });
route('DELETE', '/bundle-rules/:id', 'catalog:write', async ({ db, user, params }) => { await core.deleteBundleRule(db, params.id!); await core.audit(db, user.username, 'catalog', params.id!, 'BUNDLE_RULE_DELETED'); return { ok: true }; });
get('/catalog/:id/detail', 'catalog:read', ({ db, user, params }) => core.nodeDetail(db, params.id!, { activeOnly: liveOnly(user) }));
get('/catalog/:id', 'catalog:read', async ({ db, user, params }) => {
  const n = await core.getNode(db, params.id!);
  if (n.status !== 'ACTIVE' && !user.permissions.has('catalog:write')) throw new DomainError('NOT_FOUND', 'not found');
  return n;
});
get('/catalog/:id/usage', 'catalog:write', ({ db, params }) => core.nodeUsage(db, params.id!));
post('/catalog', 'catalog:write', ({ db, user, body }) => core.createNode(db, nodeInput.parse(body) as unknown as core.NodeInput, user.username));
patch('/catalog/:id', 'catalog:write', async ({ db, user, params, body }) => {
  const { status, activeFrom, ...fields } = nodePatch.parse(body);
  const edited = Object.values(fields).some((v) => v !== undefined);
  if (edited) await core.updateNode(db, params.id!, fields as core.NodePatch, user.username);
  return status ? core.setStatus(db, params.id!, status, user.username, activeFrom) : core.getNode(db, params.id!);
});
post('/catalog/:id/move', 'catalog:write', ({ db, user, params, body }) => core.moveNode(db, params.id!, z.object({ parentId: z.string().nullable() }).parse(body).parentId, user.username));
post('/catalog/:id/reorder', 'catalog:write', async ({ db, user, params, body }) => { await core.reorderNode(db, params.id!, z.object({ direction: z.enum(['up', 'down']) }).parse(body).direction, user.username); return { ok: true }; });
route('DELETE', '/catalog/:id', 'catalog:write', async ({ db, user, params }) => { await core.deleteNode(db, params.id!, user.username); return { ok: true }; });
post('/catalog/:id/line-items/copy-from', 'catalog:write', async ({ db, user, params, body }) => ({ copied: await core.copyLineItems(db, z.object({ fromId: z.string().max(80) }).parse(body).fromId, params.id!, user.username) }));
get('/catalog/:id/etc', 'catalog:read', ({ db, params, query }) =>
  core.etcQuoteForOffer(db, params.id!, new Date(query.get('contractStart') ?? Date.now()), new Date(query.get('terminationDate') ?? Date.now())));

// ───────────────────────── settings (super user) and public branding ─────────────────────────
const regionalSchema = z.object({
  currency: z.string().length(3), symbol: z.string().min(1).max(6), symbolPosition: z.enum(['before', 'after']), symbolSpacing: z.boolean(),
  thousandSeparator: z.enum([',', '.', ' ', "'", '’', '']), decimalSeparator: z.enum(['.', ',']), decimals: z.number().int().min(0).max(4), grouping: z.enum(['standard', 'indian']),
  dateFormat: z.enum(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY', 'DD.MM.YYYY']), timeFormat: z.enum(['24h', '12h']), timezone: z.string().min(1).max(60),
  weekStart: z.union([z.literal(0), z.literal(1), z.literal(6)]), country: z.string().length(2), dialCode: z.string().max(5), taxName: z.string().min(1).max(20), taxBps: z.number().int().min(0).max(10_000),
});
const brandingView = (b: core.Branding) => ({ name: b.name, theme: b.theme, logoUrl: b.logo ? `/api/branding/logo?v=${b.logo.sha256.slice(0, 12)}` : null, logo: b.logo, faviconUrl: b.favicon ? `/api/branding/favicon?v=${b.favicon.sha256.slice(0, 12)}` : null, favicon: b.favicon });

/** Presentation settings every page needs before sign-in (login screen, store-front): brand, theme, number/date format. Contains nothing sensitive. */
open('GET', '/branding', async ({ db }) => ({ ...brandingView(await core.getBranding(db)), regional: await core.getRegional(db) }));
const imageResponse = (img: { contentType: string; bytes: Buffer; sha256: string } | null, req: Request, what: string) => {
  if (!img) throw new DomainError('NOT_FOUND', `no ${what}`);
  const etag = `"${img.sha256}"`;
  const headers = { etag, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(img.bytes), { headers: { ...headers, 'content-type': img.contentType, 'content-length': String(img.bytes.length) } });
};
open('GET', '/branding/logo', async ({ db, req }) => imageResponse(await core.getLogo(db), req, 'logo'));
open('GET', '/branding/favicon', async ({ db, req }) => imageResponse(await core.getFavicon(db), req, 'favicon'));
get('/settings', 'settings:manage', async ({ db }) => ({
  regional: await core.getRegional(db), currencyLocked: await core.hasTransactions(db), branding: brandingView(await core.getBranding(db)),
  themes: Object.values(THEMES), logoGuidance: core.LOGO_RECOMMENDATION, faviconGuidance: core.FAVICON_RECOMMENDATION,
}));
post('/settings/regional', 'settings:manage', async ({ db, user, body }) => {
  const r = await core.setRegional(db, user.username, { ...regionalSchema.parse(body), exponent: 2 });
  return { regional: r.regional, repricedOffers: r.repriced };
});
post('/settings/branding', 'settings:manage', async ({ db, user, body }) => {
  const b = z.object({ name: z.string().min(1).max(40), theme: z.string().max(20) }).parse(body);
  return brandingView(await core.setBranding(db, user.username, b));
});
post('/settings/logo', 'settings:manage', async ({ db, user, body }) => {
  const b = z.object({ dataBase64: z.string().min(1).max(800_000).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64') }).parse(body);
  return brandingView(await core.setLogo(db, user.username, Buffer.from(b.dataBase64, 'base64')));
});
const imageBody = z.object({ dataBase64: z.string().min(1).max(800_000).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64') });
post('/settings/favicon', 'settings:manage', async ({ db, user, body }) => brandingView(await core.setFavicon(db, user.username, Buffer.from(imageBody.parse(body).dataBase64, 'base64'))));
route('DELETE', '/settings/favicon', 'settings:manage', async ({ db, user }) => brandingView(await core.removeFavicon(db, user.username)));
route('DELETE', '/settings/logo', 'settings:manage', async ({ db, user }) => brandingView(await core.removeLogo(db, user.username)));


// ───────────────────────── store-front API (API-key clients) ─────────────────────────
/**
 * The external store-front's contract. Authenticated by `Authorization: Bearer mk_…` (server-to-server; the key must never reach a browser).
 * A shopper's application is additionally protected by its own token (`x-application-token`), returned once when it is created.
 */
const clientRoute = (method: string, path: string, h: (c: PublicCtx & { client: core.ApiClient }) => unknown, extra: Partial<Route> = {}) =>
  route(method, path, null, h as unknown as Handler, { client: true, ...extra });
const selfAccess = (c: { client: core.ApiClient; req: Request }): core.AppAccess => ({ channel: 'SELF_SERVE', clientId: c.client.id, token: c.req.headers.get('x-application-token') ?? undefined });
const cartSchema = z.object({ lines: z.array(z.object({ offerId: z.string().max(80), quantity: z.number().int().min(1).max(5).optional(), attachTo: z.string().max(80).optional(), dealTermMonths: z.number().int().optional() })).min(1).max(10) });
const personalSchema = z.object({
  fullName: z.string().max(100), dateOfBirth: z.string().max(10), nationality: z.string().max(60).optional(), idType: z.enum(core.ID_TYPES), idNumber: z.string().max(30),
  idExpiry: blank(z.string().max(10)), email: z.string().max(120), phone: z.string().max(25),
}).partial();
const addressSchema = z.object({ line1: z.string().max(120), line2: z.string().max(120).optional(), city: z.string().max(80), state: z.string().max(80).optional(), postcode: z.string().max(20), country: z.string().length(2) });
const consentSchema = z.object({ acceptedTerms: z.boolean(), privacyAccepted: z.boolean(), marketingOptIn: z.boolean(), authorisedAssistant: z.boolean().optional() }).partial();
const appPatch = z.object({ lines: cartSchema.shape.lines.optional(), personal: personalSchema.optional(), address: addressSchema.optional(), consent: consentSchema.optional() });
const docUpload = z.object({ kind: z.enum(core.DOC_KINDS), dataBase64: z.string().min(1).max(3_700_000).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64') });
const DOC_BODY = 3_800_000;

clientRoute('GET', '/store/config', async ({ db }) => core.storeConfig(db));
clientRoute('GET', '/store/catalog', async ({ db, query }) => core.storeCatalog(db, 'SELF_SERVE', { q: str(query, 'q'), kind: str(query, 'kind'), notKind: str(query, 'notKind'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
clientRoute('POST', '/store/quote', async ({ db, body }) => core.quoteBasket(db, { ...cartSchema.parse(body), channel: 'SELF_SERVE' }));
clientRoute('POST', '/store/applications', async ({ db, body, req, client }) => {
  const b = cartSchema.parse(body);
  const ip = (req.headers.get('x-shopper-ip') ?? '').slice(0, 45) || null; // the store-front reports the shopper's address; used only to throttle abuse
  const r = await core.createApplication(db, { channel: 'SELF_SERVE', clientId: client.id, lines: b.lines, ip });
  return Response.json({ id: r.application.id, token: r.token, expiresAt: r.application.expiresAt }, { status: 201 });
});
clientRoute('GET', '/store/applications/:id', async (c) => core.applicationView(c.db, c.params.id!, selfAccess(c)));
clientRoute('PATCH', '/store/applications/:id', async (c) => { await core.updateApplication(c.db, c.params.id!, selfAccess(c), appPatch.parse(c.body)); return core.applicationView(c.db, c.params.id!, selfAccess(c)); });
clientRoute('POST', '/store/applications/:id/documents', async (c) => {
  const b = docUpload.parse(c.body);
  return core.uploadDocument(c.db, c.params.id!, selfAccess(c), b.kind, Buffer.from(b.dataBase64, 'base64'));
}, { maxBody: DOC_BODY });
clientRoute('POST', '/store/applications/:id/kyc', async (c) => { await core.submitKyc(c.db, c.params.id!, selfAccess(c)); return core.applicationView(c.db, c.params.id!, selfAccess(c)); });
const payOpts = z.object({ gateway: z.string().max(20).optional(), returnUrl: z.string().max(500).optional() });
clientRoute('POST', '/store/applications/:id/checkout', async (c) => {
  const r = await core.checkout(c.db, c.params.id!, selfAccess(c), payOpts.parse(c.body ?? {}));
  return { application: await core.applicationView(c.db, c.params.id!, selfAccess(c)), payment: r.payment };
});
clientRoute('POST', '/store/applications/:id/payment', async (c) => ({ payment: await core.startPayment(c.db, c.params.id!, selfAccess(c), payOpts.parse(c.body ?? {})) }));
clientRoute('POST', '/store/applications/:id/payment/test', async (c) => {
  await core.testGatewayOutcome(c.db, c.params.id!, selfAccess(c), z.object({ outcome: z.enum(['succeed', 'decline']) }).parse(c.body).outcome);
  return core.applicationView(c.db, c.params.id!, selfAccess(c));
});
clientRoute('POST', '/store/applications/:id/cancel', async (c) => { await core.cancelApplication(c.db, c.params.id!, selfAccess(c)); return { ok: true }; });

/** Payment provider webhooks (one URL per gateway: /api/webhooks/gateway/stripe). Authenticated by the provider's signature over the raw body. */
open('POST', '/webhooks/gateway/:gateway', async ({ db, raw, req, params }) => {
  const gw = core.gatewayById(params.gateway!);
  const ev = gw.verifyWebhook(raw, (n) => req.headers.get(n));
  if (!ev) return { ok: true, ignored: true };
  return { ok: true, ...(await core.applyGatewayEvent(db, gw.id, ev)) };
}, { noCsrf: true });

// ───────────────────────── assisted sales (shop assistant, with the customer present) ─────────────────────────
const staffAccess = (u: SessionUser): core.AppAccess => ({ channel: 'RETAIL_ASSISTED', staff: { username: u.username, storeId: u.scope.storeId ?? null, canSeeAll: !!u.scope.unrestricted } });
get('/assisted/config', 'store:assist', ({ db }) => core.storeConfig(db));
get('/assisted/catalog', 'store:assist', async ({ db, query }) => { const { offers, ...rest } = await core.storeCatalog(db, 'RETAIL_ASSISTED', { q: str(query, 'q'), kind: str(query, 'kind'), notKind: str(query, 'notKind'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }); return { items: offers, ...rest }; });
post('/assisted/quote', 'store:assist', ({ db, body }) => core.quoteBasket(db, { ...cartSchema.extend({ customerId: uuid.optional() }).parse(body), channel: 'RETAIL_ASSISTED' }));
get('/assisted/applications', 'store:assist', async ({ db, user }) => {
  const a = staffAccess(user).staff!;
  const rows = (await db.query(
    `SELECT id, status, created_by, store_id, created_at, customer_id, order_id, personal->>'fullName' AS customer_name, lines FROM applications
     WHERE channel='RETAIL_ASSISTED' ${a.canSeeAll ? '' : 'AND (store_id = $1 OR created_by = $2)'} ORDER BY created_at DESC LIMIT 50`, a.canSeeAll ? [] : [a.storeId, a.username])).rows;
  return { items: rows };
});
post('/assisted/applications', 'store:assist', async ({ db, user, body }) => {
  const b = cartSchema.extend({ customerId: uuid.optional() }).parse(body);
  if (b.customerId) { const c = await core.getCustomer(db, b.customerId); void c; }
  const r = await core.createApplication(db, { channel: 'RETAIL_ASSISTED', lines: b.lines, customerId: b.customerId, staff: { username: user.username, storeId: user.scope.storeId ?? null } });
  return Response.json({ id: r.application.id }, { status: 201 });
});
get('/assisted/applications/:id', 'store:assist', ({ db, user, params }) => core.applicationView(db, params.id!, staffAccess(user)));
patch('/assisted/applications/:id', 'store:assist', async ({ db, user, params, body }) => { await core.updateApplication(db, params.id!, staffAccess(user), appPatch.parse(body)); return core.applicationView(db, params.id!, staffAccess(user)); });
route('POST', '/assisted/applications/:id/documents', 'store:assist', async ({ db, user, params, body }) => {
  const b = docUpload.parse(body);
  return core.uploadDocument(db, params.id!, staffAccess(user), b.kind, Buffer.from(b.dataBase64, 'base64'));
}, { maxBody: DOC_BODY });
post('/assisted/applications/:id/kyc', ['kyc:attest'], async ({ db, user, params, body }) => {
  const b = z.object({ idSighted: z.boolean(), faceMatches: z.boolean(), notes: z.string().max(300).optional() }).parse(body);
  await core.submitKyc(db, params.id!, staffAccess(user), b);
  return core.applicationView(db, params.id!, staffAccess(user));
});
post('/assisted/applications/:id/checkout', 'order:create:RETAIL_ASSISTED', async ({ db, user, params, body }) => {
  const b = z.object({ payment: z.object({ method: z.enum(['CASH', 'CREDIT_CARD', 'QR', 'INSTALLMENT']), reference: z.string().max(100).optional(), confirmed: z.boolean().optional(), installmentMonths: z.number().int().optional() }).optional() }).parse(body);
  need(user, 'store:assist');
  const p = b.payment;
  const confirmed = !!p?.confirmed && user.permissions.has('order:payment');
  if (confirmed && core.paymentMode() === 'manual' && !p?.reference?.trim()) throw new DomainError('INVALID', 'enter the terminal approval or receipt number to confirm payment');
  const r = await core.checkout(db, params.id!, staffAccess(user), { assistedPayment: p ? { method: p.method, reference: p.reference, installmentMonths: p.installmentMonths, confirmed, deferred: !confirmed } : undefined });
  return { application: await core.applicationView(db, params.id!, staffAccess(user)), order: { id: r.order.id, state: r.order.state, totalMinor: r.order.totalMinor, currency: r.order.currency } };
});
post('/assisted/applications/:id/cancel', 'store:assist', async ({ db, user, params }) => { await core.cancelApplication(db, params.id!, staffAccess(user)); return { ok: true }; });

// ───────────────────────── KYC review (compliance) ─────────────────────────
get('/kyc/cases', 'kyc:review', ({ db, query }) => core.listKycCases(db, { status: str(query, 'status'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/kyc/cases/:id', 'kyc:review', ({ db, user, params }) => core.getKycCase(db, params.id!, user.username));
get('/kyc/documents/:id', 'kyc:review', async ({ db, user, params }) => {
  const d = await core.getKycDocument(db, params.id!, user.username);
  return new Response(new Uint8Array(d.bytes), { headers: { 'content-type': d.contentType, 'content-disposition': 'inline', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-store' } });
});
post('/kyc/cases/:id/decision', 'kyc:review', async ({ db, user, params, body }) => {
  const b = z.object({ decision: z.enum(['APPROVE', 'REJECT', 'RETURN']), reason: z.string().max(300).optional() }).parse(body);
  return core.decideKycCase(db, params.id!, user.username, b, await core.getStoreSettings(db));
});

// ───────────────────────── store settings and API keys (super user) ─────────────────────────
const storeSettingsSchema = z.object({
  kycMode: z.enum(['manual', 'auto']), minAge: z.number().int(), requireKycForServices: z.boolean(), termsUrl: z.string().max(300), privacyUrl: z.string().max(300), termsVersion: z.string().max(20),
  applicationTtlHours: z.number().int(), gateways: z.object({ enabled: z.array(z.string().max(20)).max(10), default: z.string().max(20).nullable(), crm: z.array(z.string().max(20)).max(10).default([]) }),
});
get('/settings/store', 'settings:manage', async ({ db }) => ({
  store: await core.getStoreSettings(db),
  gateways: Object.values(core.GATEWAYS).map((g) => ({ id: g.id, label: g.label, configured: g.configured(), paymentLink: !!g.createPaymentLink })),
  clients: await core.listApiClients(db),
  webhookPath: '/api/webhooks/gateway/stripe',
}));
post('/settings/store', 'settings:manage', async ({ db, user, body }) => core.setStoreSettings(db, user.username, storeSettingsSchema.parse(body)));
// ───────────────────────── data migration: exports, templates, jobs ─────────────────────────
const migrationAny: Permission[] = ['migration:export', 'migration:import'];
get('/migration/meta', migrationAny, async ({ db, user }) => ({
  domains: core.DOMAINS, phases: core.PHASES, entities: (await core.publishTemplates(db)).map((e) => ({ ...e, rollback: core.canRollBack(e.id) })), canUnmask: user.permissions.has('settings:manage'), reasonMin: core.REASON_MIN,
  canExport: user.permissions.has('migration:export'), canImport: user.permissions.has('migration:import'),
}));
get('/migration/templates/:entity', migrationAny, async ({ db, params, query }) => {
  const def = core.entityById(params.entity!);
  if (!def) throw new DomainError('NOT_FOUND', 'unknown data set');
  const json = query.get('format') === 'json';
  return json ? new Response(core.templateJson(def), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="meridian-${def.id}-template.json"`, 'cache-control': 'no-store' } })
    : csv(await core.templateCsv(db, def), `meridian-${def.id}-template.csv`);
});
post('/migration/exports', 'migration:export', async ({ db, user, body }) => {
  const b = z.object({
    entities: z.array(z.string().max(40)).max(40).optional(), domains: z.array(z.string().max(20)).max(10).optional(), format: z.enum(['CSV', 'JSON']), unmasked: z.boolean().optional(), reason: z.string().max(300).optional(),
    maxRowsPerEntity: z.number().int().min(1).max(100_000_000).optional(), resume: z.record(z.string().max(300)).optional(), nest: z.boolean().optional(),
  }).parse(body);
  const job = await core.createExportJob(db, user.username, b, { canUnmask: user.permissions.has('settings:manage') });
  return Response.json({ id: job.id, downloadUrl: `/api/migration/exports/${job.id}/download`, masked: job.masked }, { status: 201 });
});
/** The archive, built while it is sent. Once only: a second request is refused. */
get('/migration/exports/:id/download', 'migration:export', async ({ db, user, params }) => {
  const { stream, fileName } = await core.startExport(db, params.id!, user.username);
  return new Response(stream, { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${fileName}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
});
get('/migration/jobs', migrationAny, ({ db, query }) => core.listMigrationJobs(db, { kind: str(query, 'kind'), status: str(query, 'status'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/migration/jobs/:id', migrationAny, ({ db, params }) => core.getMigrationJob(db, params.id!));
// Importing: a file is uploaded (in pieces, or straight to the object store), turned into a job, checked, then loaded in slices.
const uploadBody = z.object({ fileName: z.string().min(1).max(200), totalBytes: z.number().int().min(1).max(5 * 1024 ** 3) });
post('/migration/uploads', 'migration:import', async ({ db, user, body }) => {
  const u = await core.createUpload(db, user.username, uploadBody.parse(body));
  return Response.json({ id: u.id, mode: u.mode, chunks: u.chunks, chunkBytes: u.chunkBytes, presigned: u.presigned ?? null }, { status: 201 });
});
post('/migration/uploads/:id/chunks/:n', 'migration:import', async ({ db, user, params, body }) => {
  const b = z.object({ data: z.string().max(3_000_000) }).parse(body);
  return core.putChunk(db, user.username, params.id!, Number(params.n), Buffer.from(b.data, 'base64'));
}, { maxBody: 3_200_000 });
post('/migration/uploads/:id/complete', 'migration:import', ({ db, user, params }) => core.completeUpload(db, user.username, params.id!));
post('/migration/uploads/:id/discard', 'migration:import', async ({ db, user, params }) => { await core.discardUpload(db, user.username, params.id!); return { ok: true }; });
post('/migration/imports', 'migration:import', async ({ db, user, body }) => {
  const b = z.object({ uploadId: z.string().max(40), entity: z.string().max(40), onError: z.enum(['ABORT', 'SKIP']).optional(), errorThresholdPercent: z.number().min(0).max(100).optional(), batchSize: z.number().int().min(10).max(5000).optional(), autoStart: z.boolean().optional() }).parse(body);
  return Response.json(await core.createImportJob(db, user.username, b), { status: 201 });
});
/** Works on a job for up to about 20 seconds and says where it is. The page calls it while it is open; a scheduler can too. */
post('/migration/jobs/:id/run', 'migration:import', async ({ db, params }) => { const r = await core.runMigrationSlice(db, params.id!); return { ...r.job, busy: !!r.busy, waitingFor: r.waitingFor ?? null }; });
post('/migration/jobs/:id/start', 'migration:import', ({ db, user, params }) => core.startImport(db, user.username, params.id!));
post('/migration/jobs/:id/cancel', 'migration:import', ({ db, user, params }) => core.cancelJob(db, user.username, params.id!));
post('/migration/jobs/:id/rollback', 'migration:import', ({ db, user, params, body }) => core.rollbackJob(db, user.username, params.id!, z.object({ reason: z.string().max(300).optional() }).parse(body ?? {}).reason));
get('/migration/jobs/:id/report.csv', migrationAny, async ({ db, params }) => csv(await core.jobReportCsv(db, params.id!), `migration-report-${params.id}.csv`));
/** For a scheduler: works on whatever import jobs are waiting, so loads go on with nobody watching. */
post('/migration/run', ['billing:run'], ({ db }) => core.runDueMigrationJobs(db));

// ───────────────────────── charging system (OCS): connector, queue, retries ─────────────────────────
get('/integrations/ocs', 'settings:manage', ({ db }) => core.ocsOverview(db));
post('/integrations/ocs', 'settings:manage', async ({ db, user, body }) => {
  const b = z.object({ vendor: z.string().max(40).nullable(), enabled: z.boolean(), config: z.unknown().optional() }).parse(body);
  await core.setOcsSettings(db, user.username, b);
  return core.ocsOverview(db);
});
post('/integrations/ocs/test', 'settings:manage', async ({ db, body }) => {
  const b = z.object({ vendor: z.string().max(40), config: z.unknown() }).parse(body);
  const v = core.OCS_VENDORS[b.vendor];
  if (!v) throw new DomainError('INVALID', 'unknown vendor');
  const c = v.create(v.validate(b.config));
  const problem = c.problem();
  if (problem) return { ok: false, detail: problem };
  return c.test ? c.test() : { ok: true, detail: 'This connector has no connection test.' };
});
get('/integrations/ocs/jobs', 'settings:manage', async ({ db, query }) => ({ items: await core.listOcsJobs(db, { status: str(query, 'status'), serviceId: str(query, 'serviceId'), limit: num(query, 'limit') }) }));
post('/integrations/ocs/jobs/:id/retry', 'settings:manage', ({ db, user, params }) => core.retryOcsJob(db, params.id!, user.username));
/** Delivers due jobs to the charging system. Schedule it every minute (service account with billing:run); the Run now button calls it too. */
post('/ocs/dispatch', 'billing:run', ({ db }) => core.dispatchOcs(db));

/** Every external integration with its live status (environment variable names only, never values). Super user. */
get('/integrations', 'settings:manage', async ({ db }) => core.integrationOverview(db));
// ── cancellation rules (Settings → Cancellation) ──
const conditionSchema = z.object({
  fact: z.string().max(40), op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'not_in', 'contains']),
  value: z.union([z.string().max(60), z.number(), z.boolean(), z.array(z.string().max(60)).max(20)]),
});
const outcomeSchema = z.object({
  allow: z.boolean(), feeFixedMinor: z.number().int().optional(), feePercentBps: z.number().int().optional(), feeMinMinor: z.number().int().optional(), feeMaxMinor: z.number().int().optional(),
  refundBps: z.number().int().optional(), maxDeductionBps: z.number().int().optional(), requiresOverride: z.boolean().optional(),
});
const cancelRuleBody = z.object({
  id: z.string().max(60), name: z.string().max(120), action: z.enum(core.RULE_ACTIONS as [string, ...string[]]), group: z.enum(core.RULE_GROUPS as [string, ...string[]]),
  priority: z.number().int().optional(), enabled: z.boolean().default(true), when: z.array(conditionSchema).max(10).default([]), outcome: outcomeSchema,
  message: z.string().max(300).optional(), showInTerms: z.boolean().default(true),
});
const asRule = (b: z.infer<typeof cancelRuleBody>, priority: number) => ({ ...b, priority: b.priority ?? priority, message: b.message?.trim() || undefined }) as unknown as core.CancellationRule;
const cancellationView = async (db: core.Db) => {
  const currency = (await core.getRegional(db)).currency;
  const rules = await core.listRules(db);
  // Rules can be written against any customer segment the operator has defined, so the list comes from Settings → Customers.
  const segments = (await core.listSegments(db)).map((s) => [s.id, s.name.toLowerCase()] as [string, string]);
  const kinds = (await core.listOfferTypes(db)).map((t) => [t.id, t.name.toLowerCase()] as [string, string]);
  const facts = core.FACTS.map((f) => (f.id === 'segment' ? { ...f, values: segments } : f.id === 'offerKinds' ? { ...f, values: kinds } : f));
  return {
    rules, settings: await core.getCancellationSettings(db), facts, ops: core.OPS.map(([id, label, types]) => ({ id, label, types })), currency,
    descriptions: Object.fromEntries(rules.map((r) => [r.id, core.describeRule(r, currency)])),
  };
};
get('/settings/cancellation', 'settings:manage', ({ db }) => cancellationView(db));
post('/settings/cancellation/rules', 'settings:manage', async ({ db, user, body }) => {
  const b = cancelRuleBody.parse(body);
  const max = Math.max(0, ...(await core.listRules(db)).filter((r) => r.action === b.action).map((r) => r.priority));
  await core.saveRule(db, user.username, asRule(b, max + 10), true);
  return cancellationView(db);
});
patch('/settings/cancellation/rules/:id', 'settings:manage', async ({ db, user, params, body }) => {
  const b = cancelRuleBody.parse({ ...(body as object), id: params.id });
  await core.saveRule(db, user.username, asRule(b, 0), false);
  return cancellationView(db);
});
route('DELETE', '/settings/cancellation/rules/:id', 'settings:manage', async ({ db, user, params }) => { await core.deleteRule(db, user.username, params.id!); return cancellationView(db); });
post('/settings/cancellation/rules/:id/move', 'settings:manage', async ({ db, user, params, body }) => { await core.moveRule(db, user.username, params.id!, z.object({ direction: z.enum(['up', 'down']) }).parse(body).direction); return cancellationView(db); });
post('/settings/cancellation/preview', 'settings:manage', async ({ db, body }) => {
  const b = cancelRuleBody.partial({ id: true, name: true, outcome: true }).parse(body);
  return core.previewRule(asRule({ ...b, id: b.id ?? 'preview', name: b.name ?? 'Preview', outcome: b.outcome ?? { allow: true } } as z.infer<typeof cancelRuleBody>, 0), (await core.getRegional(db)).currency);
});
post('/settings/cancellation/default', 'settings:manage', async ({ db, user, body }) => { await core.setCancellationSettings(db, user.username, { defaultAllow: z.object({ defaultAllow: z.boolean() }).parse(body).defaultAllow }); return cancellationView(db); });
post('/settings/cancellation/reset', 'settings:manage', async ({ db, user }) => { await core.resetRules(db, user.username); return cancellationView(db); });
post('/settings/cancellation/simulate', 'settings:manage', async ({ db, body }) => {
  const b = z.object({ action: z.enum(core.RULE_ACTIONS as [string, ...string[]]), group: z.enum(['GOODS', 'INSTALL', 'ACTIVATION']), facts: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({}), paidMinor: z.number().int().min(0).default(0), canOverride: z.boolean().default(false) }).parse(body);
  return core.simulate(db, { ...b, action: b.action as core.RuleAction, group: b.group, facts: b.facts as core.Facts, currency: (await core.getRegional(db)).currency });
});
post('/settings/api-clients', 'settings:manage', async ({ db, user, body }) => {
  const r = await core.createApiClient(db, user.username, z.object({ name: z.string().min(1).max(60) }).parse(body));
  return Response.json({ client: r.client, key: r.key }, { status: 201, headers: { 'cache-control': 'no-store' } }); // the only time the key is shown
});
route('DELETE', '/settings/api-clients/:id', 'settings:manage', async ({ db, user, params }) => { await core.revokeApiClient(db, user.username, params.id!); return { ok: true }; });

// ───────────────────────── catalog configuration (offer types and fulfilment options) ─────────────────────────
// Read by anyone who works on the catalog (the offer wizard, bundle rules); changed only in Settings by the super user.
get('/catalog-config', 'catalog:read', async ({ db }) => ({ types: await core.listOfferTypes(db, { activeOnly: true }), options: await core.listFulfilmentOptions(db, { activeOnly: true }), serviceKinds: await core.listServiceKinds(db, { activeOnly: true }), ocsEnabled: (await core.getOcsSettings(db)).enabled }));
get('/settings/catalog', 'settings:manage', async ({ db }) => ({ types: await core.listOfferTypes(db, { withUsage: true }), options: await core.listFulfilmentOptions(db, { withUsage: true }), serviceKinds: await core.listServiceKinds(db, { withUsage: true }) }));
/** The behaviour switches of an offer type. Each is optional: what is left out keeps the preset's (or the type's current) value. */
const switchesBody = z.object({
  service: z.string().max(32).nullable(), serviceNeedsFee: z.boolean(), goods: z.boolean(), outright: z.boolean(), contract: z.enum(['none', 'optional']), needsPartner: z.boolean(), needsInstallation: z.boolean(),
  steps: z.array(z.enum(['PLAN', 'DEVICE', 'ADDON'])).max(3), exclusive: z.boolean(),
}).partial();
const kindBody = z.object({ name: z.string().min(1).max(40), description: blank(z.string().max(200)), identifierPrefix: z.string().max(10).optional(), expires: z.boolean().optional(), validityDays: z.number().int().nullable().optional(), provisionSystems: z.array(z.string().max(32)).max(8).optional(), provisionInstruction: z.string().max(32).optional(), deprovisionInstruction: z.string().max(32).optional(), announceStart: z.boolean().optional(), ocsEnabled: z.boolean().optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional() });
post('/settings/service-kinds', 'settings:manage', ({ db, user, body }) => core.createServiceKind(db, user.username, kindBody.parse(body)));
patch('/settings/service-kinds/:id', 'settings:manage', ({ db, user, params, body }) => core.updateServiceKind(db, user.username, params.id!, kindBody.partial().parse(body) as core.ServiceKindInput));
route('DELETE', '/settings/service-kinds/:id', 'settings:manage', async ({ db, user, params }) => { await core.deleteServiceKind(db, user.username, params.id!); return { ok: true }; });
post('/settings/offer-types', 'settings:manage', ({ db, user, body }) => core.createOfferType(db, user.username, z.object({ name: z.string().min(1).max(40), description: blank(z.string().max(200)), template: z.string().max(40), behaviour: switchesBody.optional() }).parse(body)));
patch('/settings/offer-types/:id', 'settings:manage', ({ db, user, params, body }) => core.updateOfferType(db, user.username, params.id!, z.object({ name: z.string().min(1).max(40), description: z.string().max(200), status: z.enum(['ACTIVE', 'INACTIVE']), behaviour: switchesBody }).partial().parse(body)));
route('DELETE', '/settings/offer-types/:id', 'settings:manage', async ({ db, user, params }) => { await core.deleteOfferType(db, user.username, params.id!); return { ok: true }; });
post('/settings/fulfilment-options', 'settings:manage', ({ db, user, body }) => core.createFulfilmentOption(db, user.username, z.object({ name: z.string().min(1).max(40), description: blank(z.string().max(200)), mechanic: z.string().max(20), tracksStock: z.boolean().optional() }).parse(body)));
patch('/settings/fulfilment-options/:id', 'settings:manage', ({ db, user, params, body }) => core.updateFulfilmentOption(db, user.username, params.id!, z.object({ name: z.string().min(1).max(40), description: z.string().max(200), tracksStock: z.boolean(), status: z.enum(['ACTIVE', 'INACTIVE']) }).partial().parse(body)));
route('DELETE', '/settings/fulfilment-options/:id', 'settings:manage', async ({ db, user, params }) => { await core.deleteFulfilmentOption(db, user.username, params.id!); return { ok: true }; });

// ───────────────────────── customers ─────────────────────────
const addressInput = z.object({ line1: blank(z.string().max(120)), line2: blank(z.string().max(120)), postcode: blank(z.string().max(20)), city: blank(z.string().max(80)), state: blank(z.string().max(80)), country: blank(z.string().max(2)) });
const newCustomer = z.object({
  segment: z.string().min(1).max(40), displayName: z.string().min(1).max(200), idDocument: z.string().min(3).max(40),
  marketCode: z.string().length(2).optional(), email: blank(z.string().email()), phone: blank(z.string().max(30)),
  dateOfBirth: blank(z.string().max(10)), gender: blank(z.string().max(20)), address: addressInput.optional(),
  parentCustomerId: uuid.optional(), account: z.object({ name: z.string().optional(), billCycleDay: z.number().int().min(1).max(28).nullable().optional() }).optional(),
});
get('/customers', 'customer:search', ({ db, query }) => core.searchCustomers(db, { q: str(query, 'q'), segment: str(query, 'segment'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
post('/customers', 'customer:create', async ({ db, user, body }) => {
  // A customer normally comes into being with their first order. The order wizard says so (context: 'order'); the Customers screen needs the setting.
  const viaOrder = z.object({ context: z.literal('order').optional() }).parse(body).context === 'order';
  if (!viaOrder && !(await core.getCustomerSettings(db)).allowCreateWithoutOrder) throw new DomainError('REJECTED', 'Customers are created while placing their first order. Your administrator has not allowed creating one on its own (Settings → Customers).');
  const input = newCustomer.parse(body);
  // The settings decide which details are asked for: hidden ones are dropped, required ones must be filled.
  const details = core.checkCustomerDetails((await core.getCustomerSettings(db)).fields, { email: input.email, phone: input.phone, dateOfBirth: input.dateOfBirth, gender: input.gender, address: input.address });
  const billCycleDay = await core.resolveBillCycle(db, input.account?.billCycleDay);
  const r = await core.createCustomer(db, { ...input, email: details.email, phone: details.phone, dateOfBirth: details.dateOfBirth, gender: details.gender, address: details.address, account: { ...input.account, billCycleDay } } as core.NewCustomer);
  await core.audit(db, user.username, 'customer', r.customer.id, 'CREATED');
  return r;
});

/** The 360 shows only the sections a user's permissions cover, so e.g. a dealer never sees invoices or cases. */
function redact360(u: SessionUser, c: core.Row) {
  const has = (p: Permission) => u.permissions.has(p);
  return {
    ...c,
    recentInvoices: has('billing:read') ? c.recentInvoices : [], outstandingMinor: has('billing:read') ? c.outstandingMinor : null, overdueMinor: has('billing:read') ? c.overdueMinor : null,
    cases: has('case:read') ? c.cases : [], recentOrders: has('order:read') ? c.recentOrders : [], serviceSummary: has('service:read') ? c.serviceSummary : [],
    recommendations: has('customer:write') ? c.recommendations : [],
    accounts: noBalance(u, c.accounts),
  };
}
const noBalance = (u: SessionUser, accounts: core.Row[]) => (u.permissions.has('billing:read') ? accounts : accounts.map((a) => ({ ...a, balanceMinor: null })));
get('/customers/:id', 'customer:read', async ({ db, user, params }) => { assertCustomer(user, params.id!); return redact360(user, await core.customer360(db, params.id!)); });
patch('/customers/:id', 'customer:write', async ({ db, user, params, body }) => {
  const b = z.object({ displayName: z.string().optional(), email: z.string().email().optional(), phone: z.string().optional(), status: z.enum(['ACTIVE', 'BLOCKED']).optional(), dateOfBirth: blank(z.string().max(10)), gender: blank(z.string().max(20)), address: addressInput.optional() }).parse(body);
  const d = core.checkCustomerDetails((await core.getCustomerSettings(db)).fields, { email: b.email, phone: b.phone, dateOfBirth: b.dateOfBirth, gender: b.gender, address: b.address }, { partial: true });
  const r = await core.updateCustomer(db, params.id!, { displayName: b.displayName, status: b.status, ...d });
  await core.audit(db, user.username, 'customer', params.id!, 'UPDATED');
  return r;
});
get('/customers/:id/children', 'customer:search', ({ db, params, query }) => core.listChildren(db, params.id!, { deep: query.get('deep') === '1', q: str(query, 'q'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/customers/:id/accounts', 'customer:read', async ({ db, user, params, query }) => {
  assertCustomer(user, params.id!);
  const page = await core.listAccounts(db, params.id!, { q: str(query, 'q'), limit: num(query, 'limit'), cursor: str(query, 'cursor') });
  return { ...page, items: noBalance(user, page.items) };
});
get('/accounts/:id', 'customer:read', async ({ db, user, params }) => { const a = await core.getAccount(db, params.id!); assertCustomer(user, a.customerId); return noBalance(user, [a])[0]; });
post('/customers/:id/accounts', 'customer:write', async ({ db, params, body }) => { const b = z.object({ name: z.string().optional(), billCycleDay: z.number().int().min(1).max(28).nullable().optional() }).parse(body); return core.createAccount(db, params.id!, { ...b, billCycleDay: await core.resolveBillCycle(db, b.billCycleDay) }); });

// ───────────────────────── segments and customer settings ─────────────────────────
get('/segments', 'customer:search', ({ db }) => core.listSegments(db, { activeOnly: true }));
get('/settings/customers', 'settings:manage', async ({ db }) => ({ settings: await core.getCustomerSettings(db), segments: await core.listSegments(db, { withCounts: true }) }));
post('/settings/customers', 'settings:manage', ({ db, user, body }) => core.setCustomerSettings(db, user.username, z.object({ allowCreateWithoutOrder: z.boolean(), fields: z.record(z.enum(core.FIELD_MODES as [string, ...string[]])).optional() }).parse(body) as never));
get('/settings/markets', 'settings:manage', async ({ db }) => ({ ...(await core.getMarketSettings(db)), home: (await core.getRegional(db)).country, known: Object.values(core.MARKETS) }));
post('/settings/markets', 'settings:manage', ({ db, user, body }) => core.setMarketSettings(db, user.username, z.object({ multiple: z.boolean(), defaultMarket: z.string().length(2).optional(), markets: z.array(z.object({ code: z.string().length(2), name: z.string().max(60), dialCode: z.string().max(5), taxName: z.string().max(20), taxBps: z.number().int().min(0).max(10000) })).max(60).optional() }).parse(body) as never));
get('/settings/bill-cycles', 'settings:manage', ({ db }) => core.getBillCycles(db));
post('/settings/bill-cycles', 'settings:manage', ({ db, user, body }) => core.setBillCycles(db, user.username, z.object({ days: z.array(z.number().int().min(1).max(28)).max(28), daily: z.boolean(), defaultCycle: z.union([z.number().int().min(1).max(28), z.literal('daily')]) }).parse(body)));
post('/settings/segments', 'settings:manage', ({ db, user, body }) => core.createSegment(db, user.username, z.object({ name: z.string().min(1).max(40), description: blank(z.string().max(200)), individual: z.boolean().optional() }).parse(body)));
patch('/settings/segments/:id', 'settings:manage', ({ db, user, params, body }) => core.updateSegment(db, user.username, params.id!, z.object({ name: z.string().min(1).max(40), description: z.string().max(200), individual: z.boolean(), status: z.enum(['ACTIVE', 'INACTIVE']) }).partial().parse(body)));
post('/customers/:id/segment', 'customer:write', async ({ db, user, params, body }) => {
  const b = z.object({ segment: z.string().min(1).max(40), reason: z.string().max(300) }).parse(body);
  return db.tx((q) => core.moveCustomerSegment(q, user.username, params.id!, b.segment, b.reason));
});
get('/customers/:id/segment-history', 'customer:read', async ({ db, user, params }) => { assertCustomer(user, params.id!); return { items: await core.listSegmentChanges(db, params.id!) }; });

// ───────────────────────── groups of services (principal + supplementary) ─────────────────────────
const benefitsBody = z.object({
  allowances: z.object({ dataGb: z.number().nullable().optional(), voiceMinutes: z.number().nullable().optional(), smsCount: z.number().nullable().optional() }).optional(),
  discountBps: z.number().int().nullable().optional(),
}).transform((b) => ({ allowances: b.allowances && Object.fromEntries(Object.entries(b.allowances).filter(([, v]) => v !== null && v !== undefined)), discountBps: b.discountBps ?? undefined })) as unknown as z.ZodType<core.GroupBenefits>;
const groupScope = async (u: SessionUser, db: core.Db, groupId: string) => { const g = await core.getGroup(db, groupId); assertCustomer(u, g.customerId); return g; };
get('/accounts/:id/groups', 'customer:read', async ({ db, user, params, query }) => {
  const a = await core.getAccount(db, params.id!); assertCustomer(user, a.customerId);
  return core.listGroups(db, { accountId: params.id!, limit: num(query, 'limit'), cursor: str(query, 'cursor') });
});
post('/accounts/:id/groups', 'service:manage', async ({ db, user, params, body }) => {
  const a = await core.getAccount(db, params.id!); assertCustomer(user, a.customerId);
  const b = z.object({ name: z.string().min(1).max(80), principalServiceId: uuid, supplementaryServiceIds: z.array(uuid).max(200).optional(), benefits: benefitsBody.optional() }).parse(body);
  return db.tx((q) => core.createGroup(q, user.username, { accountId: params.id!, ...b }));
});
get('/groups/:id', 'customer:read', ({ db, user, params }) => groupScope(user, db, params.id!));
patch('/groups/:id', 'service:manage', async ({ db, user, params, body }) => {
  await groupScope(user, db, params.id!);
  return db.tx((q) => core.updateGroup(q, user.username, params.id!, z.object({ name: z.string().min(1).max(80).optional(), benefits: benefitsBody.optional() }).parse(body)));
});
route('DELETE', '/groups/:id', 'service:manage', async ({ db, user, params }) => { await groupScope(user, db, params.id!); await db.tx((q) => core.dissolveGroup(q, user.username, params.id!)); return { ok: true }; });
post('/groups/:id/members', 'service:manage', async ({ db, user, params, body }) => {
  await groupScope(user, db, params.id!);
  return db.tx((q) => core.addGroupMember(q, user.username, params.id!, z.object({ serviceId: uuid }).parse(body).serviceId));
});
route('DELETE', '/groups/:id/members/:serviceId', 'service:manage', async ({ db, user, params }) => {
  await groupScope(user, db, params.id!);
  return (await db.tx((q) => core.removeGroupMember(q, user.username, params.id!, params.serviceId!))) ?? { closed: true };
});
post('/groups/:id/principal', 'service:manage', async ({ db, user, params, body }) => {
  await groupScope(user, db, params.id!);
  return db.tx((q) => core.changePrincipal(q, user.username, params.id!, z.object({ serviceId: uuid }).parse(body).serviceId));
});

/** Vector B: an existing single line moves to a group plan and becomes the family head; the plan's remaining slots stay open for members. */
post('/services/:id/upgrade-to-group', 'service:manage', async ({ db, user, params, body }) => new core.GroupOrderService(db).upgrade(params.id!, z.object({ offerId: z.string().max(70) }).parse(body).offerId, user.username));

// ───────────────────────── number portability into the operator (port-in) ─────────────────────────
/** The operators numbers can come from, with their operator IDs. Everyone who sells reads the active ones for the drop-down; the super user keeps the list. */
get('/settings/donor-operators', ['numbering:select', 'mnp:manage', 'settings:manage'], ({ db, query }) => core.listDonorOperators(db, { activeOnly: query.get('active') === '1' }).then((items) => ({ items })));
post('/settings/donor-operators', ['settings:manage'], ({ db, user, body }) => core.createDonorOperator(db, user.username, z.object({ name: z.string().max(80), mnpOperatorId: z.string().max(30) }).parse(body)));
patch('/settings/donor-operators/:id', ['settings:manage'], ({ db, user, params, body }) => core.updateDonorOperator(db, user.username, params.id!, z.object({ name: z.string().max(80).optional(), mnpOperatorId: z.string().max(30).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional() }).parse(body)));
route('DELETE', '/settings/donor-operators/:id', ['settings:manage'], ({ db, user, params }) => core.deleteDonorOperator(db, user.username, params.id!));
get('/mnp/port-in', ['mnp:manage'], ({ db, query }) => core.listPortIns(db, { status: str(query, 'status'), customerId: str(query, 'customerId'), q: str(query, 'q'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/mnp/port-in/:id', ['mnp:manage'], ({ db, params }) => core.getPortIn(db, params.id!));
/** The clearinghouse's callback: the donor approved or refused. `complete` also does the switch-over at once. Repeating an answer changes nothing. */
post('/mnp/port-in/:id/decision', ['mnp:manage'], ({ db, user, params, body }) => core.decidePortIn(db, params.id!, {
  ...z.object({ approved: z.boolean(), reference: z.string().max(60).optional(), reason: z.string().max(200).optional(), effectiveAt: z.string().max(40).optional(), complete: z.boolean().optional() }).parse(body), actor: user.username,
}));
post('/mnp/port-in/:id/complete', ['mnp:manage'], ({ db, user, params }) => core.completePortIn(db, params.id!, user.username));
post('/mnp/port-in/:id/cancel', ['mnp:manage'], ({ db, user, params, body }) => core.cancelPortIn(db, params.id!, z.object({ reason: z.string().max(200).default('cancelled') }).parse(body ?? {}).reason, user.username));

// ───────────────────────── services ─────────────────────────
get('/services', 'service:read', ({ db, user, query }) => core.listServices(db, {
  customerId: user.scope.customerId ?? str(query, 'customerId'), accountId: str(query, 'accountId'), status: str(query, 'status'), q: str(query, 'q'), limit: num(query, 'limit'), cursor: str(query, 'cursor'), groupable: query.get('groupable') === '1',
}));
const etcAdjust = z.object({ waive: z.boolean().optional(), percent: z.number().min(0).max(100).optional(), reason: z.string().min(1).max(300) });
const svcAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('suspend'), reason: z.string().max(60).optional() }),
  z.object({ action: z.literal('suspend-voluntary'), months: z.number().int().min(1).max(24).optional(), until: date.optional() }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('change-sim'), iccid: z.string() }), z.object({ action: z.literal('change-msisdn'), msisdn: z.string().optional() }),
  z.object({ action: z.literal('transfer'), toCustomerId: uuid, toAccountId: uuid.optional() }),
  z.object({ action: z.literal('terminate'), reason: z.string().optional(), unbilledUsageMinor: z.number().int().min(0).optional(), refundDeposit: z.boolean().optional(), etcAdjust: etcAdjust.optional() }),
  z.object({ action: z.literal('port-out'), recipientOperator: z.string(), portingCode: z.string().optional() }),
  z.object({ action: z.literal('complete-port-out'), reference: z.string().max(60).optional(), unbilledUsageMinor: z.number().int().min(0).optional() }), z.object({ action: z.literal('cancel-port-out') }),
]);
// A customer can suspend and resume their own service in the portal ('service:self'); everything else is for staff.
const ACTION_PERM: Record<string, Permission[]> = {
  suspend: ['service:suspend'], 'suspend-voluntary': ['service:suspend', 'service:self'], resume: ['service:manage', 'service:self'], 'change-sim': ['service:manage'], 'change-msisdn': ['service:manage'],
  transfer: ['service:transfer'], terminate: ['service:terminate'], 'port-out': ['mnp:manage'], 'complete-port-out': ['mnp:manage'], 'cancel-port-out': ['mnp:manage'],
};
const channelOf = (u: SessionUser): core.LifecycleChannel => (u.scope.customerId ? 'SELF_SERVE' : 'STAFF');
post('/services/:id/actions', null, async ({ db, user, params, body }) => {
  const a = svcAction.parse(body); const id = params.id!;
  const allowed = ACTION_PERM[a.action]!;
  if (!allowed.some((p) => user.permissions.has(p))) throw forbidden(`Your role does not allow this (${allowed[0]}).`);
  const svc = (await db.query('SELECT customer_id FROM services WHERE id=$1', [id])).rows[0];
  if (!svc) throw new DomainError('NOT_FOUND', 'service not found');
  assertCustomer(user, svc.customerId);
  const actor = user.username;
  const life = new core.LifecycleService(db);
  switch (a.action) {
    case 'suspend': return life.suspendService(id, a.reason === 'CUSTOMER_REQUEST' ? { kind: 'VOLUNTARY' } : { kind: a.reason === 'FRAUD' ? 'FRAUD' : 'ADMIN', reason: a.reason }, actor, channelOf(user));
    case 'suspend-voluntary': return life.suspendService(id, { kind: 'VOLUNTARY', months: a.months, until: a.until }, actor, channelOf(user));
    case 'resume': return life.resumeService(id, actor, channelOf(user));
    case 'change-sim': return core.changeSim(db, id, a.iccid, actor);
    case 'change-msisdn': return core.changeMsisdn(db, id, a.msisdn, actor);
    case 'transfer': return core.transferOwnership(db, id, a.toCustomerId, a.toAccountId, actor);
    case 'terminate': {
      if (a.etcAdjust) need(user, 'order:override'); // waiving or reducing a charge is an exception a supervisor approves
      return life.terminateService(id, { reason: a.reason, unbilledUsageMinor: a.unbilledUsageMinor, refundDeposit: a.refundDeposit, etcAdjust: a.etcAdjust }, actor);
    }
    case 'port-out': return core.requestPortOut(db, id, a, actor);
    case 'complete-port-out': return core.completePortOut(db, id, actor, { reference: a.reference, unbilledUsageMinor: a.unbilledUsageMinor });
    case 'cancel-port-out': return core.cancelPortOut(db, id, actor);
  }
});
/** What it takes to get a restricted service back: why it is restricted, what is owed, and whether the customer can lift it themselves. */
get('/services/:id/restoration', ['service:read'], async ({ db, user, params }) => {
  const s = (await db.query('SELECT * FROM services WHERE id=$1', [params.id])).rows[0];
  if (!s) throw new DomainError('NOT_FOUND', 'service not found');
  assertCustomer(user, s.customerId);
  const kind = core.restrictionOf(s);
  const owed = (await db.query(`SELECT id, number, due_date, total_minor - paid_minor - credited_minor AS balance_minor FROM invoices WHERE account_id=$1 AND status IN ('ISSUED','OVERDUE') AND due_date < current_date AND total_minor - paid_minor - credited_minor > 0 ORDER BY due_date`, [s.accountId])).rows;
  return {
    status: s.status, barLevel: s.barLevel, reason: kind, since: s.suspendedAt, until: s.suspendUntil,
    customerCanResume: s.status === 'SUSPENDED' && (kind === 'VOLUNTARY' || (kind === 'DUNNING' && owed.length === 0)),
    overdue: owed, overdueMinor: owed.reduce((t, i) => t + Number(i.balanceMinor), 0),
    how: kind === 'DUNNING' ? 'Pay the overdue balance and service comes back at once.' : kind === 'VOLUNTARY' ? 'Resume from the portal, or it resumes by itself on the end date.' : kind === 'CREDIT' ? 'Pay your bill or ask us to raise the limit.' : kind ? 'Contact us.' : null,
  };
});
/** Pay-to-resume for a call-centre agent or a store: takes payment for everything overdue; the service is restored by the payment itself. */
post('/services/:id/pay-to-resume', ['billing:pay'], async ({ db, user, params, body }) => {
  const b = z.object({ method: z.enum(['CASH', 'CREDIT_CARD', 'QR']), reference: z.string().max(80).optional() }).parse(body);
  const s = (await db.query('SELECT * FROM services WHERE id=$1', [params.id])).rows[0];
  if (!s) throw new DomainError('NOT_FOUND', 'service not found');
  assertCustomer(user, s.customerId);
  const owed = (await db.query(`SELECT id FROM invoices WHERE account_id=$1 AND status IN ('ISSUED','OVERDUE') AND due_date < current_date AND total_minor - paid_minor - credited_minor > 0 ORDER BY due_date`, [s.accountId])).rows;
  for (const i of owed) await core.payInvoice(db, i.id, { method: b.method, reference: b.reference }, user.username);
  const now = (await db.query('SELECT * FROM services WHERE id=$1', [params.id])).rows[0]!;
  return { paidInvoices: owed.length, service: now };
});
get('/services/:id/lifecycle', ['service:read'], async ({ db, user, params, query }) => {
  const s = (await db.query('SELECT customer_id FROM services WHERE id=$1', [params.id])).rows[0];
  if (!s) throw new DomainError('NOT_FOUND', 'service not found');
  assertCustomer(user, s.customerId);
  return { items: await new core.LifecycleService(db).history(params.id!, num(query, 'limit') ?? 100) };
});
// Charging system (OCS) and the clearinghouse call these with an API client or a back-office login.
post('/accounts/:id/credit-check', ['billing:run'], ({ db, user, params, body }) => core.evaluateCreditLimit(db, params.id!, { unbilledUsageMinor: z.object({ unbilledUsageMinor: z.number().int().min(0) }).parse(body).unbilledUsageMinor, actor: user.username }));
patch('/accounts/:id/credit-limit', ['billing:credit'], async ({ db, user, params, body }) => {
  const b = z.object({ creditLimitMinor: z.number().int().min(0).nullable() }).parse(body);
  await db.query('UPDATE accounts SET credit_limit_minor=$2 WHERE id=$1', [params.id, b.creditLimitMinor]);
  await core.audit(db, user.username, 'account', params.id!, 'CREDIT_LIMIT_SET', { creditLimitMinor: b.creditLimitMinor });
  return { ok: true };
});
post('/accounts/:id/deposit', ['billing:pay'], ({ db, user, params, body }) => core.receiveDeposit(db, params.id!, z.object({ amountMinor: z.number().int().min(1), method: z.enum(['CASH', 'CREDIT_CARD', 'QR']).optional(), reference: z.string().max(80).optional() }).parse(body), user.username));
post('/accounts/:id/dunning', ['billing:run'], ({ db, user, params, body }) => {
  const b = z.object({ asOf: date.optional(), only: z.enum(core.DUNNING_ACTIONS).optional() }).parse(body ?? {});
  return core.evaluateDunningLadder(db, params.id!, b.asOf, { only: b.only, actor: user.username });
});
get('/accounts/:id/dunning', ['billing:read'], async ({ db, user, params }) => {
  const a = await core.getAccount(db, params.id!); assertCustomer(user, a.customerId);
  const runs = (await db.query(`SELECT * FROM dunning_runs WHERE account_id=$1 ORDER BY id DESC LIMIT 10`, [params.id])).rows;
  const steps = runs.length ? (await db.query(`SELECT run_id, step, day_offset, applied_on, outcome FROM dunning_steps WHERE run_id = ANY($1::bigint[]) ORDER BY id`, [runs.map((r) => r.id)])).rows : [];
  return { stage: a.dunningStage, ladder: (await core.getLifecycleSettings(db)).dunning, runs: runs.map((r) => ({ ...r, steps: steps.filter((x) => x.runId === r.id) })) };
});
post('/lifecycle/run', ['billing:run'], ({ db, body }) => new core.LifecycleService(db).runDailyJobs(z.object({ asOf: date.optional() }).parse(body ?? {}).asOf));
get('/lifecycle/outbox', ['billing:run'], async ({ db, query }) => ({ items: (await db.query(`SELECT id::text, created_at, kind, service_id, account_id, instruction, payload, delivered_at FROM lifecycle_outbox WHERE ($1::boolean IS NOT TRUE OR delivered_at IS NULL) AND ($2::text IS NULL OR kind = $2) ORDER BY id DESC LIMIT $3`, [query.get('pending') === '1', str(query, 'kind') ?? null, Math.min(num(query, 'limit') ?? 100, 500)])).rows }));
post('/lifecycle/outbox/ack', ['billing:run'], async ({ db, body }) => { const ids = z.object({ ids: z.array(z.string().regex(/^\d+$/)).min(1).max(500) }).parse(body).ids; await db.query(`UPDATE lifecycle_outbox SET delivered_at = now() WHERE id = ANY($1::bigint[]) AND delivered_at IS NULL`, [ids]); return { ok: true }; });
/** The national clearinghouse confirmed a port-out: the service ends, the closing invoice goes out, the resources are released. Idempotent. */
post('/mnp/port-out/confirmation', ['mnp:manage'], ({ db, user, body }) => {
  const b = z.object({ serviceId: uuid.optional(), identifier: z.string().max(20).optional(), reference: z.string().max(60).optional(), unbilledUsageMinor: z.number().int().min(0).optional() }).parse(body);
  return new core.LifecycleService(db).confirmPortOut(b, user.username);
});
get('/settings/lifecycle', ['settings:manage'], ({ db }) => core.getLifecycleSettings(db));
post('/settings/lifecycle', ['settings:manage'], ({ db, user, body }) => core.setLifecycleSettings(db, user.username, z.object({
  voluntary: z.object({ maxMonths: z.number().int(), selfServe: z.boolean() }),
  credit: z.object({ defaultLimitMinor: z.number().int(), warnPercent: z.number(), blockPercent: z.number(), blockAction: z.enum(['THROTTLE', 'SOFT_BAR']) }),
  dunning: z.array(z.object({ action: z.enum(core.DUNNING_ACTIONS), day: z.number().int() })).max(10),
  termination: z.object({ quarantineDays: z.number().int(), debtAction: z.enum(['COLLECTIONS', 'WRITE_OFF']), waiveEtcSegments: z.array(z.string().max(60)).max(50).default([]) }),
}).parse(body)));
get('/services/:id', 'service:read', async ({ db, user, params }) => {
  const s = (await db.query('SELECT s.*, c.name AS offer_name FROM services s LEFT JOIN catalog_nodes c ON c.id = s.offer_id WHERE s.id=$1', [params.id])).rows[0];
  if (!s) throw new DomainError('NOT_FOUND', 'service not found');
  assertCustomer(user, s.customerId);
  return s;
});
get('/services/:id/etc', 'service:read', async ({ db, user, params }) => {
  const s = (await db.query('SELECT * FROM services WHERE id=$1', [params.id])).rows[0];
  if (!s) throw new DomainError('NOT_FOUND', 'service not found');
  assertCustomer(user, s.customerId);
  if (!s.contractTermMonths || !s.contractStart) return { chargeMinor: 0, monthsRemaining: 0, waived: false };
  return core.etcQuoteForService(db, s, new Date());
});

// ───────────────────────── orders ─────────────────────────
const portInBody = z.object({
  donorOperatorId: uuid, donorMsisdn: z.string().min(8).max(20), holderName: z.string().min(1).max(100),
  holderIdType: z.string().min(1).max(20), holderIdNumber: z.string().min(1).max(40), temporaryNumber: z.boolean().optional(),
});
/** A member line of a group plan: a new number, a chosen number, or a number ported in, each with its own SIM and plan. */
const memberBody = z.object({
  offerId: z.string(), msisdn: z.string().optional(), iccid: z.string().regex(/^89\d{17,18}$/).optional(), simType: z.enum(['PHYSICAL', 'ESIM']).optional(), numberToken: z.string().max(80).optional(),
  options: z.object({ variantId: z.string().max(40).optional() }).optional(), payment: z.object({ mode: z.enum(['UPFRONT', 'INSTALLMENT']), months: z.number().int().optional(), downPaymentMinor: z.number().int().min(0).optional() }).optional(),
  portIn: portInBody.optional(),
});
const lineBody = z.object({
  offerId: z.string(), quantity: z.number().int().min(1).max(1_000_000).optional(), msisdn: z.string().optional(), serialNumber: z.string().optional(),
  options: z.object({ variantId: z.string().max(40).optional() }).optional(),
  iccid: z.string().regex(/^89\d{17,18}$/).optional(), simType: z.enum(['PHYSICAL', 'ESIM']).optional(), numberToken: z.string().max(80).optional(),
  attachTo: z.number().int().min(0).max(49).optional(), dealTermMonths: z.number().int().optional(),
  members: z.array(memberBody).max(20).optional(), joinGroupId: uuid.optional(), portIn: portInBody.optional(),
  payment: z.object({ mode: z.enum(['UPFRONT', 'INSTALLMENT']), months: z.number().int().optional(), downPaymentMinor: z.number().int().min(0).optional() }).optional(),
});
const orderBody = z.object({
  customerId: uuid.optional(), accountId: uuid.optional(), channel: z.enum(core.CHANNELS),
  lines: z.array(lineBody).min(1).max(50),
  payment: z.object({ method: z.enum(['CREDIT_CARD', 'CASH', 'QR', 'INSTALLMENT']), installmentMonths: z.number().int().optional(), reference: z.string().max(100).optional(), confirmed: z.boolean().optional() }),
  storeId: z.string().max(50).optional(), dealerId: z.string().max(50).optional(), dealerAgentId: z.string().max(60).optional(),
  deliveryAddress: z.string().max(500).optional(), installationSlot: z.string().max(40).optional(),
  delivery: z.object({ method: z.enum(['SHIP', 'COLLECT']), pickupStoreId: z.string().max(50).optional() }).optional(),
});
// The wizard's review step: the full priced summary, nothing saved. Same channel permission as placing the order.
post('/orders/quote', null, async ({ db, user, body }) => {
  const raw = z.object({ channel: z.enum(core.CHANNELS) }).parse(body);
  need(user, `order:create:${raw.channel}` as Permission);
  const b = orderBody.partial({ payment: true }).parse(body);
  return core.quoteOrder(db, { customerId: user.scope.customerId ?? b.customerId, accountId: b.accountId, channel: b.channel, marketCode: user.marketCode, lines: b.lines, payment: { method: b.payment?.method ?? 'CREDIT_CARD', installmentMonths: b.payment?.installmentMonths } });
});
get('/orders/addons', 'order:read', ({ db, user, query }) => core.eligibleAddons(db, {
  customerId: user.scope.customerId ?? str(query, 'customerId'), offerIds: (str(query, 'offers') ?? '').split(',').filter(Boolean).slice(0, 20), channel: z.enum(core.CHANNELS).parse(str(query, 'channel')),
  marketCode: user.marketCode ?? 'SG', q: str(query, 'q'), limit: num(query, 'limit'), cursor: str(query, 'cursor'),
}));
get('/orders', 'order:read', ({ db, user, query }) => core.listOrders(db, {
  customerId: user.scope.customerId ?? str(query, 'customerId'), storeId: user.scope.storeId, dealerId: user.scope.dealerId,
  state: str(query, 'state'), channel: str(query, 'channel'), q: str(query, 'q'), limit: num(query, 'limit'), cursor: str(query, 'cursor'),
}));
post('/orders', null, async ({ db, user, body, req }) => {
  // Authorise the channel before validating anything else: a role that cannot sell here learns nothing about the payload rules.
  need(user, `order:create:${z.object({ channel: z.enum(core.CHANNELS) }).parse(body).channel}` as Permission);
  const b = orderBody.parse(body);
  const s = user.scope;
  // Who sold it is decided here from the session, never from the request body: otherwise commission could be forged.
  const retail = b.channel === 'RETAIL_ASSISTED' || b.channel === 'QUICK_SALE';
  if (b.channel === 'SELF_SERVE' && !s.customerId) throw new DomainError('INVALID', 'self-serve orders come from the store-front, not the CRM');
  // A quick sale is rung up at the user's own store: it is never taken from the request.
  const storeId = b.channel === 'QUICK_SALE' ? (s.storeId ?? user.storeId ?? undefined) : retail ? (s.storeId ?? b.storeId ?? user.storeId ?? undefined) : undefined;
  const dealerId = b.channel === 'DEALER' ? (s.dealerId ?? b.dealerId ?? user.dealerId ?? undefined) : undefined;
  if (storeId) await core.assertStoreUsable(db, storeId); // sold at a store that exists and is switched on
  if (retail && !storeId) throw new DomainError('INVALID', b.channel === 'QUICK_SALE' ? 'a quick sale is rung up at a store: sign in as a store user' : 'a store is required for retail orders');
  if (b.channel === 'DEALER' && !dealerId) throw new DomainError('INVALID', 'a dealer is required for dealer orders');
  if (b.channel === 'DEALER' && !b.dealerAgentId) throw new DomainError('INVALID', 'choose the dealer’s agent who sold this');
  const customerId = s.customerId ?? b.customerId;
  const portal = !!s.customerId;
  // Only a cashier may state that money was received; everyone else's order waits for confirmation.
  const confirmed = !!b.payment.confirmed && user.permissions.has('order:payment') && !portal;
  if (confirmed && core.paymentMode() === 'manual' && !b.payment.reference?.trim()) throw new DomainError('INVALID', 'enter the terminal approval or receipt number to confirm payment');

  const key = req.headers.get('idempotency-key')?.slice(0, 100);
  if (key) {
    const ins = await db.query('INSERT INTO idempotency_keys (key, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [key, user.id]);
    if (!ins.rowCount) {
      const row = (await db.query('SELECT order_id FROM idempotency_keys WHERE key=$1 AND user_id=$2', [key, user.id])).rows[0];
      if (row?.orderId) { const o = await core.getOrder(db, row.orderId); assertOrder(user, o); return new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json', 'x-idempotent-replay': 'true' } }); }
      throw new DomainError('CONFLICT', 'this order is already being processed');
    }
  }
  try {
    const order = await core.placeOrder(db, {
      customerId, accountId: b.accountId, channel: b.channel, marketCode: user.marketCode, lines: b.lines,
      payment: { method: b.payment.method, installmentMonths: b.payment.installmentMonths, reference: b.payment.reference, confirmed },
      attribution: portal ? {} : { storeId, dealerId, dealerAgentId: dealerId ? b.dealerAgentId : undefined, salespersonId: user.username }, deliveryAddress: b.deliveryAddress, delivery: b.delivery, installationSlot: b.installationSlot, actor: user.username,
    });
    if (key) await db.query('UPDATE idempotency_keys SET order_id=$3 WHERE key=$1 AND user_id=$2', [key, user.id, order.id]);
    return order;
  } catch (e) {
    if (key) await db.query('DELETE FROM idempotency_keys WHERE key=$1 AND user_id=$2 AND order_id IS NULL', [key, user.id]);
    throw e;
  }
});
get('/orders/:id', 'order:read', async ({ db, user, params }) => {
  const o = await core.getOrder(db, params.id!, { initiatedBy: user.scope.customerId ? 'CUSTOMER' : 'STAFF', canOverride: user.permissions.has('order:override') });
  assertOrder(user, o);
  return o;
});
const orderAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('confirm_payment'), reference: z.string().max(100).optional() }), z.object({ type: z.literal('schedule_installation'), slot: z.string() }),
  z.object({ type: z.literal('dispatch_technician') }), z.object({ type: z.literal('complete_installation') }),
  z.object({ type: z.literal('ship'), trackingNumber: z.string().max(100).optional() }), z.object({ type: z.literal('deliver') }),
  z.object({ type: z.literal('ready_for_collection') }), z.object({ type: z.literal('collect') }),
  z.object({ type: z.literal('cancel'), reason: z.string().max(300).default('cancelled by user'), groups: z.array(z.enum(['ACTIVATION', 'GOODS', 'INSTALL'])).max(3).optional() }),
  z.object({ type: z.literal('return'), reason: z.string().min(3).max(300), deductionMinor: z.number().int().min(0).optional(), condition: z.enum(['GOOD', 'DAMAGED', 'INCOMPLETE']).optional() }),
]);
post('/orders/:id/actions', null, async ({ db, user, params, body }) => {
  const a = orderAction.parse(body);
  need(user, a.type === 'cancel' || a.type === 'return' ? 'order:cancel' : a.type === 'confirm_payment' ? 'order:payment' : 'order:fulfil');
  assertOrder(user, await core.getOrder(db, params.id!));
  const canOverride = user.permissions.has('order:override');
  if (a.type === 'cancel') return core.cancelOrder(db, params.id!, a.reason, user.username, { groups: a.groups, canOverride, initiatedBy: user.scope.customerId ? 'CUSTOMER' : 'STAFF' });
  if (a.type === 'return') return core.returnGoods(db, params.id!, { reason: a.reason, deductionMinor: a.deductionMinor, condition: a.condition }, user.username, { canOverride });
  return core.advanceOrder(db, params.id!, a, user.username);
});
/** A card payment page for the customer to open on their own phone, for an order waiting for money. Only through a gateway switched on for the CRM. */
post('/orders/:id/payment-link', null, async ({ db, user, params, req }) => {
  need(user, 'order:payment');
  assertOrder(user, await core.getOrder(db, params.id!));
  const origin = new URL(req.url).origin;
  return core.createPaymentLink(db, params.id!, user.username, { returnUrl: `${origin}/pay/done` });
});

// ───────────────────────── billing ─────────────────────────
get('/invoices', 'billing:read', ({ db, user, query }) => core.listInvoices(db, {
  customerId: user.scope.customerId ?? str(query, 'customerId'), accountId: str(query, 'accountId'), status: str(query, 'status'), q: str(query, 'q'), limit: num(query, 'limit'), cursor: str(query, 'cursor'),
}));
get('/invoices/:id', 'billing:read', async ({ db, user, params }) => { const i = await core.getInvoice(db, params.id!); assertCustomer(user, i.customerId); return i; });
post('/invoices/:id/pay', 'billing:pay', async ({ db, user, params, body }) => {
  assertCustomer(user, (await core.getInvoice(db, params.id!)).customerId);
  return core.payInvoice(db, params.id!, z.object({ amountMinor: money.optional(), method: z.enum(['CASH', 'CREDIT_CARD', 'QR']), reference: z.string().max(100).optional(), idempotencyKey: z.string().max(100).optional() }).parse(body), user.username);
});
post('/invoices/:id/credit', 'billing:credit', async ({ db, user, params, body }) => {
  const b = z.object({ amountMinor: money, reason: z.string().min(3).max(300), caseId: uuid.optional() }).parse(body);
  const limit = user.creditLimitMinor;
  if (limit !== null && b.amountMinor > limit) throw forbidden(`This credit is above your limit (${formatMoney(limit, await core.getRegional(db))}). Ask Billing or Finance to issue it.`);
  return core.creditInvoice(db, params.id!, b.amountMinor, b.reason, user.username, b.caseId);
});
// ───────────────────────── governed bill runs: mock → review → exclusions → approval → production ─────────────────────────
get('/billing/runs/settings', 'billing:read', ({ db }) => core.getBillRunSettings(db));
post('/billing/runs/settings', 'settings:manage', ({ db, user, body }) => core.setBillRunSettings(db, user.username, z.object({
  enforceGovernance: z.boolean(), dualControl: z.boolean(), spikePercent: z.number(), dropPercent: z.number(), largeMinor: z.number(), maxMockAgeHours: z.number() }).parse(body)));
get('/billing/cycles', 'billing:read', async ({ db }) => ({ items: await core.listCycleConfigs(db) }));
patch('/billing/cycles/:day', 'settings:manage', ({ db, user, params, body }) => core.updateCycleConfig(db, user.username, Number(params.day), z.object({ label: z.string().max(60).optional(), enabled: z.boolean().optional(), dualControl: z.boolean().nullable().optional(), notes: z.string().max(500).optional() }).parse(body)));
get('/billing/runs', 'billing:read', ({ db, query }) => core.listBillRuns(db, { status: str(query, 'status'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
post('/billing/runs', 'billing:run', async ({ db, user, body }) => Response.json(await core.createBillRun(db, user.username, z.object({
  cycleDay: z.number().int().optional(), daily: z.boolean().optional(), accountIds: z.array(z.string().uuid()).max(core.SELECTIVE_MAX).optional(), asOf: date.optional(), note: z.string().max(500).optional() }).parse(body)), { status: 201 }));
get('/billing/runs/:id', 'billing:read', ({ db, params }) => core.getBillRun(db, params.id!));
get('/billing/runs/:id/items', 'billing:read', ({ db, params, query }) => core.listBillRunItems(db, params.id!, { status: str(query, 'status'), anomaly: str(query, 'anomaly'), q: str(query, 'q'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/billing/runs/:id/accounts/:accountId', 'billing:read', ({ db, params }) => core.previewRunAccount(db, params.id!, params.accountId!));
/** Works on a run for up to about 20 seconds and says where it is. The page calls it while it is open; a scheduler can too (POST /billing/run-due). */
post('/billing/runs/:id/work', 'billing:run', async ({ db, params }) => { const r = await core.runBillRunSlice(db, params.id!); return { ...r.run, busy: !!r.busy }; });
post('/billing/runs/:id/submit', 'billing:run', ({ db, user, params, body }) => core.submitForApproval(db, user.username, params.id!, z.object({ note: z.string().max(500).optional() }).parse(body ?? {}).note));
post('/billing/runs/:id/approve', 'billing:approve', ({ db, user, params, body }) => { const b = z.object({ note: z.string().max(400).optional(), execute: z.boolean().optional() }).parse(body ?? {}); return core.approveBillRun(db, user.username, params.id!, b); });
post('/billing/runs/:id/reject', 'billing:approve', ({ db, user, params, body }) => core.rejectBillRun(db, user.username, params.id!, z.object({ note: z.string().min(1).max(400) }).parse(body).note));
post('/billing/runs/:id/execute', 'billing:approve', ({ db, user, params }) => core.executeBillRun(db, user.username, params.id!));
post('/billing/runs/:id/remock', 'billing:run', ({ db, user, params }) => core.remock(db, user.username, params.id!));
post('/billing/runs/:id/cancel', 'billing:run', ({ db, user, params, body }) => core.cancelBillRun(db, user.username, params.id!, z.object({ note: z.string().max(400).optional() }).parse(body ?? {}).note));
post('/billing/runs/:id/retry', 'billing:run', ({ db, user, params, body }) => core.retryFailedItems(db, user.username, params.id!, z.object({ accountIds: z.array(z.string().uuid()).max(5000).optional() }).parse(body ?? {}).accountIds));
post('/billing/runs/:id/include', 'billing:run', ({ db, user, params, body }) => core.includeAccounts(db, user.username, params.id!, z.object({ accountIds: z.array(z.string().uuid()).min(1).max(5000) }).parse(body).accountIds));
get('/billing/exclusions', 'billing:read', async ({ db, query }) => ({ items: await core.listExclusions(db, { runId: str(query, 'runId') }) }));
post('/billing/exclusions', 'billing:run', async ({ db, user, body }) => Response.json(await core.addExclusion(db, user.username, z.object({
  accountId: z.string().uuid().optional(), customerId: z.string().uuid().optional(), runId: z.string().uuid().optional(), reason: z.string().min(1).max(300), untilDate: date.optional() }).parse(body)), { status: 201 }));
post('/billing/exclusions/:id/remove', 'billing:run', async ({ db, user, params }) => { await core.removeExclusion(db, user.username, Number(params.id)); return { ok: true }; });
/** For a scheduler: works on whatever mock or production runs are waiting, so a big run goes on with nobody watching. */
post('/billing/run-due', 'billing:run', ({ db }) => core.runDueBillRuns(db));
// ───────────────────────── billing simulation: forecasts, termination quotes, plan-change previews (change nothing; may be saved) ─────────────────────────
const sim = ['billing:simulate'] as Permission[];
const saveFields = { save: z.boolean().optional(), title: z.string().max(120).optional() };
/** Runs a simulation and, when asked, keeps it with the person who ran it. */
const keep = async (db: Db, user: SessionUser, kind: core.SimulationKind, params: Record<string, unknown>, result: Record<string, unknown>, b: { save?: boolean; title?: string }) =>
  Response.json(b.save ? { ...result, saved: await core.saveSimulation(db, user.username, kind, params, result as never, b.title) } : result);
post('/billing/simulate/projection', sim, async ({ db, user, body }) => {
  const b = z.object({ ref: z.string().min(1).max(60), months: z.number().int().min(1).max(core.PROJECTION_MAX_MONTHS), from: date.optional(), ...saveFields }).parse(body);
  return keep(db, user, 'PROJECTION', { ref: b.ref, months: b.months, from: b.from ?? null }, await core.projectAccount(db, b.ref, { months: b.months, from: b.from }), b);
});
post('/billing/simulate/termination', sim, async ({ db, user, body }) => {
  const b = z.object({ ref: z.string().min(1).max(60), date: date.optional(), unbilledUsageMinor: z.number().int().min(0).max(1e12).optional(), refundDeposit: z.boolean().optional(),
    etcAdjust: z.object({ waive: z.boolean().optional(), percent: z.number().min(0).max(100).optional(), reason: z.string().max(300) }).optional(), ...saveFields }).parse(body);
  // Waiving or reducing the charge in a quote is the same decision as doing it, so it needs the same right.
  if (b.etcAdjust && !user.permissions.has('service:terminate')) throw forbidden('Only someone who may end a service can quote a waived or reduced charge.');
  return keep(db, user, 'TERMINATION', { ref: b.ref, date: b.date ?? null, unbilledUsageMinor: b.unbilledUsageMinor ?? 0, refundDeposit: !!b.refundDeposit, etcAdjust: b.etcAdjust ?? null },
    await core.previewTermination(db, b.ref, { date: b.date, unbilledUsageMinor: b.unbilledUsageMinor, refundDeposit: b.refundDeposit, etcAdjust: b.etcAdjust }, user.username), b);
});
post('/billing/simulate/plan-change', sim, async ({ db, user, body }) => {
  const b = z.object({ ref: z.string().min(1).max(60), newOfferId: z.string().min(1).max(80), effectiveDate: date.optional(), ...saveFields }).parse(body);
  return keep(db, user, 'PLAN_CHANGE', { ref: b.ref, newOfferId: b.newOfferId, effectiveDate: b.effectiveDate ?? null }, await core.simulatePlanChange(db, b.ref, { newOfferId: b.newOfferId, effectiveDate: b.effectiveDate }), b);
});
get('/billing/simulations', sim, ({ db, query }) => core.listSimulations(db, { kind: str(query, 'kind'), accountId: str(query, 'accountId'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/billing/simulations/:id', sim, ({ db, params }) => core.getSimulation(db, params.id!));
post('/billing/simulations/:id/delete', sim, async ({ db, user, params }) => { await core.deleteSimulation(db, user.username, params.id!); return { ok: true }; });
/** The plain "bill this date" call skips review and approval, so it is refused while governance is on (the default). */
post('/billing/run', 'billing:run', async ({ db, user, body }) => { if ((await core.getBillRunSettings(db)).enforceGovernance) throw new DomainError('REJECTED', 'Bill cycles are run from Billing → Bill runs, with a mock, a review and an approval. (A super user can switch this off in the bill-run settings.)'); const b = z.object({ asOf: date.optional(), accountId: uuid.optional() }).parse(body ?? {}); return core.runBillCycle(db, b.asOf, { accountId: b.accountId }).then(async (r) => { await core.audit(db, user.username, 'billing', r.asOf, 'BILL_RUN', { invoices: r.invoices }); return r; }); });
/** Housekeeping for the store-front: closes stale sign-ups and releases orders whose online payment never arrived. Safe to run often (hourly is plenty). */
post('/jobs/sweep-orders', 'billing:run', async ({ db, user }) => { const r = await core.sweepOrders(db, new Date(), user.username); await core.audit(db, user.username, 'order', 'sweep', 'SWEEP_ORDERS', { ...r }); return r; });
post('/jobs/expire-applications', 'billing:run', async ({ db, user }) => { const r = await core.expireApplications(db); await core.audit(db, user.username, 'store', 'expire', 'EXPIRE_APPLICATIONS', { ...r }); return r; });
post('/billing/dunning', 'billing:run', ({ db, user, body }) => core.runDunning(db, z.object({ asOf: date.optional() }).parse(body ?? {}).asOf).then(async (r) => { await core.audit(db, user.username, 'billing', r.asOf, 'DUNNING_RUN', { ...r }); return r; }));

// ───────────────────────── finance ─────────────────────────
get('/gl', 'finance:read', ({ db, query }) => core.listGl(db, { exported: query.get('exported') === null ? undefined : query.get('exported') === '1', limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/gl/reconcile', 'finance:read', ({ db }) => core.reconcile(db));
get('/gl/batches', 'finance:read', async ({ db }) => ({ items: await core.listBatches(db) }));
const csv = (body: string, name: string, extra: Record<string, string> = {}) =>
  new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store', ...extra } });
get('/gl/batches/:id/csv', 'finance:export', async ({ db, user, params }) => { await core.audit(db, user.username, 'gl', params.id!, 'BATCH_DOWNLOADED'); return csv(await core.getBatchCsv(db, params.id!), `meridian-gl-${params.id!.slice(0, 8)}.csv`); });
post('/gl/export', 'finance:export', async ({ db, user }) => {
  const { batch, csv: body } = await core.exportGl(db);
  if (!batch) return Response.json({ batch: null, message: 'nothing to export' });
  await core.audit(db, user.username, 'gl', batch.id, 'EXPORTED', { entries: batch.entryCount });
  return csv(body, `meridian-gl-${batch.id.slice(0, 8)}.csv`, { 'x-batch-id': batch.id, 'x-entry-count': String(batch.entryCount) });
});

// ───────────────────────── sub-ledger, SAP posting rules, journal batches, reconciliation ─────────────────────────
const coaRuleBody = z.object({
  name: z.string().min(1).max(120), priority: z.number().int().min(0).max(100000).optional(),
  matchAccount: z.string().max(40).nullish(), matchStream: z.string().max(40).nullish(), matchEvent: z.string().max(40).nullish(), matchSource: z.string().max(40).nullish(),
  sapAccount: z.string().min(1).max(40), costCenter: z.string().max(40).nullish(), profitCenter: z.string().max(40).nullish(), taxCode: z.string().max(20).nullish(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(), validFrom: date.nullish(), validTo: date.nullish(), note: z.string().max(500).nullish(),
});
get('/finance/meta', 'finance:read', () => ({ streams: core.REVENUE_STREAMS, eventTypes: core.LEDGER_EVENT_TYPES, formats: core.SAP_FORMATS, transports: core.SAP_TRANSPORTS, glNames: core.GL_NAMES }));
get('/finance/coa', 'finance:read', async ({ db }) => ({ items: await core.listCoaRules(db), unmapped: await core.unmappedLines(db) }));
post('/finance/coa', 'finance:configure', ({ db, user, body }) => core.createCoaRule(db, user.username, coaRuleBody.parse(body)));
post('/finance/coa/preview', 'finance:read', ({ db, body }) => core.previewCoaRule(db, z.object({ accountCode: z.string().min(1), stream: z.string().nullish(), eventType: z.string().nullish(), sourceType: z.string().optional(), entryDate: date.optional() }).parse(body)).then((resolved) => ({ resolved })));
patch('/finance/coa/:id', 'finance:configure', ({ db, user, params, body }) => core.updateCoaRule(db, user.username, params.id!, coaRuleBody.parse(body)));
route('DELETE', '/finance/coa/:id', 'finance:configure', async ({ db, user, params }) => { await core.deleteCoaRule(db, user.username, params.id!); return { ok: true }; });
get('/finance/sap-settings', 'finance:read', ({ db }) => core.getSapSettings(db));
post('/finance/sap-settings', 'finance:configure', ({ db, user, body }) => core.setSapSettings(db, user.username, z.object({
  companyCode: z.string().max(10), documentType: z.string().max(4), ledgerGroup: z.string().max(10), format: z.enum(core.SAP_FORMATS), aggregate: z.enum(['DAILY_SUMMARY', 'DETAIL']),
  transport: z.enum(core.SAP_TRANSPORTS), endpoint: z.string().max(500), autoClose: z.boolean(), realtime: z.boolean(),
}).partial().parse(body)));

/** The Kafka-style entry: one event or a batch of up to 500. A message that cannot be posted is dead-lettered and reported, never dropped. */
post('/ledger/events', 'ledger:ingest', async ({ db, user, body }) => {
  const b = z.object({ topic: z.string().max(200).optional(), events: z.array(z.unknown()).min(1).max(500) }).parse(Array.isArray(body) ? { events: body } : (body as { events?: unknown })?.events ? body : { events: [body] });
  const engine = new core.SubLedgerEngine(db);
  const results = [];
  for (const e of b.events) results.push(await engine.ingest({ topic: b.topic ?? 'meridian.finance.events', key: (e as { eventId?: string })?.eventId, value: e }, user.username));
  return { accepted: results.filter((r) => r.ok && !r.result!.duplicate).length, duplicates: results.filter((r) => r.ok && r.result!.duplicate).length, deadLettered: results.filter((r) => !r.ok).length, results };
});
get('/ledger/dead-letters', 'finance:read', async ({ db }) => ({ items: await new core.SubLedgerEngine(db).deadLetters() }));
post('/ledger/dead-letters/:id/retry', 'ledger:ingest', ({ db, user, params }) => new core.SubLedgerEngine(db).retryDeadLetter(Number(params.id), user.username));

post('/finance/batches/run', 'finance:export', async ({ db, user, body }) => {
  const b = z.object({ format: z.enum(core.SAP_FORMATS).optional(), asOf: date.optional() }).parse(body ?? {});
  const r = await core.runJournalBatch(db, { runType: 'MANUAL', actor: user.username, format: b.format, asOf: b.asOf });
  return r.batch ? { batch: r.batch, delivery: r.delivery, reconciliation: r.reconciliation } : { batch: null, message: 'nothing to export' };
});
post('/finance/close', 'finance:export', async ({ db, user, body }) => {
  const b = z.object({ asOf: date.optional() }).parse(body ?? {});
  const r = await core.runDailyClose(db, { actor: user.username, asOf: b.asOf, force: true });
  return { ran: r.ran, asOf: r.asOf, batch: r.batch, reconciliation: r.reconciliation, delivery: r.delivery };
});
get('/finance/batches', 'finance:read', async ({ db }) => ({ items: await core.listBatches(db) }));
get('/finance/batches/:id', 'finance:read', ({ db, params }) => core.getBatch(db, params.id!));
get('/finance/batches/:id/file', 'finance:export', async ({ db, user, params }) => {
  const f = await core.getBatchFile(db, params.id!);
  await core.audit(db, user.username, 'gl', params.id!, 'BATCH_DOWNLOADED');
  return new Response(f.content, { headers: { 'content-type': `${f.contentType}; charset=utf-8`, 'content-disposition': `attachment; filename="${f.fileName}"`, 'cache-control': 'no-store' } });
});
post('/finance/batches/:id/redeliver', 'finance:export', ({ db, user, params }) => core.redeliverBatch(db, params.id!, user.username));
post('/finance/batches/:id/ack', 'finance:export', ({ db, user, params, body }) => {
  const b = z.object({ reference: z.string().max(100).optional(), debitMinor: money.min(0), creditMinor: money.min(0), byAccount: z.record(z.object({ debitMinor: money, creditMinor: money })).optional() }).parse(body);
  return core.acknowledgeBatch(db, params.id!, b, user.username);
});
get('/finance/reconciliation', 'finance:read', ({ db, query }) => core.listReports(db, { status: str(query, 'status'), batchId: str(query, 'batchId'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
post('/finance/reconciliation/run', 'finance:export', ({ db, user, body }) => {
  const b = z.object({ from: date, to: date }).parse(body);
  return core.reconcilePeriod(db, { ...b, actor: user.username });
});
get('/finance/reconciliation/:id', 'finance:read', ({ db, params }) => core.getReport(db, params.id!));

// ───────────────────────── commission: plans, hierarchy, ledger, statements, payouts ─────────────────────────
const period_ = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'use YYYY-MM');
const slabBody = z.object({ from: z.number().int(), to: z.number().int().nullable().default(null), rateBps: z.number().int().optional(), fixedMinor: z.number().int().optional(), bonusMinor: z.number().int().optional() });
const planBody = z.object({ name: z.string().min(1).max(120), status: z.enum(['ACTIVE', 'INACTIVE']).optional(), holdDays: z.number().int().optional(), overrideBps: z.array(z.number().int()).max(5).optional(), note: z.string().max(500).nullish() });
const cRuleBody = z.object({
  name: z.string().min(1).max(120), priority: z.number().int().optional(), matchKinds: z.array(z.string().max(80)).max(30).optional(), matchOfferIds: z.array(z.string().max(80)).max(100).optional(),
  minTermMonths: z.number().int().nullish(), maxTermMonths: z.number().int().nullish(), matchTiers: z.array(z.string().max(40)).max(8).optional(), calc: z.enum(['PERCENT', 'FIXED']).optional(),
  rateBps: z.number().int().optional(), fixedMinor: z.number().int().optional(), slabMode: z.enum(['MARGINAL', 'RETROACTIVE']).optional(), slabs: z.array(slabBody).max(12).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});
const policyBody = z.object({ name: z.string().min(1).max(120), minTermMonths: z.number().int().nullish(), triggers: z.array(z.string().max(40)).max(5).optional(), tiers: z.array(z.object({ withinDays: z.number().int(), percentBps: z.number().int() })).max(8), includeOverrides: z.boolean().optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional() });
/** A dealer or store login sees only its own commission: the filter comes from the session, never the request. */
const commissionScope = (u: SessionUser) => ({ dealerId: u.scope.dealerId, storeId: u.scope.storeId });
const ownStatement = (u: SessionUser, st: Record<string, any>) => {
  if (u.scope.dealerId && !(st.beneficiaryKind === 'DEALER' && st.beneficiaryId === u.scope.dealerId)) throw forbidden('That statement is not yours.');
  if (u.scope.storeId && !(st.beneficiaryKind === 'STORE' && st.beneficiaryId === u.scope.storeId)) throw forbidden('That statement is not yours.');
};
get('/commission/meta', 'commission:read', () => ({ tiers: core.DEALER_TIERS, triggers: core.CLAWBACK_TRIGGERS, assignmentKinds: core.ASSIGNMENT_KINDS }));
get('/commission/ledger', 'commission:read', ({ user, db, query }) => core.listEntries(db, { ...commissionScope(user), beneficiaryId: user.scope.dealerId || user.scope.storeId ? undefined : str(query, 'beneficiaryId'), period: str(query, 'period'), status: str(query, 'status'), entryType: str(query, 'type'), orderId: str(query, 'orderId'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/commission/summary', 'commission:read', ({ user, db, query }) => core.periodSummary(db, period_.parse(str(query, 'period') ?? new Date().toISOString().slice(0, 7)), commissionScope(user)).then((items) => ({ items })));
post('/commission/ledger/approve', 'commission:settle', ({ db, user, body }) => core.approveEntries(db, user.username, z.object({ ids: z.array(z.number().int()).min(1).max(1000) }).parse(body).ids).then((approved) => ({ approved })));
get('/commission/plans', 'commission:configure', async ({ db }) => ({ items: await core.listPlans(db) }));
post('/commission/plans', 'commission:configure', ({ db, user, body }) => core.createPlan(db, user.username, planBody.parse(body)));
patch('/commission/plans/:id', 'commission:configure', ({ db, user, params, body }) => core.updatePlan(db, user.username, params.id!, planBody.parse(body)));
route('DELETE', '/commission/plans/:id', 'commission:configure', async ({ db, user, params }) => { await core.deletePlan(db, user.username, params.id!); return { ok: true }; });
post('/commission/plans/:id/rules', 'commission:configure', ({ db, user, params, body }) => core.saveCommissionRule(db, user.username, params.id!, null, cRuleBody.parse(body)));
patch('/commission/plans/:id/rules/:rid', 'commission:configure', ({ db, user, params, body }) => core.saveCommissionRule(db, user.username, params.id!, params.rid!, cRuleBody.parse(body)));
route('DELETE', '/commission/plans/:id/rules/:rid', 'commission:configure', async ({ db, user, params }) => { await core.deleteCommissionRule(db, user.username, params.id!, params.rid!); return { ok: true }; });
post('/commission/plans/:id/policies', 'commission:configure', ({ db, user, params, body }) => core.saveClawbackPolicy(db, user.username, params.id!, null, policyBody.parse(body)));
patch('/commission/plans/:id/policies/:pid', 'commission:configure', ({ db, user, params, body }) => core.saveClawbackPolicy(db, user.username, params.id!, params.pid!, policyBody.parse(body)));
route('DELETE', '/commission/plans/:id/policies/:pid', 'commission:configure', async ({ db, user, params }) => { await core.deleteClawbackPolicy(db, user.username, params.id!, params.pid!); return { ok: true }; });
post('/commission/plans/:id/assign', 'commission:configure', ({ db, user, params, body }) => { const b = z.object({ kind: z.string(), actorId: z.string() }).parse(body); return core.assignPlan(db, user.username, params.id!, b.kind, b.actorId); });
route('DELETE', '/commission/assignments/:id', 'commission:configure', async ({ db, user, params }) => { await core.unassignPlan(db, user.username, params.id!); return { ok: true }; });
post('/commission/preview', 'commission:configure', ({ db, body }) => core.previewCommission(db, z.object({ dealerId: z.string().optional(), channel: z.string().optional(), salespersonId: z.string().optional(), storeId: z.string().optional(), offerKind: z.string().min(1), offerId: z.string().optional(), termMonths: z.number().int().min(0), quantity: z.number().int().min(1).max(1000), basisMinor: money.min(0), countBefore: z.number().int().min(0).optional() }).parse(body)));
get('/commission/hierarchy', 'commission:configure', async ({ db }) => ({ items: await core.dealerTree(db) }));
patch('/commission/dealers/:id/channel', 'commission:configure', ({ db, user, params, body }) => core.setDealerChannel(db, user.username, params.id!, z.object({ tier: z.string().optional(), parentDealerId: z.string().nullish(), bankAccountName: z.string().max(120).nullish(), bankAccountNo: z.string().max(60).nullish(), bankCode: z.string().max(30).nullish(), sapVendorNo: z.string().max(30).nullish() }).parse(body)));
get('/commission/settings', 'commission:configure', ({ db }) => core.getCommissionSettings(db));
post('/commission/settings', 'commission:configure', ({ db, user, body }) => core.setCommissionSettings(db, user.username, z.object({ autoClose: z.boolean() }).parse(body)));
post('/commission/close', 'commission:settle', async ({ db, user, body }) => core.closePeriod(db, z.object({ period: period_ }).parse(body).period, user.username));
post('/commission/run', 'commission:settle', ({ db, user, body }) => core.runCommissionDaily(db, { actor: user.username, asOf: z.object({ asOf: date.optional() }).parse(body ?? {}).asOf }));
get('/commission/statements', 'commission:read', ({ db, user, query }) => core.listStatements(db, { period: str(query, 'period'), status: str(query, 'status'), dealerId: user.scope.dealerId, beneficiaryId: user.scope.storeId }).then((items) => ({ items })));
get('/commission/statements/:id', 'commission:read', async ({ db, user, params }) => { const st = await core.getStatement(db, params.id!); ownStatement(user, st); return st; });
get('/commission/statements/:id/csv', 'commission:read', async ({ db, user, params }) => { const st = await core.getStatement(db, params.id!); ownStatement(user, st); return csv(await core.statementCsv(db, params.id!), `${st.statementNo}.csv`); });
get('/commission/payouts', 'commission:settle', async ({ db }) => ({ items: await core.listPayoutBatches(db) }));
post('/commission/payouts', 'commission:settle', ({ db, user, body }) => core.createPayoutBatch(db, { period: z.object({ period: period_.optional() }).parse(body ?? {}).period, actor: user.username }));
get('/commission/payouts/:id/file', 'commission:settle', async ({ db, user, params }) => { const f = await core.getPayoutFile(db, params.id!); await core.audit(db, user.username, 'commission', params.id!, 'PAYOUT_DOWNLOADED'); return csv(f.content, f.fileName); });
post('/commission/payouts/:id/confirm', 'commission:settle', ({ db, user, params }) => core.confirmPayoutBatch(db, params.id!, user.username));

// ───────────────────────── cases / inventory ─────────────────────────
get('/cases', 'case:read', ({ db, user, query }) => core.listCases(db, { customerId: user.scope.customerId ?? str(query, 'customerId'), status: str(query, 'status'), type: str(query, 'type'), q: str(query, 'q'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
post('/cases', 'case:create', async ({ db, user, body }) => {
  const b = z.object({ customerId: uuid.optional(), serviceId: uuid.optional(), type: z.enum(core.CASE_TYPES), subject: z.string().min(1).max(200), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(), note: z.string().max(2000).optional() }).parse(body);
  const customerId = user.scope.customerId ?? b.customerId;
  if (!customerId) throw new DomainError('INVALID', 'customerId is required');
  if (user.scope.customerId && b.type === 'MNP_PORT_OUT') throw forbidden();
  return core.createCase(db, { ...b, customerId }, user.username);
});
get('/cases/:id', 'case:read', async ({ db, user, params }) => { const c = await core.getCase(db, params.id!); assertCustomer(user, c.customerId); return c; });
patch('/cases/:id', 'case:write', ({ db, user, params, body }) => core.updateCase(db, params.id!, z.object({ status: z.string().optional(), priority: z.string().optional(), note: z.string().max(2000).optional() }).parse(body), user.username));
get('/inventory', 'inventory:read', ({ db, user, query }) => core.listStock(db, { locationId: user.scope.storeId ?? str(query, 'locationId'), sku: str(query, 'sku'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/inventory/locations', 'inventory:read', async ({ db, user }) => ({ items: user.scope.storeId ? [user.scope.storeId] : await core.listStockLocations(db), warehouses: user.scope.storeId ? [] : (await core.listWarehouses(db)).filter((w) => w.status === 'ACTIVE').map((w) => ({ id: w.id, name: w.name })) }));
const ownStore = (user: SessionUser, locationId: string) => { if (user.scope.storeId && locationId !== user.scope.storeId) throw forbidden('You can only work on your own store’s stock.'); };
/** Goods receipt of one SKU. (Reducing stock is a write-off, which needs a reason and its own permission.) */
post('/inventory/adjust', 'inventory:write', async ({ db, user, body }) => {
  const b = z.object({ locationId: z.string().min(1).max(50), sku: z.string().min(1).max(50), delta: z.number().int().min(1), note: z.string().max(300).optional() }).parse(body);
  ownStore(user, b.locationId);
  return core.receiveStock(db, user.username, { locationId: b.locationId, sku: b.sku, quantity: b.delta, note: b.note });
});
post('/inventory/write-off', 'inventory:writeoff', async ({ db, user, body }) => {
  const b = z.object({ locationId: z.string().min(1).max(50), sku: z.string().min(1).max(50), quantity: z.number().int().min(1), reason: z.string().max(20), note: z.string().max(300).optional() }).parse(body);
  ownStore(user, b.locationId);
  return core.writeOffStock(db, user.username, b);
});
get('/inventory/movements', 'inventory:read', ({ db, user, query }) => core.listMovements(db, { locationId: user.scope.storeId ?? str(query, 'locationId'), sku: str(query, 'sku'), kind: str(query, 'kind'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/warehouses', 'inventory:read', async ({ db }) => ({ items: await core.listWarehouses(db) }));
post('/warehouses', 'warehouse:manage', ({ db, user, body }) => core.createWarehouse(db, user.username, z.object({ name: z.string().min(1).max(80), address: blank(z.string().max(300)) }).parse(body)));
patch('/warehouses/:id', 'warehouse:manage', ({ db, user, params, body }) => core.updateWarehouse(db, user.username, params.id!, z.object({ name: z.string().min(1).max(80), address: z.string().max(300), status: z.enum(['ACTIVE', 'INACTIVE']) }).partial().parse(body)));
route('DELETE', '/warehouses/:id', 'warehouse:manage', ({ db, user, params }) => core.deleteWarehouse(db, user.username, params.id!));

// ───────────────────────── numbers, SIMs and identities ─────────────────────────
const pool = z.object({ csv: z.string().max(4_000_000).optional(), range: z.object({ from: z.string().max(20), to: z.string().max(20) }).optional(), apply: z.boolean().default(false), batch: z.string().max(60).optional() })
  .refine((b) => !!b.csv !== !!b.range, 'give either a file or a range');
const NUM_BODY = { maxBody: 4_500_000 };
get('/numbering/summary', ['numbering:read'], ({ db }) => core.nrmSummary(db));
get('/numbering/numbers', ['numbering:read'], ({ db, query }) => core.listMsisdns(db, { state: str(query, 'state'), tier: str(query, 'tier'), q: str(query, 'q'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/numbering/sims', ['numbering:read'], ({ db, query }) => core.listSims(db, { state: str(query, 'state'), kind: str(query, 'kind') as never, locationId: str(query, 'locationId'), q: str(query, 'q'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/numbering/imsis', ['numbering:read'], ({ db, query }) => core.listImsis(db, { state: str(query, 'state'), q: str(query, 'q'), limit: num(query, 'limit'), cursor: str(query, 'cursor') }));
get('/numbering/history', ['numbering:read'], async ({ db, query }) => ({ items: await core.identifierHistory(db, z.enum(['MSISDN', 'ICCID', 'IMSI']).parse(str(query, 'type')), z.string().min(1).max(40).parse(str(query, 'id')), num(query, 'limit')) }));
get('/numbering/tiers', ['numbering:read', 'numbering:select'], async ({ db }) => ({ tiers: await core.listTierRules(db), settings: await core.getNumberingSettings(db) }));
patch('/numbering/tiers/:tier', ['numbering:manage'], ({ db, user, params, body }) => core.updateTierRule(db, user.username, params.tier!, z.object({
  label: z.string().max(40).optional(), patterns: z.array(z.object({ code: z.string().max(30), regex: z.string().max(160) })).max(20).optional(), oneTimeFeeMinor: z.number().int().optional(),
  minMonthlyPlanMinor: z.number().int().optional(), minContractMonths: z.number().int().optional(), etcMultiplierBps: z.number().int().optional(), enabled: z.boolean().optional(),
}).parse(body)));
post('/numbering/tiers/reclassify', ['numbering:manage'], ({ db, user, body }) => core.reclassifyNumbers(db, user.username, z.object({ all: z.boolean().optional() }).parse(body ?? {})));
post('/numbering/import/msisdn', ['numbering:manage'], ({ db, user, body }) => { const b = pool.parse(body); return core.importMsisdns(db, b, { apply: b.apply, actor: user.username, batch: b.batch }); }, NUM_BODY);
post('/numbering/import/imsi', ['numbering:manage'], ({ db, user, body }) => { const b = pool.parse(body); return core.importImsis(db, b, { apply: b.apply, actor: user.username, batch: b.batch }); }, NUM_BODY);
post('/numbering/import/sim', ['numbering:manage'], ({ db, user, body }) => {
  const b = z.object({ csv: z.string().min(1).max(4_000_000), apply: z.boolean().default(false), batch: z.string().max(60).optional(), kind: z.enum(['PHYSICAL', 'ESIM']).optional(), locationId: z.string().max(50).optional(), autoBindImsi: z.boolean().optional() }).parse(body);
  return core.importSims(db, { csv: b.csv }, { apply: b.apply, actor: user.username, batch: b.batch, kind: b.kind, locationId: b.locationId, autoBindImsi: b.autoBindImsi });
}, NUM_BODY);
get('/numbering/sim-template', ['numbering:manage'], async () => csv(await core.simTemplate(), 'meridian-sim-import-template.csv'));
get('/numbering/template/:kind', ['numbering:manage'], async ({ db, params }) => {
  const kind = z.enum(['msisdn', 'imsi', 'sim']).parse(params.kind);
  return csv(core.poolTemplate(kind, (await core.getRegional(db)).dialCode), `meridian-${kind}-import-template.csv`);
});
post('/numbering/sims/:iccid/transition', ['numbering:manage'], ({ db, user, params, body }) => {
  const b = z.object({ to: z.enum(core.ICCID_STATES), reason: z.string().max(200).optional(), locationId: z.string().max(50).optional() }).parse(body);
  return core.transitionSim(db, params.iccid!, b.to, { actor: user.username, reason: b.reason, locationId: b.locationId });
});
post('/numbering/auction/hold', ['numbering:manage'], ({ db, user, body }) => new core.NumberReservationService(db).holdForAuction(z.object({ msisdns: z.array(z.string().max(20)).min(1).max(1000) }).parse(body).msisdns, user.username));
post('/numbering/auction/release', ['numbering:manage'], ({ db, user, body }) => new core.NumberReservationService(db).releaseFromAuction(z.object({ msisdns: z.array(z.string().max(20)).min(1).max(1000) }).parse(body).msisdns, user.username));
post('/numbering/auction/settle', ['numbering:manage'], ({ db, user, body }) => new core.NumberReservationService(db).settleAuction(z.object({ msisdn: z.string().max(20), auctionId: z.string().min(1).max(60), winnerCustomerId: uuid, winningBidMinor: z.number().int().min(0), currency: z.string().length(3).optional() }).parse(body), user.username));
post('/numbering/recycle', ['numbering:manage'], async ({ db, user, body }) => {
  const asOf = z.object({ asOf: date.optional() }).parse(body ?? {}).asOf;
  return { recycled: await core.recycleExpired(db, asOf, user.username), expiredHolds: await new core.NumberReservationService(db).expireStale() };
});
// Choosing a number and a SIM while selling.
get('/numbers/search', ['numbering:select'], ({ db, query }) => new core.NumberReservationService(db).search({
  tier: str(query, 'tier') as never, prefix: str(query, 'prefix'), suffix: str(query, 'suffix'), contains: str(query, 'contains'), limit: num(query, 'limit'), cursor: str(query, 'cursor'),
}));
post('/numbers/reserve', ['numbering:select'], ({ db, user, body }) => new core.NumberReservationService(db).reserve(z.object({ msisdn: z.string().max(20) }).parse(body).msisdn, `checkout:${user.id}`, { actor: user.username }));
post('/numbers/release', ['numbering:select'], async ({ db, user, body }) => ({ released: await new core.NumberReservationService(db).release(z.object({ msisdn: z.string().max(20) }).parse(body).msisdn, `checkout:${user.id}`, user.username) }));
get('/sims/available', ['numbering:select'], ({ db, user, query }) => core.listSims(db, { state: 'AVAILABLE', kind: (str(query, 'kind') as never) ?? 'PHYSICAL', locationId: user.scope.storeId ?? str(query, 'locationId'), q: str(query, 'q'), limit: num(query, 'limit') ?? 20, cursor: str(query, 'cursor') }));
get('/settings/numbering', ['settings:manage'], ({ db }) => core.getNumberingSettings(db));
post('/settings/numbering', ['settings:manage'], ({ db, user, body }) => core.setNumberingSettings(db, user.username, z.object({ requireSim: z.boolean(), reservationMinutes: z.number().int(), imsiQuarantineDays: z.number().int(), auctionSettlementHours: z.number().int(), portInExpiryDays: z.number().int().default(14) }).parse(body)));

/** Bulk offers from a CSV file: a template (optionally with every current offer, to edit in bulk), a check that changes nothing, then the load (all rows or none). */
get('/catalog-import/template', 'catalog:write', async ({ db, query }) => csv(await core.offersTemplate(db, { withOffers: query.get('offers') === '1' }), query.get('offers') === '1' ? 'meridian-offers-export.csv' : 'meridian-offers-import-template.csv'));
post('/catalog-import', 'catalog:write', ({ db, user, body }) => {
  const b = z.object({ csv: z.string().min(1).max(2_000_000), apply: z.boolean().default(false) }).parse(body);
  return core.importOffers(db, b.csv, { apply: b.apply, actor: user.username });
}, { maxBody: 2_500_000 });

/** Batch stock loading from a CSV file: a template to fill in, a check that changes nothing, then the load (all rows or none). */
get('/inventory/import-template', 'inventory:write', async ({ db, user, query }) => {
  const locationId = user.scope.storeId ?? str(query, 'locationId') ?? undefined;
  return csv(await core.stockTemplate(db, { locationId, withSkus: query.get('skus') === '1' }), query.get('skus') === '1' ? 'meridian-stock-import-with-skus.csv' : 'meridian-stock-import-template.csv');
});
post('/inventory/import', 'inventory:write', ({ db, user, body }) => {
  const b = z.object({ csv: z.string().min(1).max(2_000_000), apply: z.boolean().default(false), confirmRepeat: z.boolean().optional() }).parse(body);
  return core.importStock(db, b.csv, { apply: b.apply, actor: user.username, storeId: user.scope.storeId, confirmRepeat: b.confirmRepeat });
}, { maxBody: 2_500_000 });

// ───────────────────────── dispatcher ─────────────────────────
function fail(status: number, code: string, message: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
}
const MAX_BODY = 1_000_000;

/** Scheduled offers go live on their date: any request notices a due one, at most once every 15 seconds per server. */
let lastSweep = 0;
async function sweepScheduled(db: Db) {
  if (Date.now() - lastSweep < 15_000) return;
  lastSweep = Date.now();
  try { await core.activateDueNodes(db); } catch (e) { console.error('[catalog] scheduled activation failed', (e as Error).message); }
}

export async function dispatch(req: Request, path: string[]): Promise<Response> {
  const started = Date.now();
  const url = new URL(req.url);
  const p = '/' + path.join('/');
  let userName: string | undefined;
  const done = (res: Response) => {
    res.headers.set('x-content-type-options', 'nosniff');
    if (!res.headers.has('cache-control')) res.headers.set('cache-control', 'no-store');
    if (process.env.NODE_ENV !== 'test') console.log(JSON.stringify({ t: new Date().toISOString(), msg: 'request', method: req.method, path: p, status: res.status, ms: Date.now() - started, user: userName }));
    return res;
  };

  const matches = routes.filter((r) => r.re.test(p));
  if (!matches.length) return done(fail(404, 'NOT_FOUND', 'not found'));
  const rt = matches.find((r) => r.method === req.method);
  if (!rt) return done(fail(405, 'METHOD_NOT_ALLOWED', `${req.method} not allowed`));
  const m = rt.re.exec(p)!;
  const params = Object.fromEntries(rt.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));

  try {
    // Fail closed: a misconfigured production deployment serves nothing except the liveness probe.
    if (p !== '/health') {
      const issues = core.configIssues(process.env, core.superuserProblem());
      if (issues.length) { console.error('[config] refusing to serve:', issues.join('; ')); return done(fail(503, 'MISCONFIGURED', 'The system is not configured. Contact your administrator.')); }
    }
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating && !rt.noCsrf && !rt.client && !sameOrigin(req)) return done(fail(403, 'FORBIDDEN', 'Cross-site request blocked.'));

    let raw = '';
    let body: unknown;
    if (mutating) {
      raw = await req.text();
      if (raw.length > (rt.maxBody ?? MAX_BODY)) return done(fail(413, 'TOO_LARGE', 'request body too large'));
      if (raw) { try { body = JSON.parse(raw); } catch { return done(fail(400, 'INVALID', 'request body is not valid JSON')); } }
    }
    // Liveness must not depend on the database.
    const db = p === '/health' ? (undefined as unknown as Db) : await getDb();
    if (p !== '/health') await sweepScheduled(db);
    const base = { db, params, query: url.searchParams, body, req };

    if (rt.client) {
      const client = await core.authenticateApiKey(db, req.headers.get('authorization'));
      userName = `client:${client.name}`;
      const out = await (rt.handler as (c: PublicCtx) => unknown)({ ...base, user: null, raw, client });
      return done(out instanceof Response ? out : Response.json(out ?? { ok: true }));
    }
    if (rt.public) {
      const out = await (rt.handler as (c: PublicCtx) => unknown)({ ...base, user: null, raw });
      return done(out instanceof Response ? out : Response.json(out ?? { ok: true }));
    }

    const user = await core.validateSession(db, readToken(req));
    if (!user) return done(fail(401, 'UNAUTHENTICATED', 'Sign in to continue.', { 'set-cookie': clearCookie(req) }));
    userName = user.username;
    if (user.mustChangePassword && !rt.allowMustChange) return done(fail(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your password to continue.'));
    if (rt.perm && !rt.perm.some((x) => user.permissions.has(x))) {
      await core.audit(db, user.username, 'authz', p, 'DENIED', { method: req.method, needs: rt.perm }).catch(() => {});
      return done(fail(403, 'FORBIDDEN', 'Your role does not allow this.'));
    }
    const out = await (rt.handler as Handler)({ ...base, user });
    return done(out instanceof Response ? out : Response.json(out ?? { ok: true }));
  } catch (e) {
    if (e instanceof DomainError) {
      // A validation error carries the individual reasons ("invalid offer": which rule); people need to read them, not just the headline.
      const why = Array.isArray(e.details) && e.details.every((d) => typeof d === 'string') && e.details.length ? `: ${(e.details as string[]).join('; ')}` : '';
      return done(fail(e.status, e.code, e.message + why));
    }
    if (e instanceof ZodError) return done(fail(400, 'INVALID', e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')));
    console.error(`[api] ${req.method} ${p}`, e);
    return done(fail(500, 'INTERNAL', 'unexpected server error'));
  }
}
