import * as core from '@meridian/core';
import { DomainError, type Db, type SessionUser } from '@meridian/core';
import * as fiber from '@meridian/fiber';
import { z, ZodError } from 'zod';
import { deliverLoginCode, sendable, throttleSends } from './codes';
import { clearCookie, clientIp, fail, readToken, sameOrigin, sessionCookie, tmfFail } from './http';

/**
 * Every route of the coverage service in one table. Three kinds:
 *  - public:  /health and /v1/coverage/status (is the module on);
 *  - client:  server-to-server calls with an API key holding the `fiber` scope (the CRM, the store-front, partners): qualification, port locks, the waitlist, TMF 645/673.
 *             These answer 503 MODULE_DISABLED while the module is switched off;
 *  - admin:   the Fiber Ops hub, signed in with a Meridian staff account that may manage settings (the module can be switched on from here while it is off).
 */
type Kind = 'public' | 'client' | 'admin' | 'login';
interface Ctx { db: Db; params: Record<string, string>; query: URLSearchParams; body: any; req: Request; origin: string; user: SessionUser | null; client: core.ApiClient | null }
interface Route { method: string; re: RegExp; keys: string[]; kind: Kind; handler: (c: Ctx) => unknown | Promise<unknown>; created?: boolean }
const routes: Route[] = [];
const def = (kind: Kind, method: string, p: string, handler: Route['handler'], o: { created?: boolean } = {}) => {
  const keys: string[] = [];
  const re = new RegExp('^' + p.replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, kind, handler, ...o });
};
const pub = (m: string, p: string, h: Route['handler']) => def('public', m, p, h);
const api = (m: string, p: string, h: Route['handler'], o?: { created?: boolean }) => def('client', m, p, h, o);
const admin = (m: string, p: string, h: Route['handler'], o?: { created?: boolean }) => def('admin', m, p, h, o);
const login = (m: string, p: string, h: Route['handler']) => def('login', m, p, h);

const num = (q: URLSearchParams, k: string) => (q.get(k) !== null && q.get(k) !== '' ? Number(q.get(k)) : undefined);
const str = (q: URLSearchParams, k: string) => q.get(k) || undefined;
const uuid = z.string().uuid();
const actor = (c: Ctx) => c.user?.username ?? `client:${c.client?.name ?? 'unknown'}`;

// ───────────────────────── public ─────────────────────────
pub('GET', '/health', () => ({ ok: true }));
pub('GET', '/v1/coverage/status', async ({ db }) => ({ enabled: await fiber.moduleEnabled(db) }));

// ───────────────────────── client API ─────────────────────────
const qualifyBody = z.object({
  lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), address: z.string().max(300).optional(), postalCode: z.string().max(12).optional(), country: z.string().length(2).optional(),
  street: z.string().max(150).optional(), building: z.string().max(100).optional(), unit: z.string().max(30).optional(), speedMbps: z.number().int().min(1).max(100000).optional(), refresh: z.boolean().optional(),
});
const qualify = (c: Ctx, input: z.infer<typeof qualifyBody>) => fiber.qualifyAddress(c.db, input);
api('GET', '/v1/coverage/qualify-address', ({ query, ...c }) => {
  const lat = num(query, 'lat'), lng = num(query, 'lng');
  return qualify({ query, ...c }, qualifyBody.parse({ lat, lng, address: str(query, 'address'), postalCode: str(query, 'postalCode'), country: str(query, 'country'), street: str(query, 'street'), building: str(query, 'building'), unit: str(query, 'unit'), speedMbps: num(query, 'speedMbps') }));
});
api('POST', '/v1/coverage/qualify-address', (c) => qualify(c, qualifyBody.parse(c.body)));

