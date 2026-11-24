import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider, type Profile, type SamlConfig } from '@node-saml/node-saml';
import { randomBytes } from 'node:crypto';
import { audit } from './audit.js';
import type { Db, Queryable } from './db.js';
import { rejected } from './errors.js';
import type { HubEndpoint } from './integration-hub.js';
import { openFederatedSession, type LoginResult } from './auth.js';
import { userForIdentity } from './auth-providers.js';

/**
 * SAML 2.0 single sign-on, the service provider side: the browser is sent to the identity provider with an AuthnRequest (HTTP-Redirect), and comes back to this site's assertion consumer
 * address (`/api/auth/saml/acs/<endpoint id>`, HTTP-POST) with a signed assertion. The assertion is checked by @node-saml/node-saml (XML signature against the provider's certificate(s),
 * issuer, audience, recipient, validity window, clock skew, age) and by us:
 *
 *  - only responses to a request we sent are accepted (`InResponseTo` must be a request id issued for this provider and is consumed atomically, so a response works once);
 *    provider-initiated sign-in (an unsolicited response) is refused;
 *  - the id of each assertion accepted is remembered until it expires, so a captured assertion cannot be replayed;
 *  - the assertion itself must be signed (the response alone being signed is not enough);
 *  - optionally the authentication context must be one the administrator named (to insist the provider did a second factor).
 * Who the person is, and which roles they get, then follow the same rules as OpenID Connect sign-in (`userForIdentity`): groups map to roles, never to Administrator.
 */
const TTL_MS = 10 * 60_000;

/** The memory a SAML sign-in needs between sending the request and getting the answer: request ids and accepted assertion ids, in the database so any server can answer. */
export function samlCache(db: Queryable, scope = ''): CacheProvider {
  // Keys are kept per provider, so a request id issued for one provider cannot be consumed by another.
  const k = (key: string) => `${scope}|${key}`;
  const live = `expires_at > now()`;
  return {
    async saveAsync(key, value): Promise<CacheItem | null> {
      await db.query(`DELETE FROM saml_cache WHERE expires_at < now()`);
      await db.query(`INSERT INTO saml_cache (key, value, expires_at) VALUES ($1,$2, now() + ($3 || ' milliseconds')::interval) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`, [k(key), value, String(TTL_MS)]);
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) { return ((await db.query(`SELECT value FROM saml_cache WHERE key=$1 AND ${live}`, [k(key)])).rows[0]?.value as string | undefined) ?? null; },
    async removeAsync(key) { return key === null ? null : ((await db.query(`DELETE FROM saml_cache WHERE key=$1 RETURNING value`, [k(key)])).rows[0]?.value as string | undefined) ?? null; },
    async consumeAsync(key) { return ((await db.query(`DELETE FROM saml_cache WHERE key=$1 AND ${live} RETURNING value`, [k(key)])).rows[0]?.value as string | undefined) ?? null; },
    async saveIfAbsentAsync(key, value, expiresAtMs) {
      await db.query(`DELETE FROM saml_cache WHERE key=$1 AND expires_at < now()`, [k(key)]);
      const r = await db.query(`INSERT INTO saml_cache (key, value, expires_at) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING`, [k(key), value, new Date(expiresAtMs).toISOString()]);
      return (r.rowCount ?? 0) > 0;
    },
  };
}

/** This site's side of the agreement with the provider, derived from the site address so it can be shown before it is typed anywhere: where the answer goes, the metadata, the entity id. */
export const samlSite = (ep: Pick<HubEndpoint, 'id' | 'config'>) => {
  const base = String(ep.config.siteUrl ?? '').replace(/\/+$/, '');
  return { acsUrl: `${base}/api/auth/saml/acs/${ep.id}`, metadataUrl: `${base}/api/auth/saml/metadata/${ep.id}`, entityId: text(ep.config.spEntityId) ?? `${base}/api/auth/saml/metadata/${ep.id}` };
};
const text = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
/** The provider's certificate(s): one PEM, or several in one field (the old and the new one while the provider rotates). */
export const certificatesOf = (pem: string): string[] => [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].map((m) => m[0]);

