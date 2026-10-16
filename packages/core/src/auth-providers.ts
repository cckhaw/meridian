import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import { audit } from './audit.js';
import type { Db, Queryable, Row } from './db.js';
import { invalid, rejected } from './errors.js';
import { hubEndpointWithSecret, type HubEndpoint } from './integration-hub.js';
import { decryptText } from './field-crypto.js';
import { hashPassword } from './passwords.js';
import { getRoleOverrides } from './roles-config.js';
import { missingBinding, roleDef, roleIdOfCode, type RoleId } from './rbac.js';
import { effectiveMarket } from './settings.js';
import { openFederatedSession, revokeUserSessions, type LoginResult } from './auth.js';

/**
 * Sign-in integrations: single sign-on with OpenID Connect, the company directory (LDAP / Active Directory) and the SMS/WhatsApp gateway for one-time codes.
 * Their settings live in the Integration hub's `auth` group (secrets encrypted). Everything that talks to the outside goes through `authHttp` / `DirectoryClient`
 * so tests (and a different directory library) can stand in for it.
 */
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let httpImpl: Fetch = (url, init) => fetch(url, init);
export const setAuthHttp = (f: Fetch | null) => { httpImpl = f ?? ((url, init) => fetch(url, init)); };
const http = (url: string, init: RequestInit = {}, timeoutMs = 10_000) => httpImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const b64u = (b: Buffer) => b.toString('base64url');

// ───────────────────────── who gets which role ─────────────────────────
/** Role ids for the groups a person belongs to, through the administrator's mappings (group → role code or role id). Unknown roles are ignored, never guessed. */
export async function rolesForGroups(q: Queryable, groups: string[], mappings: Record<string, string> | undefined, fallback?: string): Promise<RoleId[]> {
  const book = await getRoleOverrides(q);
  const lower = new Map(Object.entries(mappings ?? {}).map(([g, r]) => [g.trim().toLowerCase(), r]));
  const wanted = new Set<string>();
  for (const g of groups) { const r = lower.get(g.trim().toLowerCase()); if (r) wanted.add(r); }
  if (!wanted.size && fallback) wanted.add(fallback);
  const out: RoleId[] = [];
  for (const ref of wanted) {
    const id = roleIdOfCode(ref) ?? ref;
    const d = roleDef(id, book);
    if (d && d.id !== 'admin' && !book.disabled?.includes(id)) out.push(id);   // directory groups never grant the Administrator role
  }
  return [...new Set(out)];
}