const reserveBody = z.object({ providerId: uuid, dpId: uuid.optional(), customerRef: z.string().max(100).optional(), speedMbps: z.number().int().min(1).optional(), lat: z.number().optional(), lng: z.number().optional(), address: z.string().max(300).optional() });
api('POST', '/v1/coverage/reservations', (c) => fiber.reservePort(c.db, { ...reserveBody.parse(c.body), actor: actor(c) }), { created: true });
api('GET', '/v1/coverage/reservations/:id', (c) => fiber.getReservation(c.db, c.params.id!));
api('POST', '/v1/coverage/reservations/:id/confirm', (c) => fiber.confirmReservation(c.db, c.params.id!, z.object({ orderRef: z.string().min(1).max(100) }).parse(c.body).orderRef, actor(c)));
api('POST', '/v1/coverage/reservations/:id/release', (c) => fiber.releaseReservation(c.db, c.params.id!, actor(c)));
api('POST', '/v1/coverage/reservations/:id/activate', (c) => fiber.activateReservation(c.db, c.params.id!, actor(c)));
api('POST', '/v1/coverage/waitlist', (c) => fiber.joinWaitlist(c.db, z.object({ providerId: uuid, dpId: uuid.optional(), customerRef: z.string().max(100).optional(), contact: z.string().max(200).optional(), lat: z.number().optional(), lng: z.number().optional(), address: z.string().max(300).optional(), speedMbps: z.number().int().optional() }).parse(c.body)), { created: true });

// TM Forum 645 (service qualification) and 673 (geographic address management)
const TQ = '/tmf-api/serviceQualificationManagement/v4/serviceQualification', TA = '/tmf-api/geographicAddressManagement/v4';
api('POST', TQ, (c) => new fiber.Tmf645Adapter(c.db, c.origin).check(c.body, actor(c)), { created: true });
api('GET', TQ, (c) => new fiber.Tmf645Adapter(c.db, c.origin).list(num(c.query, 'limit') ?? 20, num(c.query, 'offset') ?? 0));
api('GET', `${TQ}/:id`, (c) => new fiber.Tmf645Adapter(c.db, c.origin).retrieve(c.params.id!));
api('GET', `${TA}/geographicAddress`, (c) => new fiber.Tmf645Adapter(c.db, c.origin).addresses({ postcode: str(c.query, 'postcode'), streetName: str(c.query, 'streetName'), city: str(c.query, 'city'), stateOfProvince: str(c.query, 'stateOfProvince'), limit: num(c.query, 'limit') }));
api('GET', `${TA}/geographicAddress/:id`, (c) => new fiber.Tmf645Adapter(c.db, c.origin).address(c.params.id!));
api('POST', `${TA}/geographicAddressValidation`, (c) => new fiber.Tmf645Adapter(c.db, c.origin).validate(c.body), { created: true });