async function samlEndpoint(q: Queryable, id: string): Promise<HubEndpoint> {
  const r = (await q.query(`SELECT * FROM integration_endpoints WHERE id=$1 AND group_key='auth' AND kind='IDP_SAML' AND enabled`, [id])).rows[0];
  if (!r) throw rejected('That sign-in option is not available.');
  return { id: r.id, group: 'auth', kind: r.kind, name: r.name, url: r.url, fallbackUrl: r.fallbackUrl, timeoutMs: r.timeoutMs, config: r.config ?? {}, hasSecret: !!r.secretEnc, enabled: r.enabled, updatedBy: r.updatedBy, updatedAt: r.updatedAt } as HubEndpoint;
}

/** The library configured for one provider. `cache` is where request and assertion ids are kept. */
export function samlFor(ep: HubEndpoint, cache: CacheProvider): SAML {
  const c = ep.config;
  const site = samlSite(ep);
  const certs = certificatesOf(String(c.certificate ?? ''));
  if (!certs.length) throw rejected('The sign-in provider is not set up correctly. Ask an administrator.');
  const options: Partial<SamlConfig> & Pick<SamlConfig, 'idpCert' | 'issuer' | 'callbackUrl'> = {
    entryPoint: ep.url!, idpCert: certs, idpIssuer: String(c.entityId), issuer: site.entityId, callbackUrl: site.acsUrl, audience: site.entityId,
    wantAssertionsSigned: true, wantAuthnResponseSigned: c.requireSignedResponse === true,
    acceptedClockSkewMs: 60_000, maxAssertionAgeMs: 10 * 60_000,
    validateInResponseTo: ValidateInResponseTo.always, rejectReplayedAssertions: true, requestIdExpirationPeriodMs: TTL_MS, cacheProvider: cache,
    identifierFormat: typeof c.nameIdFormat === 'string' && c.nameIdFormat ? c.nameIdFormat : null,
    disableRequestedAuthnContext: true, forceAuthn: c.forceAuthn === true,
  };
  return new SAML(options as SamlConfig);
}

/** The buttons for the sign-in page come from `listSignInProviders`; this is what the button does: where to send the browser. */
export async function samlBegin(db: Db, endpointId: string, next?: string): Promise<{ url: string }> {
  const ep = await samlEndpoint(db, endpointId);
  const saml = samlFor(ep, samlCache(db, ep.id));
  const relay = randomBytes(18).toString('base64url');
  await samlCache(db, ep.id).saveAsync(`relay:${relay}`, JSON.stringify({ endpointId, next: next && next.startsWith('/') && !next.startsWith('//') ? next.slice(0, 300) : '/' }));
  const url = await saml.getAuthorizeUrlAsync(relay, undefined, {});
  return { url };
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);
const attr = (p: Profile, name: unknown): unknown => (typeof name === 'string' && name ? (p as unknown as Record<string, unknown>)[name] : undefined);
const authnContextOf = (p: Profile): string[] => {
  try {
    const a = p.getAssertion?.() as { Assertion?: { AuthnStatement?: Array<{ AuthnContext?: Array<{ AuthnContextClassRef?: unknown[] }> }> } } | undefined;
    return (a?.Assertion?.AuthnStatement ?? []).flatMap((s) => (s.AuthnContext ?? []).flatMap((x) => (x.AuthnContextClassRef ?? []).map((r) => String(typeof r === 'object' && r && '_' in r ? (r as { _: string })._ : r))));
  } catch { return []; }
};

