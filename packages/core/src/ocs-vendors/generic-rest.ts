import { invalid } from '../errors.js';
import { OCS_COMMANDS, OCS_COMMAND_LABEL, type OcsCommandName, type OcsConnector, type OcsRequest, type OcsResult, type OcsVendor } from './types.js';

/**
 * A connector for any charging system that offers a REST/JSON interface, configured instead of coded: for each command the operator says which HTTP call to
 * make and what the JSON body looks like, using `{{placeholders}}` for the subscriber and plan. A vendor whose API does not fit this (SOAP, Diameter,
 * several calls per command) gets its own connector file next to this one; nothing else changes.
 *
 * Safe by construction: values are inserted into the parsed JSON tree, never glued into text, so a value cannot break the JSON or add fields; the token
 * comes from a MERIDIAN_OCS_* environment variable, never from the database; https only (plain http only to localhost outside production).
 */
export const TEMPLATE_VARS = [
  'command', 'idempotencyKey', 'serviceId', 'identifier', 'msisdn', 'serviceType', 'serviceKind', 'iccid', 'imsi', 'customerId', 'accountId', 'segment', 'marketCode', 'creditLimitMinor',
  'offerId', 'offerName', 'planCode', 'planParams', 'previousPlanCode', 'expiresAt', 'barLevel', 'barReason', 'oldIdentifier', 'newIdentifier', 'oldIccid', 'newIccid', 'reason', 'ported',
] as const;
type Var = (typeof TEMPLATE_VARS)[number];
type Vars = Partial<Record<Var, unknown>>;

export function varsOf(r: OcsRequest): Vars {
  const s = r.subscriber;
  return {
    command: r.command, idempotencyKey: r.idempotencyKey, serviceId: s.serviceId, identifier: s.identifier, msisdn: s.serviceType === 'MOBILE' ? s.identifier : null, serviceType: s.serviceType,
    serviceKind: s.serviceKind, iccid: s.iccid, imsi: s.imsi, customerId: s.customerId, accountId: s.accountId, segment: s.segment, marketCode: s.marketCode, creditLimitMinor: s.creditLimitMinor,
    offerId: r.plan?.offerId ?? null, offerName: r.plan?.offerName ?? null, planCode: r.plan?.planCode ?? null, planParams: r.plan?.params ?? {}, previousPlanCode: r.previousPlan?.planCode ?? null,
    expiresAt: r.expiresAt ?? null, barLevel: r.barring?.level ?? null, barReason: r.barring?.reason ?? null,
    oldIdentifier: r.identity?.from.identifier ?? null, newIdentifier: r.identity?.to.identifier ?? null, oldIccid: r.identity?.from.iccid ?? null, newIccid: r.identity?.to.iccid ?? null,
    reason: r.termination?.reason ?? null, ported: r.termination?.ported ?? null,
  };
}

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
const WHOLE = /^\{\{\s*(\w+)\s*\}\}$/;
const known = new Set<string>(TEMPLATE_VARS);
const unknownIn = (text: string) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((n) => !known.has(n));
const walkStrings = (v: unknown, f: (s: string) => void): void => { if (typeof v === 'string') f(v); else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, f)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => walkStrings(x, f)); };

/** Fills a parsed JSON template. A string that is exactly one placeholder takes the value's own type (a number stays a number, null stays null). */
export function render(t: unknown, vars: Vars): unknown {
  if (typeof t === 'string') {
    const whole = WHOLE.exec(t);
    if (whole) return vars[whole[1] as Var] ?? null;
    return t.replace(PLACEHOLDER, (_, n: string) => { const v = vars[n as Var]; return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); });
  }
  if (Array.isArray(t)) return t.map((x) => render(x, vars));
  if (t && typeof t === 'object') return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, render(v, vars)]));
  return t;
}
const renderPath = (p: string, vars: Vars) => p.replace(PLACEHOLDER, (_, n: string) => encodeURIComponent(String(vars[n as Var] ?? '')));

const METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'GET'] as const;
type Method = (typeof METHODS)[number];
export interface CommandSpec { method: Method; path: string; body: string }
export interface GenericRestConfig {
  baseUrl: string; auth: 'NONE' | 'BEARER' | 'HEADER'; tokenEnv: string; headerName: string; timeoutMs: number; testPath: string; referencePath: string; conflictIsSuccess: boolean;
  commands: Partial<Record<OcsCommandName, CommandSpec>>;
}