// ───────────────────────── admin: sign in ─────────────────────────
const answer = (req: Request, r: core.LoginResult) => new Response(JSON.stringify({ user: { username: r.user.username, displayName: r.user.displayName } }), { headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie(req, r.token, r.expiresAt), 'cache-control': 'no-store' } });
login('POST', '/admin/login', async ({ db, body, req }) => {
  const b = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(1024) }).parse(body);
  try {
    const r = await core.login(db, { ...b, ip: clientIp(req), userAgent: req.headers.get('user-agent') ?? undefined });
    if (!r.user.permissions.has('settings:manage')) { await core.logout(db, r.token); throw new DomainError('FORBIDDEN', 'Your role may not manage fibre coverage.'); }
    return answer(req, r);
  } catch (e) {
    if (e instanceof core.MfaRequired) {
      // a code by SMS or e-mail was queued with the challenge: hand it to the gateway now
      const delivery = e.challenge.sentTo ? await deliverLoginCode(db, e.challenge.token) : undefined;
      return Response.json({ mfaRequired: true, challenge: e.challenge, canSend: await sendable(db), delivery });
    }
    if (e instanceof DomainError && e.code === 'REJECTED') return fail(401, 'UNAUTHENTICATED', e.message);
    if (e instanceof core.RateLimited) return fail(429, 'RATE_LIMITED', e.message, { 'retry-after': String(e.retryAfterSeconds) });
    throw e;
  }
});
login('POST', '/admin/verify-2fa', async ({ db, body, req }) => {
  const b = z.object({ challenge: z.string().min(20).max(200), code: z.string().max(20).optional(), recoveryCode: z.string().max(30).optional() }).parse(body);
  try {
    const r = await core.verifyMfaLogin(db, { ...b, ip: clientIp(req), userAgent: req.headers.get('user-agent') ?? undefined });
    if (!r.user.permissions.has('settings:manage')) { await core.logout(db, r.token); throw new DomainError('FORBIDDEN', 'Your role may not manage fibre coverage.'); }
    return answer(req, r);
  } catch (e) { if (e instanceof DomainError && (e.code === 'REJECTED' || e.code === 'UNAUTHENTICATED')) return fail(401, 'UNAUTHENTICATED', e.message); if (e instanceof core.RateLimited) return fail(429, 'RATE_LIMITED', e.message, { 'retry-after': String(e.retryAfterSeconds) }); throw e; }
});
/** "Send me a code" / "send it another way" on the sign-in step: the same throttling as the CRM (30 s per method, 5 per sign-in, 10 per account per hour) plus a limit per address. Answers the same for a challenge that never existed and one that ran out. */
login('POST', '/admin/2fa/send-code', async ({ db, body, req }) => {
  const b = z.object({ challenge: z.string().min(20).max(200), method: z.enum(['SMS', 'EMAIL']) }).parse(body);
  try {
    await throttleSends(db, clientIp(req));
    if (!(await sendable(db))[b.method]) return fail(503, 'CODE_DELIVERY_UNAVAILABLE', `Codes by ${b.method === 'SMS' ? 'SMS' : 'e-mail'} cannot be sent from here because no ${b.method === 'SMS' ? 'SMS' : 'e-mail'} gateway is set up. Use your authenticator app or a recovery code, or ask an administrator.`);
    const r = await core.sendChallengeCode(db, b.challenge, b.method);
    return { ...r, method: b.method, delivery: await deliverLoginCode(db, b.challenge) };
  } catch (e) {
    if (e instanceof core.CodeThrottled) return fail(429, 'RATE_LIMITED', e.message, { 'retry-after': String(e.retryAfterSeconds) });
    if (e instanceof DomainError && (e.code === 'REJECTED' || e.code === 'UNAUTHENTICATED')) return fail(401, 'UNAUTHENTICATED', e.message);
    throw e;
  }
});
admin('POST', '/admin/logout', async ({ db, req }) => new Response(JSON.stringify({ ok: true }), (await core.logout(db, readToken(req)), { headers: { 'content-type': 'application/json', 'set-cookie': clearCookie(req) } })));
admin('GET', '/admin/me', ({ user }) => ({ username: user!.username, displayName: user!.displayName }));

// ───────────────────────── admin: module, settings, providers ─────────────────────────
admin('GET', '/admin/module', async ({ db }) => ({ enabled: await fiber.moduleEnabled(db), envDefault: (process.env.FEATURE_FIBER_COVERAGE_MODULE_ENABLED ?? '').trim() === '' || /^(1|true|on|yes)$/i.test(process.env.FEATURE_FIBER_COVERAGE_MODULE_ENABLED ?? '') }));
admin('PUT', '/admin/module', async (c) => ({ enabled: await fiber.setModuleEnabled(c.db, actor(c), z.object({ enabled: z.boolean() }).parse(c.body).enabled) }));
admin('GET', '/admin/settings', ({ db }) => fiber.getFiberSettings(db));
admin('PATCH', '/admin/settings', (c) => fiber.setFiberSettings(c.db, actor(c), z.object({ lockMinutes: z.number(), cacheHours: z.number(), partnerTimeoutMs: z.number(), lowPortsAbsolute: z.number(), lowPortsPercent: z.number(), adapters: z.record(z.boolean()) }).partial().parse(c.body)).catch((e) => { throw e instanceof Error && !(e instanceof DomainError) ? new DomainError('INVALID', e.message) : e; }));

