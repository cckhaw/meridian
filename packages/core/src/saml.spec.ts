import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { saveHubEndpoint } from './integration-hub.js';
import { samlBegin, samlFinish, samlMetadata, samlSite } from './saml.js';
import { freshDb } from './test-helpers.js';

/** A throwaway identity provider: keys and certificates made here for the test, signing SAML responses the way a real one does. */
interface Signer { key: string; cert: string }
let db: Db, idp: Signer, other: Signer, dir: string;
const SITE = 'https://crm.example.com';
const IDP_ISSUER = 'https://idp.example.com/metadata';

const makeSigner = (name: string): Signer => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.crt`), '-days', '30', '-subj', `/CN=${name} (test only)`], { stdio: 'ignore' });
  return { key: readFileSync(join(dir, `${name}.key`), 'utf8'), cert: readFileSync(join(dir, `${name}.crt`), 'utf8') };
};
beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'saml-')); idp = makeSigner('idp'); other = makeSigner('other'); db = await freshDb(); }, 90_000);
afterAll(async () => { rmSync(dir, { recursive: true, force: true }); await db.close(); });

let n = 0;
async function provider(config: Record<string, unknown> = {}) {
  const ep = await saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'IDP_SAML', name: `Test IdP ${++n}`, url: 'https://idp.example.com/sso', config: { entityId: IDP_ISSUER, certificate: idp.cert, siteUrl: SITE, provision: true, defaultRole: 'ROLE_CALL_CENTER', roleMappings: { 'Billing Team': 'ROLE_BILLING_OPS', 'Super Admins': 'admin' }, ...config } } as never);
  return ep;
}
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
interface Opts {
  signer?: Signer; inResponseTo: string; acs: string; audience?: string; recipient?: string; notBeforeMs?: number; notOnOrAfterMs?: number; nameId?: string; issuer?: string;
  attrs?: Record<string, string | string[]>; signAssertion?: boolean; signResponse?: boolean; context?: string; assertionId?: string; tamper?: (xml: string) => string;
}
function samlResponse(o: Opts): string {
  const attrs = { email: 'alice@corp.example', displayName: 'Alice Tan', groups: ['Billing Team'], ...o.attrs };
  const attrXml = Object.entries(attrs).map(([k, v]) => `<saml:Attribute Name="${k}">${(Array.isArray(v) ? v : [v]).map((x) => `<saml:AttributeValue xsi:type="xs:string">${x}</saml:AttributeValue>`).join('')}</saml:Attribute>`).join('');
  const issuer = o.issuer ?? IDP_ISSUER, aid = o.assertionId ?? `_a${++n}${Date.now()}`;
  let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ID="_r${n}${Date.now()}" Version="2.0" IssueInstant="${iso(0)}" Destination="${o.acs}" InResponseTo="${o.inResponseTo}">`
    + `<saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`
    + `<saml:Assertion ID="${aid}" Version="2.0" IssueInstant="${iso(0)}"><saml:Issuer>${issuer}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.nameId ?? 'alice@corp.example'}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(o.notOnOrAfterMs ?? 300_000)}" Recipient="${o.recipient ?? o.acs}" InResponseTo="${o.inResponseTo}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${iso(o.notBeforeMs ?? -60_000)}" NotOnOrAfter="${iso(o.notOnOrAfterMs ?? 300_000)}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? o.acs.replace('/acs/', '/metadata/')}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${iso(-1000)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>${o.context ?? 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `<saml:AttributeStatement>${attrXml}</saml:AttributeStatement></saml:Assertion></samlp:Response>`;
  const signer = o.signer ?? idp;
  const sign = (xpath: string, after: string) => {
    const sig = new SignedXml({ privateKey: signer.key, publicCert: signer.cert, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
    sig.addReference({ xpath, transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
    sig.computeSignature(xml, { location: { reference: after, action: 'after' } });
    xml = sig.getSignedXml();
  };
  if (o.signAssertion !== false) sign("//*[local-name(.)='Assertion']", "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']");
  if (o.signResponse) sign("/*[local-name(.)='Response']", "/*[local-name(.)='Response']/*[local-name(.)='Issuer']");
  return Buffer.from(o.tamper ? o.tamper(xml) : xml).toString('base64');
}

/** Starts a sign-in the way the browser does and reads back what the provider would see: the request id and the relay state. */
async function begin(ep: { id: string }, next?: string) {
  const { url } = await samlBegin(db, ep.id, next);
  const u = new URL(url);
  expect(u.origin + u.pathname).toBe('https://idp.example.com/sso');
  const req = inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest')!, 'base64')).toString();
  return { id: /\bID="([^"]+)"/.exec(req)![1]!, relay: u.searchParams.get('RelayState')!, request: req };
}
const acsOf = (ep: { id: string; config?: Record<string, unknown> }) => samlSite({ id: ep.id, config: { siteUrl: SITE } }).acsUrl;
const finish = (ep: { id: string }, resp: string, relay?: string) => samlFinish(db, { endpointId: ep.id, samlResponse: resp, relayState: relay, ip: '203.0.113.5', userAgent: 'test' });
const refused = async (p: Promise<unknown>, msg = /could not be verified|second step|did not say who/) => { await expect(p).rejects.toThrow(msg); };

describe('SAML sign-in', () => {
  it('sends the browser to the provider with a request that names this site, and gives the provider what it needs', async () => {
    const ep = await provider();
    const b = await begin(ep, '/orders');
    expect(b.request).toContain(`AssertionConsumerServiceURL="${acsOf(ep)}"`);
    expect(b.request).toContain(`<saml:Issuer`);
    expect(b.request).toContain(`${SITE}/api/auth/saml/metadata/${ep.id}`);
    expect(b.relay).toBeTruthy();
    const meta = await samlMetadata(db, ep.id);
    expect(meta).toContain(acsOf(ep));
    expect(meta).toContain('EntityDescriptor');
  });

  it('signs a person in from a correctly signed assertion, creates their account with the roles their groups map to, and goes back to the page they wanted', async () => {
    const ep = await provider();
    const b = await begin(ep, '/orders?x=1');
    const done = await finish(ep, samlResponse({ inResponseTo: b.id, acs: acsOf(ep) }), b.relay);
    expect(done.next).toBe('/orders?x=1');
    expect(done.token).toBeTruthy();
    expect(done.user.username).toBe('alice');
    expect(done.user.roles).toEqual(['billing-ops']);
    const row = (await db.query(`SELECT auth_source, external_id, email, display_name FROM users WHERE lower(username)='alice'`)).rows[0]!;
    expect(row).toMatchObject({ authSource: 'SAML', externalId: 'alice@corp.example', email: 'alice@corp.example', displayName: 'Alice Tan' });
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'LOGIN_SSO' AND actor = 'alice'`)).rows.length).toBe(1);
    // the next time it is the same account, with the roles brought in line with the groups
    const b2 = await begin(ep);
    const again = await finish(ep, samlResponse({ inResponseTo: b2.id, acs: acsOf(ep), attrs: { groups: ['Billing Team', 'Nobody'] } }), b2.relay);
    expect(again.user.id).toBe(done.user.id);
  });

  it('never gives the Administrator role from a group, and refuses someone whose groups give no role when there is no default', async () => {
    const ep = await provider({ defaultRole: undefined });
    let b = await begin(ep);
    await expect(finish(ep, samlResponse({ inResponseTo: b.id, acs: acsOf(ep), nameId: 'boss@corp.example', attrs: { email: 'boss@corp.example', groups: ['Super Admins'] } }), b.relay)).rejects.toThrow(/no access to Meridian/);
    b = await begin(ep);
    await expect(finish(ep, samlResponse({ inResponseTo: b.id, acs: acsOf(ep), nameId: 'x@corp.example', attrs: { email: 'x@corp.example', groups: [] } }), b.relay)).rejects.toThrow(/no access to Meridian/);
  });

  it('refuses an assertion that is not signed, or signed by someone else, or changed after signing', async () => {
    const ep = await provider();
    for (const [what, make] of [
      ['unsigned', (id: string) => samlResponse({ inResponseTo: id, acs: acsOf(ep), signAssertion: false })],
      ['signed with another key', (id: string) => samlResponse({ inResponseTo: id, acs: acsOf(ep), signer: other })],
      ['response signed only', (id: string) => samlResponse({ inResponseTo: id, acs: acsOf(ep), signAssertion: false, signResponse: true })],
      ['attribute changed after signing', (id: string) => samlResponse({ inResponseTo: id, acs: acsOf(ep), tamper: (x) => x.replace('Billing Team', 'Super Admins') })],
      ['person changed after signing', (id: string) => samlResponse({ inResponseTo: id, acs: acsOf(ep), tamper: (x) => x.replace('alice@corp.example</saml:NameID>', 'ceo@corp.example</saml:NameID>') })],
    ] as const) {
      const b = await begin(ep);
      await expect(finish(ep, make(b.id), b.relay), what).rejects.toThrow(/could not be verified/);
    }
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'SSO_SAML_REFUSED'`)).rows[0]!.n).toBeGreaterThanOrEqual(5);
  });

  it('refuses an assertion for another audience, another recipient, another issuer, or outside its validity window', async () => {
    const ep = await provider();
    const acs = acsOf(ep);
    for (const [what, o] of [
      ['another audience', { audience: 'https://someone-else.example.com' }],
      ['another recipient', { recipient: 'https://evil.example.com/acs' }],
      ['another issuer', { issuer: 'https://rogue-idp.example.com' }],
      ['expired', { notBeforeMs: -600_000, notOnOrAfterMs: -300_000 }],
      ['not valid yet', { notBeforeMs: 600_000, notOnOrAfterMs: 900_000 }],
    ] as const) {
      const b = await begin(ep);
      const r = await finish(ep, samlResponse({ inResponseTo: b.id, acs, ...o }), b.relay).then(() => 'ACCEPTED', (e: Error) => e.message); expect(r, what).toMatch(/could not be verified/);
    }
  });

  it('accepts a response to a request only once: a captured response cannot be replayed, and a response nobody asked for is refused', async () => {
    const ep = await provider();
    const b = await begin(ep);
    const resp = samlResponse({ inResponseTo: b.id, acs: acsOf(ep) });
    expect((await finish(ep, resp, b.relay)).token).toBeTruthy();
    await expect(finish(ep, resp, b.relay)).rejects.toThrow(/could not be verified/);                          // the same response again
    const b2 = await begin(ep);
    await expect(finish(ep, samlResponse({ inResponseTo: `_never_asked_for`, acs: acsOf(ep) }), b2.relay)).rejects.toThrow(/could not be verified/);   // a response to a request we never sent
    await expect(finish(ep, samlResponse({ inResponseTo: b2.id, acs: acsOf(ep), assertionId: '_same' }), b2.relay)).resolves.toBeTruthy();
    const b3 = await begin(ep);
    await expect(finish(ep, samlResponse({ inResponseTo: b3.id, acs: acsOf(ep), assertionId: '_same' }), b3.relay)).rejects.toThrow(/could not be verified/);   // an assertion id seen before
  });

  it('refuses a response meant for another provider that this site also has configured', async () => {
    const a = await provider(), b = await provider();
    const begun = await begin(a);
    await expect(finish(b, samlResponse({ inResponseTo: begun.id, acs: acsOf(b) }), begun.relay)).rejects.toThrow(/could not be verified/);
  });

  it('can insist on the second step: the provider must report an authentication context the administrator named', async () => {
    const mfa = 'http://schemas.microsoft.com/claims/multipleauthn';
    const ep = await provider({ requiredAuthnContext: [mfa] });
    let b = await begin(ep);
    await expect(finish(ep, samlResponse({ inResponseTo: b.id, acs: acsOf(ep) }), b.relay)).rejects.toThrow(/second step/);
    b = await begin(ep);
    await expect(finish(ep, samlResponse({ inResponseTo: b.id, acs: acsOf(ep), context: mfa }), b.relay)).resolves.toBeTruthy();
  });

  it('keeps out anyone whose account is switched off, and does not create accounts when that is turned off', async () => {
    const ep = await provider();
    let b = await begin(ep);
    const first = await finish(ep, samlResponse({ inResponseTo: b.id, acs: acsOf(ep), nameId: 'dana@corp.example', attrs: { email: 'dana@corp.example' } }), b.relay);
    await db.query(`UPDATE users SET status = 'DISABLED' WHERE id = $1`, [first.user.id]);
    b = await begin(ep);
    await expect(finish(ep, samlResponse({ inResponseTo: b.id, acs: acsOf(ep), nameId: 'dana@corp.example', attrs: { email: 'dana@corp.example' } }), b.relay)).rejects.toThrow(/switched off/);
    const closed = await provider({ provision: false });
    b = await begin(closed);
    await expect(finish(closed, samlResponse({ inResponseTo: b.id, acs: acsOf(closed), nameId: 'new@corp.example', attrs: { email: 'new@corp.example' } }), b.relay)).rejects.toThrow(/do not have an account/);
  });

  it('does not use a relay state twice or let it carry a page on another site', async () => {
    const ep = await provider();
    const evil = await begin(ep, '//evil.example.com/x');
    const done = await finish(ep, samlResponse({ inResponseTo: evil.id, acs: acsOf(ep), nameId: 'eve@corp.example', attrs: { email: 'eve@corp.example' } }), evil.relay);
    expect(done.next).toBe('/');
    const b = await begin(ep);
    const resp = samlResponse({ inResponseTo: b.id, acs: acsOf(ep), nameId: 'eve@corp.example', attrs: { email: 'eve@corp.example' } });
    expect((await finish(ep, resp, b.relay)).next).toBe('/');
  });

  it('lists SAML providers with the OpenID Connect ones on the sign-in page, and a disabled one is gone', async () => {
    const { listSignInProviders } = await import('./auth-providers.js');
    const ep = await provider({ buttonLabel: 'Sign in with Contoso' });
    expect(await listSignInProviders(db)).toContainEqual({ id: ep.id, label: 'Sign in with Contoso', vendor: 'SAML' });
    await db.query(`UPDATE integration_endpoints SET enabled = false WHERE id = $1`, [ep.id]);
    expect((await listSignInProviders(db)).some((p) => p.id === ep.id)).toBe(false);
    await expect(samlBegin(db, ep.id)).rejects.toThrow(/not available/);
  });

  it('checks the settings when they are saved', async () => {
    const bad = (config: Record<string, unknown>, url = 'https://idp.example.com/sso') => saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'IDP_SAML', name: `Bad ${++n}`, url, config } as never);
    const ok = { entityId: IDP_ISSUER, certificate: idp.cert, siteUrl: SITE };
    await expect(bad({ ...ok }, 'http://idp.example.com/sso')).rejects.toThrow(/https/);
    await expect(bad({ ...ok, certificate: 'not a certificate' })).rejects.toThrow(/signing certificate/);
    await expect(bad({ ...ok, siteUrl: 'crm.example.com' })).rejects.toThrow(/this site’s address/);
    await expect(bad({ ...ok, entityId: '' })).rejects.toThrow(/entity id/);
    await expect(bad({ ...ok, requiredAuthnContext: 'x' })).rejects.toThrow(/authentication contexts/);
    await expect(bad({ ...ok })).resolves.toBeTruthy();
  });
});