// ───────────────────────── OpenID Connect ─────────────────────────
interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
async function discover(ep: HubEndpoint): Promise<Discovery> {
  const issuer = ep.url!.replace(/\/+$/, '');
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 600_000) return hit.doc;
  const r = await http(`${issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } }, ep.timeoutMs);
  if (!r.ok) throw rejected('The sign-in provider could not be reached. Try again, or ask an administrator.');
  const doc = (await r.json()) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri || doc.issuer?.replace(/\/+$/, '') !== issuer) throw rejected('The sign-in provider answered with settings that do not match what was configured.');
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

/** The buttons for the sign-in page: the enabled single sign-on providers, with nothing else about them. */
export async function listSignInProviders(q: Queryable): Promise<Array<{ id: string; label: string; vendor: string }>> {
  const rows = (await q.query(`SELECT id, name, config FROM integration_endpoints WHERE group_key='auth' AND kind='IDP_OIDC' AND enabled ORDER BY name`)).rows;
  return rows.map((r) => ({ id: r.id, label: (r.config?.buttonLabel as string) || `Sign in with ${r.name}`, vendor: (r.config?.vendor as string) ?? 'OTHER' }));
}
async function oidcEndpoint(q: Queryable, id: string) {
  const r = (await q.query(`SELECT * FROM integration_endpoints WHERE id=$1 AND group_key='auth' AND kind='IDP_OIDC' AND enabled`, [id])).rows[0];
  if (!r) throw rejected('That sign-in option is not available.');
  const ep = { id: r.id, group: 'auth', kind: r.kind, name: r.name, url: r.url, fallbackUrl: r.fallbackUrl, timeoutMs: r.timeoutMs, config: r.config ?? {}, hasSecret: !!r.secretEnc, enabled: r.enabled, updatedBy: r.updatedBy, updatedAt: r.updatedAt } as unknown as HubEndpoint;
  return { ep, secret: r.secretEnc ? decryptText(r.secretEnc) : null };
}

/** Step one: where to send the browser. State, nonce and the PKCE verifier are kept server-side and used once. */
export async function oidcBegin(db: Db, endpointId: string): Promise<{ url: string }> {
  const { ep } = await oidcEndpoint(db, endpointId);
  const d = await discover(ep);
  const state = b64u(randomBytes(24)), nonce = b64u(randomBytes(24)), verifier = b64u(randomBytes(48));
  const redirectUri = String(ep.config.redirectUri);
  await db.query(`DELETE FROM sso_states WHERE expires_at < now()`);
  await db.query(`INSERT INTO sso_states (state, endpoint_id, nonce, verifier, redirect_uri, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '10 minutes')`, [sha(state), endpointId, nonce, verifier, redirectUri]);
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({ response_type: 'code', client_id: String(ep.config.clientId), redirect_uri: redirectUri, scope: String(ep.config.scopes || 'openid profile email'), state, nonce, code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' }).toString();
  return { url: u.toString() };
}

type Claims = Record<string, unknown>;
/** Checks an id_token's signature (RS256 or ES256 against the provider's published keys) and its claims. Anything else is refused, including `alg: none`. */
export async function verifyIdToken(token: string, o: { jwks: { keys: JsonWebKey[] }; issuer: string; clientId: string; nonce: string; now?: number }): Promise<Claims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw rejected('The sign-in response was not valid.');
  const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as { alg?: string; kid?: string };
  const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as Claims;
  if (header.alg !== 'RS256' && header.alg !== 'ES256') throw rejected('The sign-in response was signed in a way Meridian does not accept.');
  const keys = o.jwks.keys.filter((k: any) => (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig') && k.kty === (header.alg === 'RS256' ? 'RSA' : 'EC'));
  if (!keys.length) throw rejected('The sign-in response was signed with a key the provider does not publish.');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`), sig = Buffer.from(parts[2]!, 'base64url');
  const ok = keys.some((k) => {
    try { const key = createPublicKey({ key: k as JsonWebKey, format: 'jwk' }); return header.alg === 'RS256' ? cryptoVerify('RSA-SHA256', data, key, sig) : cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig); } catch { return false; }
  });
  if (!ok) throw rejected('The sign-in response could not be verified.');
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  const aud = Array.isArray(claims.aud) ? (claims.aud as string[]) : [claims.aud as string];
  if (String(claims.iss ?? '').replace(/\/+$/, '') !== o.issuer.replace(/\/+$/, '')) throw rejected('The sign-in response came from a different provider.');
  if (!aud.includes(o.clientId)) throw rejected('The sign-in response was meant for a different application.');
  if (aud.length > 1 && claims.azp !== o.clientId) throw rejected('The sign-in response was meant for a different application.');
  if (typeof claims.exp !== 'number' || claims.exp + 60 < now) throw rejected('The sign-in has expired. Please try again.');
  if (typeof claims.iat === 'number' && claims.iat - 300 > now) throw rejected('The sign-in response is dated in the future.');
  if (claims.nonce !== o.nonce) throw rejected('The sign-in response did not match this attempt.');
  if (!claims.sub) throw rejected('The sign-in response did not say who you are.');
  return claims;
}