const providerBody = z.object({
  code: z.string(), name: z.string(), type: z.enum(fiber.PROVIDER_TYPES), agreementId: z.string().max(80).nullish(), costPerPortMinor: z.number().int().min(0).optional(), currency: z.string().length(3).optional(), installLeadDays: z.number().int().optional(), slaResponseHours: z.number().int().optional(),
  speedTiersMbps: z.array(z.number().int()).optional(), adapterKind: z.enum(fiber.ADAPTER_KINDS).optional(), adapterUrl: z.string().max(500).nullish(), adapterConfig: z.record(z.any()).optional(), adapterEnabled: z.boolean().optional(), enabled: z.boolean().optional(), adapterSecret: z.string().max(2000).optional(),
});
admin('GET', '/admin/providers', async ({ db }) => ({ items: (await fiber.listProviders(db)).map((r) => fiber.providerView(r)) }));
admin('POST', '/admin/providers', async (c) => fiber.providerView(await fiber.saveProvider(c.db, actor(c), providerBody.parse(c.body))), { created: true });
admin('PATCH', '/admin/providers/:id', async (c) => { const r = fiber.providerView(await fiber.saveProvider(c.db, actor(c), providerBody.parse(c.body), c.params.id!)); await fiber.clearProviderCache(c.db, c.params.id!); return r; });
admin('DELETE', '/admin/providers/:id', async (c) => { await fiber.deleteProvider(c.db, actor(c), c.params.id!); return { ok: true }; });
admin('POST', '/admin/providers/:id/clear-cache', async (c) => ({ cleared: await fiber.clearProviderCache(c.db, c.params.id!) }));
/** Tries a partner's adapter against a point, so Fiber Ops can see what it returns before switching it on. */
admin('POST', '/admin/providers/:id/test', async (c) => {
  const b = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), postalCode: z.string().optional() }).parse(c.body);
  const p = await fiber.getProvider(c.db, c.params.id!);
  if (p.adapterKind === 'NONE') throw new DomainError('INVALID', 'This provider has no adapter set up.');
  const t = Date.now();
  try { return { ok: true, ms: Date.now() - t, answer: await fiber.askPartner(p, b, (await fiber.getFiberSettings(c.db)).partnerTimeoutMs) }; }
  catch (e) { return { ok: false, ms: Date.now() - t, error: (e as Error).message.slice(0, 300) }; }
});
admin('POST', '/admin/api-keys', async (c) => core.createApiClient(c.db, actor(c), { name: z.object({ name: z.string().min(1).max(60) }).parse(c.body).name, scopes: ['fiber'], channel: 'PARTNER_PORTAL' }), { created: true });
admin('GET', '/admin/api-keys', async ({ db }) => ({ items: (await core.listApiClients(db)).filter((k) => (k.scopes as string[]).includes('fiber')) }));
admin('DELETE', '/admin/api-keys/:id', async (c) => { await core.revokeApiClient(c.db, actor(c), c.params.id!); return { ok: true }; });