const EXAMPLE: Record<OcsCommandName, CommandSpec> = {
  PROVISION: { method: 'POST', path: '/subscribers', body: '{\n  "msisdn": "{{msisdn}}",\n  "imsi": "{{imsi}}",\n  "externalId": "{{serviceId}}",\n  "plan": "{{planCode}}",\n  "planParams": "{{planParams}}",\n  "creditLimit": "{{creditLimitMinor}}",\n  "expiresAt": "{{expiresAt}}"\n}' },
  CHANGE_PLAN: { method: 'PUT', path: '/subscribers/{{serviceId}}/plan', body: '{ "plan": "{{planCode}}", "planParams": "{{planParams}}" }' },
  SET_BARRING: { method: 'PUT', path: '/subscribers/{{serviceId}}/barring', body: '{ "level": "{{barLevel}}", "reason": "{{barReason}}" }' },
  CHANGE_IDENTITY: { method: 'PUT', path: '/subscribers/{{serviceId}}/identity', body: '{ "msisdn": "{{newIdentifier}}", "iccid": "{{newIccid}}" }' },
  TERMINATE: { method: 'DELETE', path: '/subscribers/{{serviceId}}', body: '' },
};
export const GENERIC_REST_EXAMPLE = EXAMPLE;

const envName = (v: unknown, what: string): string => {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t && !/^MERIDIAN_OCS_[A-Z0-9_]{1,40}$/.test(t)) throw invalid(`${what} is the name of an environment variable that starts with MERIDIAN_OCS_, for example MERIDIAN_OCS_TOKEN. The secret itself is never entered here.`);
  return t;
};

function parseBody(command: string, text: string): unknown {
  if (!text.trim()) return undefined;
  let tree: unknown;
  try { tree = JSON.parse(text); } catch { throw invalid(`${command}: the request body is not valid JSON.`); }
  return tree;
}

export function validateGenericRest(raw: unknown): GenericRestConfig {
  const r = (raw ?? {}) as Record<string, any>;
  const baseUrl = String(r.baseUrl ?? '').trim().replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw invalid('The base address must be a full web address, for example https://ocs.example.com/api.'); }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && process.env.NODE_ENV !== 'production')) throw invalid('The base address must start with https://.');
  if (u.username || u.password) throw invalid('Do not put a user name or password in the address; use the token setting.');
  const auth = (r.auth ?? 'NONE') as GenericRestConfig['auth'];
  if (!['NONE', 'BEARER', 'HEADER'].includes(auth)) throw invalid('Authentication is none, bearer token or a header.');
  const tokenEnv = envName(r.tokenEnv, 'The token setting');
  if (auth !== 'NONE' && !tokenEnv) throw invalid('Say which environment variable holds the token (it starts with MERIDIAN_OCS_).');
  const headerName = String(r.headerName ?? '').trim();
  if (auth === 'HEADER' && !/^[A-Za-z][A-Za-z0-9-]{0,40}$/.test(headerName)) throw invalid('Name the header that carries the token, for example X-Api-Key.');
  const timeoutMs = Number(r.timeoutMs ?? 10_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) throw invalid('The time limit is 1 to 30 seconds.');
  const testPath = String(r.testPath ?? '').trim();
  if (testPath && !testPath.startsWith('/')) throw invalid('The test path starts with /.');
  const referencePath = String(r.referencePath ?? '').trim();
  if (referencePath && !/^(\/[A-Za-z0-9_-]+)+$/.test(referencePath)) throw invalid('The reference location looks like /subscriber/id: slash-separated names from the answer.');
  const commands: GenericRestConfig['commands'] = {};
  for (const c of OCS_COMMANDS) {
    const s = r.commands?.[c] as Partial<CommandSpec> | undefined;
    if (!s || !String(s.path ?? '').trim()) continue;
    const method = String(s.method ?? 'POST').toUpperCase() as Method;
    if (!METHODS.includes(method)) throw invalid(`${c}: the method is POST, PUT, PATCH, DELETE or GET.`);
    const path = String(s.path).trim();
    if (!path.startsWith('/')) throw invalid(`${c}: the path starts with /.`);
    const body = String(s.body ?? '');
    const bad = [...unknownIn(path), ...(() => { const out: string[] = []; walkStrings(parseBody(c, body), (t) => out.push(...unknownIn(t))); return out; })()];
    if (bad.length) throw invalid(`${c}: unknown placeholder {{${[...new Set(bad)][0]}}}. Available: ${TEMPLATE_VARS.join(', ')}.`);
    if ((method === 'GET' || method === 'DELETE') && body.trim()) throw invalid(`${c}: a ${method} call has no body.`);
    commands[c] = { method, path, body };
  }
  if (!commands.PROVISION) throw invalid('At least PROVISION must be defined: it is how a new subscriber gets its plan.');
  return { baseUrl, auth, tokenEnv, headerName, timeoutMs, testPath, referencePath, conflictIsSuccess: r.conflictIsSuccess !== false, commands };
}

const pointer = (json: unknown, path: string): string | undefined => {
  let cur: any = json;
  for (const k of path.split('/').filter(Boolean)) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[k]; }
  return cur == null || typeof cur === 'object' ? undefined : String(cur);
};