const sanitiseUsername = (s: string) => s.toLowerCase().split('@')[0]!.replace(/[^a-z0-9._-]/g, '.').replace(/^[^a-z0-9]+/, '').slice(0, 45);
const claimText = (c: Claims, name: unknown) => { const v = name ? c[String(name)] : undefined; return typeof v === 'string' && v.trim() ? v.trim() : null; };
const claimList = (c: Claims, name: unknown): string[] => { const v = name ? c[String(name)] : undefined; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []; };

/** Step two: the provider sent the browser back with a code. Trades it for the person's identity and opens a session. */
export async function oidcFinish(db: Db, i: { state: string; code: string; ip?: string; userAgent?: string }): Promise<LoginResult> {
  const st = (await db.query(`DELETE FROM sso_states WHERE state=$1 RETURNING *`, [sha(i.state)])).rows[0];
  if (!st || new Date(st.expiresAt) < new Date()) throw rejected('This sign-in link has expired. Please start again.');
  const { ep, secret } = await oidcEndpoint(db, st.endpointId);
  const d = await discover(ep);
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: i.code, redirect_uri: st.redirectUri, client_id: String(ep.config.clientId), code_verifier: st.verifier });
  if (secret) form.set('client_secret', secret);
  const tr = await http(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form }, ep.timeoutMs);
  if (!tr.ok) { await audit(db, 'sso', 'auth', ep.id, 'SSO_TOKEN_REFUSED', { status: tr.status, ip: i.ip }); throw rejected('The sign-in provider did not accept the sign-in. Please try again.'); }
  const tok = (await tr.json()) as { id_token?: string };
  if (!tok.id_token) throw rejected('The sign-in provider did not send your identity.');
  const jr = await http(d.jwks_uri, { headers: { accept: 'application/json' } }, ep.timeoutMs);
  if (!jr.ok) throw rejected('The sign-in provider’s keys could not be read.');
  const claims = await verifyIdToken(tok.id_token, { jwks: (await jr.json()) as { keys: JsonWebKey[] }, issuer: ep.url!, clientId: String(ep.config.clientId), nonce: st.nonce });
  const userId = await userForClaims(db, ep, claims, i.ip);
  return openFederatedSession(db, userId, `oidc:${ep.name}`, { ip: i.ip, userAgent: i.userAgent });
}