// ───────────────────────── admin: network ─────────────────────────
const cabinetBody = z.object({ providerId: uuid, code: z.string(), name: z.string(), lat: z.number(), lng: z.number(), state: z.string().optional(), city: z.string().optional(), postalCode: z.string().optional(), status: z.string().optional() });
admin('GET', '/admin/cabinets', async (c) => ({ items: await fiber.listCabinets(c.db, str(c.query, 'providerId')) }));
admin('POST', '/admin/cabinets', (c) => fiber.saveCabinet(c.db, actor(c), cabinetBody.parse(c.body)), { created: true });
admin('PATCH', '/admin/cabinets/:id', (c) => fiber.saveCabinet(c.db, actor(c), cabinetBody.parse(c.body), c.params.id!));
const dpBody = z.object({ providerId: uuid, cabinetId: uuid.nullish(), code: z.string(), name: z.string(), kind: z.enum(['FDP', 'DP']).optional(), lat: z.number(), lng: z.number(), splitterRatio: z.number().int().optional(), radiusM: z.number().int().optional(), address: z.string().optional(), state: z.string().optional(), city: z.string().optional(), postalCode: z.string().optional(), status: z.string().optional(), usedPorts: z.number().int().optional(), faultyPorts: z.number().int().optional() });
admin('GET', '/admin/dps', async (c) => ({ items: await fiber.listDps(c.db, { providerId: str(c.query, 'providerId'), limit: num(c.query, 'limit') }) }));
admin('POST', '/admin/dps', (c) => fiber.saveDp(c.db, actor(c), dpBody.parse(c.body)), { created: true });
admin('PATCH', '/admin/dps/:id', (c) => fiber.saveDp(c.db, actor(c), dpBody.parse(c.body), c.params.id!));
admin('GET', '/admin/dps/:id/ports', async (c) => ({ dp: await fiber.getDp(c.db, c.params.id!), items: await fiber.listPorts(c.db, c.params.id!) }));
admin('POST', '/admin/ports/:id/state', (c) => { const b = z.object({ state: z.enum(['AVAILABLE', 'FAULTY']), note: z.string().max(200).optional() }).parse(c.body); return fiber.setPortState(c.db, actor(c), c.params.id!, b.state, b.note); });
admin('GET', '/admin/polygons', async (c) => ({ items: await fiber.listPolygons(c.db, str(c.query, 'providerId')) }));
admin('POST', '/admin/polygons', (c) => fiber.savePolygon(c.db, actor(c), (({ geometry, ...r }) => ({ ...r, geometry: geometry as fiber.AreaGeometry }))(z.object({ providerId: uuid, name: z.string(), kind: z.string().optional(), geometry: z.object({ type: z.enum(['Polygon', 'MultiPolygon']), coordinates: z.any() }), dpId: uuid.nullish(), speedTiersMbps: z.array(z.number().int()).nullish(), capacityStatus: z.enum(['AVAILABLE', 'EXHAUSTED']).optional() }).parse(c.body))), { created: true });
admin('DELETE', '/admin/polygons/:id', async (c) => { await fiber.deletePolygon(c.db, actor(c), c.params.id!); return { ok: true }; });
admin('GET', '/admin/map', (c) => fiber.mapFeatures(c.db, { providerId: str(c.query, 'providerId') }));

// ───────────────────────── admin: import, capacity, tools ─────────────────────────
admin('POST', '/admin/import', (c) => fiber.importCoverage(c.db, { ...z.object({ format: z.enum(['CSV', 'GEOJSON', 'KML']), text: z.string(), provider: z.string().optional(), apply: z.boolean() }).parse(c.body), actor: actor(c) }));
admin('GET', '/admin/import/jobs', async ({ db }) => ({ items: await fiber.listImportJobs(db) }));
admin('GET', '/admin/import/templates', () => fiber.IMPORT_TEMPLATES);
admin('GET', '/admin/capacity', async (c) => fiber.exhaustionReport(c.db, { level: str(c.query, 'level') as fiber.PortLevel | undefined, providerId: str(c.query, 'providerId') }));
admin('GET', '/admin/waitlist', async (c) => ({ items: await fiber.listWaitlist(c.db, { dpId: str(c.query, 'dpId'), status: str(c.query, 'status') }) }));
admin('POST', '/admin/waitlist/:id/cancel', async (c) => { await fiber.cancelWaitlist(c.db, c.params.id!); return { ok: true }; });
admin('POST', '/admin/dps/:id/notify', (c) => fiber.notifyWaitlist(c.db, c.params.id!, actor(c)));
admin('POST', '/admin/dps/:id/expansion', (c) => fiber.requestExpansion(c.db, actor(c), c.params.id!, z.object({ note: z.string().max(500).optional() }).parse(c.body ?? {}).note), { created: true });
admin('GET', '/admin/expansions', async ({ db }) => ({ items: await fiber.listExpansions(db) }));
admin('PATCH', '/admin/expansions/:id', (c) => { const b = z.object({ status: z.enum(['IN_PROGRESS', 'DONE', 'REJECTED']), note: z.string().max(500).optional() }).parse(c.body); return fiber.updateExpansion(c.db, actor(c), c.params.id!, b.status, b.note); });
admin('GET', '/admin/reservations', async (c) => ({ items: await fiber.listReservations(c.db, { state: str(c.query, 'state') }) }));
admin('POST', '/admin/sweep', async ({ db }) => ({ ...(await fiber.sweepExpiredLocks(db)), pruned: await fiber.pruneCache(db) }));
admin('POST', '/admin/check', (c) => qualify(c, qualifyBody.parse(c.body)));