export function createGenericRestConnector(config: GenericRestConfig, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): OcsConnector {
  const headers = (extra: Record<string, string> = {}): Record<string, string> => {
    const h: Record<string, string> = { accept: 'application/json', ...extra };
    const token = config.tokenEnv ? env[config.tokenEnv] : undefined;
    if (config.auth === 'BEARER' && token) h.authorization = `Bearer ${token}`;
    if (config.auth === 'HEADER' && token) h[config.headerName] = token;
    return h;
  };
  const call = async (method: string, path: string, body?: unknown, idem?: string): Promise<{ status: number; text: string; json: unknown }> => {
    const res = await fetchImpl(config.baseUrl + path, {
      method, signal: AbortSignal.timeout(config.timeoutMs), redirect: 'error',
      headers: headers({ ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text().catch(() => '');
    let json: unknown; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text, json };
  };
  return {
    vendor: 'generic-rest',
    problem: () => (config.auth !== 'NONE' && !(env[config.tokenEnv] ?? '').trim() ? `${config.tokenEnv} is not set on the server.` : null),
    async handle(req): Promise<OcsResult> {
      const spec = config.commands[req.command];
      if (!spec) return { ok: true, skipped: true, detail: `${OCS_COMMAND_LABEL[req.command]}: not defined for this OCS, so nothing was sent.` };
      const vars = varsOf(req);
      const body = spec.body.trim() ? render(JSON.parse(spec.body), vars) : undefined;
      try {
        const r = await call(spec.method, renderPath(spec.path, vars), body, req.idempotencyKey);
        if (r.status >= 200 && r.status < 300) return { ok: true, reference: config.referencePath ? pointer(r.json, config.referencePath) : undefined, detail: `${spec.method} ${renderPath(spec.path, vars)} answered ${r.status}` };
        if (r.status === 409 && config.conflictIsSuccess) return { ok: true, detail: 'The OCS says it already has this (409); treated as done.' };
        return { ok: false, retryable: r.status === 408 || r.status === 425 || r.status === 429 || r.status >= 500, detail: `The OCS answered ${r.status}: ${r.text.replace(/\s+/g, ' ').slice(0, 200)}` };
      } catch (e) {
        return { ok: false, retryable: true, detail: `Could not reach the OCS: ${(e as Error).message}` };
      }
    },
    async test() {
      if (!config.testPath) return { ok: true, detail: 'Saved. No test address is set, so the connection was not checked.' };
      try { const r = await call('GET', config.testPath); return { ok: r.status < 400, detail: `${config.testPath} answered ${r.status}.` }; }
      catch (e) { return { ok: false, detail: `Could not reach the OCS: ${(e as Error).message}` }; }
    },
  };
}

export const genericRestVendor: OcsVendor = {
  id: 'generic-rest',
  label: 'Generic REST / JSON',
  summary: 'For a charging system with a REST interface: you define the call for each command and the JSON it takes, with placeholders for the subscriber and plan. No code.',
  notes: [
    'Put the token in a server environment variable that starts with MERIDIAN_OCS_ and name it here. The secret is never stored in the database.',
    'A command you leave blank is skipped and recorded as skipped. PROVISION is required.',
    'A vendor that needs several calls for one command, SOAP or Diameter gets its own connector file instead.',
  ],
  real: true,
  fields: [
    { key: 'baseUrl', label: 'Base address', kind: 'url', required: true, placeholder: 'https://ocs.example.com/api/v1' },
    { key: 'auth', label: 'Authentication', kind: 'select', options: [{ value: 'NONE', label: 'None' }, { value: 'BEARER', label: 'Bearer token' }, { value: 'HEADER', label: 'A header with the token' }] },
    { key: 'tokenEnv', label: 'Token (environment variable)', kind: 'env', hint: 'Name of the server environment variable holding the token, for example MERIDIAN_OCS_TOKEN.' },
    { key: 'headerName', label: 'Header name', kind: 'text', placeholder: 'X-Api-Key', hint: 'Only for “A header with the token”.' },
    { key: 'timeoutMs', label: 'Time limit (ms)', kind: 'number', min: 1000, max: 30_000 },
    { key: 'referencePath', label: 'Where the OCS’s own subscriber id is in the answer', kind: 'text', placeholder: '/subscriber/id', hint: 'Optional. Kept on the job so you can find the subscriber in the OCS.' },
    { key: 'testPath', label: 'Test address', kind: 'text', placeholder: '/health', hint: 'Optional. A GET the Test button calls.' },
    { key: 'commands', label: 'Commands', kind: 'commands' },
  ],
  defaults: () => ({ baseUrl: '', auth: 'BEARER', tokenEnv: 'MERIDIAN_OCS_TOKEN', headerName: '', timeoutMs: 10_000, testPath: '', referencePath: '', conflictIsSuccess: true, commands: EXAMPLE }),
  validate: (raw) => validateGenericRest(raw) as unknown as Record<string, unknown>,
  create: (config, env, fetchImpl) => createGenericRestConnector(config as unknown as GenericRestConfig, env, fetchImpl),
};