async function userForClaims(db: Db, ep: HubEndpoint, claims: Claims, ip?: string): Promise<string> {
  const c = ep.config;
  const sub = String(claims.sub);
  const roles = await rolesForGroups(db, claimList(claims, c.groupsClaim ?? 'groups'), c.roleMappings as Record<string, string> | undefined, c.defaultRole as string | undefined);
  const email = claimText(claims, 'email');
  const uname = claimText(claims, c.usernameClaim ?? 'email') ?? claimText(claims, 'preferred_username') ?? sub;
  const display = claimText(claims, c.nameClaim ?? 'name') ?? uname;
  return db.tx(async (q) => {
    const book = await getRoleOverrides(q);
    const bind = { storeId: (c.storeId as string) ?? null, dealerId: (c.dealerId as string) ?? null };
    const existing = (await q.query(`SELECT * FROM users WHERE auth_source='OIDC' AND external_id=$1 FOR UPDATE`, [sub])).rows[0];
    if (existing) {
      if (existing.status !== 'ACTIVE') { await audit(q, existing.username, 'auth', existing.id, 'SSO_REFUSED_DISABLED', { ip }); throw rejected('This account is switched off.'); }
      const sets = ['display_name=$2', 'email=COALESCE($3,email)']; const vals: unknown[] = [existing.id, display, email];
      if (roles.length && c.syncRoles !== false) { vals.push(roles); sets.push(`roles=$${vals.length}`); }
      await q.query(`UPDATE users SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`, vals);
      return existing.id as string;
    }
    if (c.provision === false) throw rejected('You do not have an account in Meridian yet. Ask an administrator.');
    if (!roles.length) { await audit(q, uname, 'auth', sub, 'SSO_REFUSED_NO_ROLE', { ip, provider: ep.name }); throw rejected('Your account has no access to Meridian. Ask an administrator to add you to a group that has a role.'); }
    const problem = missingBinding(roles, bind, book);
    if (problem) throw rejected(`Your account cannot be set up automatically (${problem}). Ask an administrator.`);
    let username = sanitiseUsername(uname);
    if (username.length < 3) username = `sso.${sub.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    const clash = (await q.query('SELECT auth_source FROM users WHERE lower(username)=$1', [username])).rows[0];
    if (clash) {
      if (clash.authSource === 'LOCAL' && c.linkExisting === true) {
        const r = (await q.query(`UPDATE users SET auth_source='OIDC', external_id=$2, display_name=$3, email=COALESCE($4,email), roles=$5, updated_at=now() WHERE lower(username)=$1 AND NOT is_superuser AND status='ACTIVE' RETURNING id`, [username, sub, display, email, roles])).rows[0];
        if (!r) throw rejected('That account cannot be linked.');
        await audit(q, username, 'auth', r.id, 'SSO_LINKED', { provider: ep.name });
        return r.id as string;
      }
      if (clash.authSource === 'LOCAL') throw rejected('An account with your name already exists in Meridian. Ask an administrator to link it to your company sign-in.');
      username = `${username}.${sub.slice(0, 4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`.slice(0, 50);
    }
    const r = (await q.query(
      `INSERT INTO users (username, display_name, email, password_hash, roles, must_change_password, store_id, dealer_id, market_code, created_by, auth_source, external_id)
       VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8,'sso','OIDC',$9) RETURNING id`,
      [username, display, email, await hashPassword(randomBytes(32).toString('base64url')), roles, bind.storeId, bind.dealerId, await effectiveMarket(q, undefined), sub])).rows[0]!;
    await audit(q, 'sso', 'user', r.id, 'USER_CREATED', { username, roles, provider: ep.name, viaSso: true });
    return r.id as string;
  });
}

// ───────────────────────── the company directory (LDAP / Active Directory) ─────────────────────────
export interface DirectoryEntry { dn: string; username: string; displayName: string; email: string | null; phone: string | null; groups: string[] }
export interface DirectoryClient {
  /** Everyone under the search base that matches the filter, with the groups they belong to. */
  list(ep: HubEndpoint & { secret: string | null }): Promise<DirectoryEntry[]>;
  /** Whether the directory accepts this password for this entry. */
  bind(ep: HubEndpoint & { secret: string | null }, dn: string, password: string): Promise<boolean>;
}
const one = (v: unknown): string | null => { const x = Array.isArray(v) ? v[0] : v; return typeof x === 'string' && x.trim() ? x.trim() : Buffer.isBuffer(x) ? null : x == null ? null : String(x); };
const many = (v: unknown): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x));
/** A group's short name from its distinguished name (CN=Billing Team,OU=Groups,DC=corp becomes "Billing Team"); the full DN is matched too. */
export const groupNames = (dns: string[]): string[] => dns.flatMap((g) => { const m = /^cn=([^,]+)/i.exec(g); return m ? [g, m[1]!] : [g]; });

const ldapjs: DirectoryClient = {
  async list(ep) {
    const c = ep.config as Record<string, any>;
    const { Client: LdapClient } = await import('ldapts');
    const client = new LdapClient({ url: ep.url!, timeout: ep.timeoutMs, connectTimeout: ep.timeoutMs });
    try {
      await client.bind(String(c.bindDn), ep.secret ?? '');
      const uAttr = c.usernameAttr || 'sAMAccountName', nAttr = c.nameAttr || 'displayName', mAttr = c.mailAttr || 'mail', pAttr = c.phoneAttr || 'mobile', gAttr = c.groupAttr || 'memberOf';
      const { searchEntries } = await client.search(String(c.baseDn), { scope: 'sub', filter: c.userFilter || '(&(objectClass=person)(!(objectClass=computer)))', attributes: [uAttr, nAttr, mAttr, pAttr, gAttr], sizeLimit: 100_000, paged: { pageSize: 500 } });
      return searchEntries.flatMap((e) => { const u = one((e as any)[uAttr]); return u ? [{ dn: e.dn, username: u, displayName: one((e as any)[nAttr]) ?? u, email: one((e as any)[mAttr]), phone: one((e as any)[pAttr]), groups: groupNames(many((e as any)[gAttr])) }] : []; });
    } finally { await client.unbind().catch(() => {}); }
  },
  async bind(ep, dn, password) {
    if (!password) return false;   // an empty password would be an anonymous bind, which many directories accept
    const { Client: LdapClient } = await import('ldapts');
    const client = new LdapClient({ url: ep.url!, timeout: ep.timeoutMs, connectTimeout: ep.timeoutMs });
    try { await client.bind(dn, password); return true; } catch { return false; } finally { await client.unbind().catch(() => {}); }
  },
};
let directory: DirectoryClient = ldapjs;
export const setDirectoryClient = (c: DirectoryClient | null) => { directory = c ?? ldapjs; };

export interface SyncResult { runId: number; created: number; updated: number; disabled: number; skipped: number; total: number }
/** Brings the directory's people into Meridian: new ones are created (with the role their groups map to), changed ones updated, and those who left the directory switched off. */
export async function syncDirectory(db: Db, endpointId: string, triggeredBy = 'schedule'): Promise<SyncResult> {
  const row = (await db.query(`SELECT id FROM integration_endpoints WHERE id=$1 AND group_key='auth' AND kind='LDAP'`, [endpointId])).rows[0];
  if (!row) throw invalid('That is not a directory connection.');
  const ep = await hubEndpointWithSecret(db, 'auth', 'LDAP', (await db.query('SELECT name FROM integration_endpoints WHERE id=$1', [endpointId])).rows[0]!.name);
  if (!ep) throw rejected('The directory connection is switched off.');
  const run = (await db.query(`INSERT INTO directory_sync_runs (endpoint_id, triggered_by) VALUES ($1,$2) RETURNING id`, [endpointId, triggeredBy])).rows[0]!;
  const r: SyncResult = { runId: Number(run.id), created: 0, updated: 0, disabled: 0, skipped: 0, total: 0 };
  try {
    const entries = await directory.list(ep);
    r.total = entries.length;
    const c = ep.config as Record<string, any>;
    const seen = new Set<string>();
    for (const e of entries) {
      const roles = await rolesForGroups(db, e.groups, c.roleMappings, c.defaultRole);
      const username = sanitiseUsername(e.username);
      if (username.length < 3) { r.skipped++; continue; }
      await db.tx(async (q) => {
        const cur = (await q.query(`SELECT * FROM users WHERE lower(username)=$1 FOR UPDATE`, [username])).rows[0];
        if (cur && (cur.authSource !== 'LDAP' || cur.isSuperuser)) { r.skipped++; return; }   // never take over a local account
        if (cur) {
          seen.add(cur.id);
          if (!roles.length) {   // no longer in any group that maps to a role: no access
            if (cur.status === 'ACTIVE') { await q.query(`UPDATE users SET status='DISABLED', updated_at=now() WHERE id=$1`, [cur.id]); await revokeUserSessions(q, cur.id); await audit(q, 'directory', 'user', cur.id, 'USER_DISABLED', { reason: 'no mapped group' }); r.disabled++; }
            return;
          }
          await q.query(`UPDATE users SET display_name=$2, email=COALESCE($3,email), phone=COALESCE($4,phone), roles=$5, external_id=$6, status='ACTIVE', updated_at=now() WHERE id=$1`, [cur.id, e.displayName, e.email, e.phone, roles, e.dn]);
          if (cur.status !== 'ACTIVE') await audit(q, 'directory', 'user', cur.id, 'USER_ENABLED', {});
          r.updated++; return;
        }
        if (!roles.length) { r.skipped++; return; }
        const bind = { storeId: c.storeId ?? null, dealerId: c.dealerId ?? null };
        if (missingBinding(roles, bind, await getRoleOverrides(q))) { r.skipped++; return; }
        const ins = (await q.query(
          `INSERT INTO users (username, display_name, email, phone, password_hash, roles, must_change_password, store_id, dealer_id, market_code, created_by, auth_source, external_id)
           VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,'directory','LDAP',$10) RETURNING id`,
          [username, e.displayName, e.email, e.phone, await hashPassword(randomBytes(32).toString('base64url')), roles, bind.storeId, bind.dealerId, await effectiveMarket(q, undefined), e.dn])).rows[0]!;
        seen.add(ins.id);
        await audit(q, 'directory', 'user', ins.id, 'USER_CREATED', { username, roles, viaDirectory: true });
        r.created++;
      });
    }
    if (c.disableMissing !== false && entries.length > 0) {   // an empty answer is treated as a failed read, never as "everyone left"
      const gone = (await db.query(`SELECT id FROM users WHERE auth_source='LDAP' AND status='ACTIVE'`)).rows.filter((u) => !seen.has(u.id));
      for (const u of gone) { await db.tx(async (q) => { await q.query(`UPDATE users SET status='DISABLED', updated_at=now() WHERE id=$1`, [u.id]); await revokeUserSessions(q, u.id); await audit(q, 'directory', 'user', u.id, 'USER_DISABLED', { reason: 'left the directory' }); }); r.disabled++; }
    }
    await db.query(`UPDATE directory_sync_runs SET status='OK', finished_at=now(), created=$2, updated=$3, disabled=$4, skipped=$5 WHERE id=$1`, [r.runId, r.created, r.updated, r.disabled, r.skipped]);
    return r;
  } catch (e) {
    await db.query(`UPDATE directory_sync_runs SET status='FAILED', finished_at=now(), error=$2 WHERE id=$1`, [r.runId, (e as Error).message.slice(0, 500)]);
    throw rejected(`The directory could not be read: ${(e as Error).message.slice(0, 200)}`);
  }
}

/** Runs the syncs that are due by their schedule. Call it from the scheduler every few minutes. */
export async function runDueDirectorySyncs(db: Db): Promise<{ ran: number; failed: number }> {
  const eps = (await db.query(`SELECT id, config FROM integration_endpoints WHERE group_key='auth' AND kind='LDAP' AND enabled`)).rows;
  let ran = 0, failed = 0;
  for (const ep of eps) {
    const every = Number(ep.config?.syncEveryMinutes ?? 0);
    if (!every) continue;
    const last = (await db.query(`SELECT max(started_at) AS at FROM directory_sync_runs WHERE endpoint_id=$1`, [ep.id])).rows[0]!.at as string | null;
    if (last && Date.now() - new Date(last).getTime() < every * 60_000) continue;
    try { await syncDirectory(db, ep.id); ran++; } catch { failed++; }
  }
  return { ran, failed };
}
export async function listSyncRuns(q: Queryable, endpointId?: string): Promise<Row[]> {
  return (await q.query(`SELECT * FROM directory_sync_runs ${endpointId ? 'WHERE endpoint_id=$1' : ''} ORDER BY started_at DESC LIMIT 20`, endpointId ? [endpointId] : [])).rows;
}

/** At sign-in: does the directory accept this person's password? */
export async function verifyDirectoryPassword(db: Db, user: Row, password: string): Promise<boolean> {
  if (!user.externalId) return false;
  const ep = await hubEndpointWithSecret(db, 'auth', 'LDAP');
  if (!ep) return false;
  try { return await directory.bind(ep, user.externalId, password); } catch { return false; }
}