// ───────────────────────── dispatch ─────────────────────────
const MAX_BODY = 22_000_000;   // an import file may be 20 MB of text
export async function dispatch(req: Request, path: string[]): Promise<Response> {
  const p = '/' + path.join('/');
  const tmf = p.startsWith('/tmf-api');
  const err = (status: number, code: string, message: string, headers?: Record<string, string>) => (tmf ? tmfFail(status, code, message) : fail(status, code, message, headers));
  const done = (res: Response) => { res.headers.set('x-content-type-options', 'nosniff'); if (!res.headers.has('cache-control')) res.headers.set('cache-control', 'no-store'); return res; };
  const matches = routes.filter((r) => r.re.test(p));
  if (!matches.length) return done(err(404, 'NOT_FOUND', 'not found'));
  const rt = matches.find((r) => r.method === req.method);
  if (!rt) return done(err(405, 'METHOD_NOT_ALLOWED', `${req.method} not allowed`));
  const m = rt.re.exec(p)!;
  const params = Object.fromEntries(rt.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
  const url = new URL(req.url);
  const origin = `${req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')}://${req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host}`;
  try {
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating && (rt.kind === 'admin' || rt.kind === 'login') && !sameOrigin(req)) return done(err(403, 'FORBIDDEN', 'Cross-site request blocked.'));
    let body: unknown;
    if (mutating) {
      const raw = await req.text();
      if (raw.length > MAX_BODY) return done(err(413, 'TOO_LARGE', 'request body too large'));
      if (raw) { try { body = JSON.parse(raw); } catch { return done(err(400, 'INVALID', 'request body is not valid JSON')); } }
    }
    if (p === '/health') return done(Response.json({ ok: true }));
    const db = await core.getDb();
    const base = { db, params, query: url.searchParams, body, req, origin, user: null as SessionUser | null, client: null as core.ApiClient | null };
    const out = async (c: Ctx) => { const r = await rt.handler(c); return r instanceof Response ? r : Response.json(r ?? { ok: true }, { status: rt.created ? 201 : 200 }); };

    if (rt.kind === 'client') {
      const client = await core.authenticateApiKey(db, req.headers.get('authorization'), 'fiber');
      if (!(await fiber.moduleEnabled(db))) return done(err(503, 'MODULE_DISABLED', 'Fibre coverage is switched off.'));
      return done(await out({ ...base, client }));
    }
    if (rt.kind === 'admin') {
      const user = await core.validateSession(db, readToken(req));
      if (!user) return done(err(401, 'UNAUTHENTICATED', 'Sign in to continue.', { 'set-cookie': clearCookie(req) }));
      if (!user.permissions.has('settings:manage')) return done(err(403, 'FORBIDDEN', 'Your role does not allow this.'));
      return done(await out({ ...base, user }));
    }
    return done(await out(base));
  } catch (e) {
    if (e instanceof DomainError) return done(err(e.status, e.code, e.message));
    if (e instanceof ZodError) return done(err(400, 'INVALID', e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')));
    console.error('[fiber-coverage]', (e as Error).stack ?? e);
    return done(err(500, 'INTERNAL', 'Something went wrong.'));
  }
}