/** The addresses the (signed) assertion names as the one it may be delivered to, from its bearer confirmations. */
const recipientsOf = (p: Profile): string[] => {
  try {
    const a = p.getAssertion?.() as { Assertion?: { Subject?: Array<{ SubjectConfirmation?: Array<{ $?: { Method?: string }; SubjectConfirmationData?: Array<{ $?: { Recipient?: string } }> }> }> } } | undefined;
    return (a?.Assertion?.Subject ?? []).flatMap((s) => (s.SubjectConfirmation ?? []).filter((c) => c.$?.Method === 'urn:oasis:names:tc:SAML:2.0:cm:bearer').flatMap((c) => (c.SubjectConfirmationData ?? []).map((d) => d.$?.Recipient ?? '')));
  } catch { return []; }
};
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * The answer: the form the provider posted to the assertion consumer address. Returns the session, or throws a refusal in words fit for the person to read (the reason is in the audit log).
 */
export async function samlFinish(db: Db, i: { endpointId: string; samlResponse: string; relayState?: string; ip?: string; userAgent?: string }): Promise<LoginResult & { next: string }> {
  const ep = await samlEndpoint(db, i.endpointId);
  const cache = samlCache(db, ep.id);
  const relay = i.relayState ? await cache.consumeAsync?.(`relay:${i.relayState}`) : null;
  let next = '/';
  if (relay) { try { const r = JSON.parse(relay) as { endpointId?: string; next?: string }; if (r.endpointId === ep.id) next = r.next ?? '/'; } catch { /* no way back to a page: the home page */ } }
  let profile: Profile | null;
  try { ({ profile } = await samlFor(ep, cache).validatePostResponseAsync({ SAMLResponse: i.samlResponse })); }
  catch (e) {
    await audit(db, 'sso', 'auth', ep.id, 'SSO_SAML_REFUSED', { ip: i.ip, reason: e instanceof Error ? e.message.slice(0, 300) : 'unknown' });
    throw rejected('The sign-in could not be verified. Please try again, or ask an administrator.');
  }
  if (!profile?.nameID) throw rejected('The sign-in response did not say who you are.');
  // The library only warns when the assertion is addressed to some other site; an assertion meant for another service provider must never sign anyone in here.
  if (!recipientsOf(profile).some((r) => sameUrl(r, samlSite(ep).acsUrl))) {
    await audit(db, 'sso', 'auth', ep.id, 'SSO_SAML_REFUSED', { ip: i.ip, reason: 'assertion not addressed to this site', recipients: recipientsOf(profile).slice(0, 3) });
    throw rejected('The sign-in could not be verified. Please try again, or ask an administrator.');
  }
  const need = list(ep.config.requiredAuthnContext);
  if (need.length && !authnContextOf(profile).some((x) => need.includes(x))) {
    await audit(db, 'sso', 'auth', ep.id, 'SSO_SAML_REFUSED', { ip: i.ip, reason: 'authentication context not accepted', got: authnContextOf(profile).slice(0, 5) });
    throw rejected('Your company sign-in did not use the second step this system requires. Sign in again with it.');
  }
  const c = ep.config;
  const email = text(attr(profile, c.emailAttribute ?? 'email')) ?? text(profile.email) ?? text(profile.mail) ?? (/@/.test(profile.nameID) ? profile.nameID : null);
  const username = text(attr(profile, c.usernameAttribute)) ?? email ?? profile.nameID;
  const display = text(attr(profile, c.nameAttribute ?? 'displayName')) ?? username;
  const userId = await userForIdentity(db, ep, { source: 'SAML', subject: profile.nameID, username, display, email, groups: list(attr(profile, c.groupsAttribute ?? 'groups')) }, i.ip);
  const session = await openFederatedSession(db, userId, `saml:${ep.name}`, { ip: i.ip, userAgent: i.userAgent });
  return { ...session, next };
}

/** What the identity provider's administrator needs: this site's entity id and where to send the answer. */
export async function samlMetadata(db: Db, endpointId: string): Promise<string> {
  const ep = await samlEndpoint(db, endpointId);
  return samlFor(ep, samlCache(db, ep.id)).generateServiceProviderMetadata(null, null);
}
