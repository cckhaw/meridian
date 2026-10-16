import { createHash, randomBytes, randomUUID, type JsonWebKey } from 'node:crypto';
import { authHttp, verifyIdToken } from './auth-providers.js';
import { createCustomer, type NewCustomer } from './customers.js';
import type { Db, Queryable, Row } from './db.js';
import { DomainError, invalid, notFound, rejected } from './errors.js';
import { decryptText, encryptText } from './field-crypto.js';
import { hubEndpointWithSecret } from './integration-hub.js';
import { recordAssertedIdentity, personalProblems, type Personal } from './kyc.js';
import { assertionBind, sameName } from './kyc-providers.js';
export { kycMethods } from './kyc-providers.js';

/**
 * MyDigital ID as a way to prove identity, instead of photographing the ID. OpenID Connect with a code and PKCE: the browser goes to the provider, the person
 * approves in their app, and the browser comes back with a code. We trade the code for a signed id_token, compare what it says (name, ID number, date of birth)
 * with what was typed, and then the same rules as the photograph route run. If anything does not match, nothing is created and the person is told to
 * check their details or take the photographs instead.
 *
 * Where the browser comes back to:
 *  - the store-front: its own page (`redirectUriStore`), which hands the code to the API;
 *  - the CRM: a small API page (`redirectUriCrm`) opened in a pop-up while the screen waits and asks for the result.
 */
export type MdidContext = 'STORE' | 'CRM_NEW' | 'CRM_EXISTING';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const b64u = (b: Buffer) => b.toString('base64url');
const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const DEFAULT_CLAIMS = { name: 'name', idNumber: 'id_number', dateOfBirth: 'birthdate', nationality: 'nationality' };
const MINUTES = 15;

async function endpoint(q: Queryable) {
  const e = await hubEndpointWithSecret(q, 'identity', 'KYC_MYDIGITALID');
  return e && e.url && e.config.clientId ? e : null;
}
const redirectFor = (c: Record<string, unknown>, ctx: MdidContext): string | null => { const v = ctx === 'STORE' ? c.redirectUriStore : c.redirectUriCrm; return typeof v === 'string' && v ? v : null; };

interface Discovery { issuer?: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; userinfo_endpoint?: string }
const cache = new Map<string, { at: number; doc: Discovery }>();
async function endpoints(e: NonNullable<Awaited<ReturnType<typeof endpoint>>>, fresh = false): Promise<Discovery> {
  const c = e.config as Record<string, string | undefined>;
  if (c.authorizationEndpoint && c.tokenEndpoint && c.jwksUri) return { authorization_endpoint: c.authorizationEndpoint, token_endpoint: c.tokenEndpoint, jwks_uri: c.jwksUri };
  const issuer = e.url!.replace(/\/+$/, '');
  const hit = cache.get(issuer);
  if (hit && !fresh && Date.now() - hit.at < 600_000) return hit.doc;
  const r = await authHttp(`${issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } }, e.timeoutMs);
  if (!r.ok) throw new Error('discovery');
  const doc = (await r.json()) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri || doc.issuer?.replace(/\/+$/, '') !== issuer) throw new Error('discovery');
  cache.set(issuer, { at: Date.now(), doc });
  return { ...doc, authorization_endpoint: c.authorizationEndpoint || doc.authorization_endpoint, token_endpoint: c.tokenEndpoint || doc.token_endpoint, jwks_uri: c.jwksUri || doc.jwks_uri };
}

/** For the administrator's “test” button: can the provider's settings be read? */
export async function mydigitalidTest(q: Queryable): Promise<{ ok: boolean; message: string }> {
  const e = await endpoint(q);
  if (!e) return { ok: false, message: 'MyDigital ID is not set up yet (address and client id are needed).' };
  try { const d = await endpoints(e, true); return { ok: true, message: `Reached ${new URL(d.authorization_endpoint).host}. Sign-in address, token address and keys were found.` }; }
  catch { return { ok: false, message: 'The provider’s settings could not be read from the issuer address. Check it, or enter the endpoints by hand.' }; }
}

// ───────────────────────── step one: send the browser to the provider ─────────────────────────
export interface MdidDraft {
  /** CRM_NEW: the customer to create once identity is confirmed. */
  customer?: NewCustomer;
  identity?: { idType: Personal['idType']; idNumber: string; idExpiry?: string; nationality?: string; dateOfBirth?: string };
  source?: 'CRM_ORDER' | 'CRM_CUSTOMER'; storeId?: string | null;
}
export async function mydigitalidBegin(db: Db, o: { context: MdidContext; applicationId?: string; customerId?: string; draft?: MdidDraft; actor?: string }): Promise<{ sessionId: string; url: string; expiresInMinutes: number }> {
  const e = await endpoint(db);
  if (!e) throw rejected('MyDigital ID is not available. Use the photographs instead.');
  const redirectUri = redirectFor(e.config, o.context);
  if (!redirectUri) throw rejected('MyDigital ID is not set up for this channel. Use the photographs instead.');
  if (o.context === 'STORE') {
    const app = (await db.query('SELECT status, personal FROM applications WHERE id=$1', [o.applicationId])).rows[0];
    if (!app) throw notFound('application', o.applicationId ?? '');
    if (app.status !== 'DRAFT') throw rejected('This application can no longer change its identity check.');
    const p = personalProblems(app.personal);
    if (p.length) throw invalid(`Fill in your details first. ${p.join(' ')}`);
  } else if (o.context === 'CRM_EXISTING') {
    if (!o.customerId || !o.draft?.identity) throw invalid('The customer and the ID number are needed.');
  } else if (!o.draft?.customer || !o.draft.identity) throw invalid('The customer details are needed.');
  let d: Discovery;
  try { d = await endpoints(e); } catch { throw rejected('MyDigital ID could not be reached. Use the photographs instead.'); }
  const state = b64u(randomBytes(24)), nonce = b64u(randomBytes(24)), verifier = b64u(randomBytes(48));
  const id = randomUUID();
  await db.query(`DELETE FROM kyc_provider_sessions WHERE expires_at < now() - interval '1 day'`);
  await db.query(`INSERT INTO kyc_provider_sessions (id, provider, context, state_hash, nonce, verifier, redirect_uri, application_id, customer_id, draft, created_by, expires_at)
    VALUES ($1,'MYDIGITAL_ID',$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + ($11 || ' minutes')::interval)`,
    [id, o.context, sha(state), nonce, verifier, redirectUri, o.applicationId ?? null, o.customerId ?? null, JSON.stringify(o.draft ? { enc: encryptText(JSON.stringify(o.draft)) } : {}), o.actor ?? null, String(MINUTES)]);
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({ response_type: 'code', client_id: String(e.config.clientId), redirect_uri: redirectUri, scope: String(e.config.scopes || 'openid profile'), state, nonce,
    code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' }).toString();
  return { sessionId: id, url: u.toString(), expiresInMinutes: MINUTES };
}

// ───────────────────────── step two: the browser is back with a code ─────────────────────────
/** `caseId` is present when the confirmation already settled a case (the CRM); a store-front confirmation waits on the application until it is submitted. */
export interface MdidResult { sessionId: string; status: 'DONE' | 'FAILED'; message: string; context: MdidContext; applicationId: string | null; customerId: string | null; caseId?: string; caseStatus?: string; flags?: string[] }
const GIVE_UP = 'MyDigital ID could not confirm your identity. Check the details you entered, or take photographs of your ID instead.';

const claim = (c: Record<string, unknown>, name: unknown) => { const v = name ? c[String(name)] : undefined; return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null; };
const asIsoDate = (v: string | null) => {
  if (!v) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v); if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{2})[/.-](\d{2})[/.-](\d{4})$/.exec(v); if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const c = /^(\d{4})(\d{2})(\d{2})$/.exec(v); return c ? `${c[1]}-${c[2]}-${c[3]}` : null;
};

/**
 * Completes a session from the provider's return. Never throws for a provider-side problem: the session ends FAILED with a message the person can act on
 * (and the screen that is waiting shows it). An unknown or used state is the one error, since there is no session to report on.
 */
export async function mydigitalidComplete(db: Db, i: { state: string; code?: string; error?: string }): Promise<MdidResult> {
  const claimed = (await db.query(`UPDATE kyc_provider_sessions SET message='working' WHERE state_hash=$1 AND status='PENDING' AND message IS NULL AND expires_at > now() RETURNING *`, [sha(i.state)])).rows[0];
  if (!claimed) throw rejected('This MyDigital ID link has expired or was already used. Please start again.');
  const view = (status: 'DONE' | 'FAILED', message: string, extra: Partial<MdidResult> = {}): MdidResult => ({ sessionId: claimed.id, status, message, context: claimed.context, applicationId: claimed.applicationId ?? null, customerId: claimed.customerId ?? null, ...extra });
  const fail = async (message: string, why: string) => {
    await db.query(`UPDATE kyc_provider_sessions SET status='FAILED', message=$2, result=$3, draft='{}' WHERE id=$1`, [claimed.id, message, JSON.stringify({ why })]);
    return view('FAILED', message);
  };
  try {
    const e = await endpoint(db);
    if (!e) return await fail('MyDigital ID is not available. Use the photographs instead.', 'not configured');
    if (i.error || !i.code) return await fail(i.error === 'access_denied' ? 'You did not approve the request in MyDigital ID. You can try again, or take photographs of your ID instead.' : GIVE_UP, i.error ?? 'no code');
    const d = await endpoints(e);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: i.code, redirect_uri: claimed.redirectUri, client_id: String(e.config.clientId), code_verifier: claimed.verifier });
    if (e.secret) form.set('client_secret', e.secret);
    const tr = await authHttp(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form }, e.timeoutMs);
    if (!tr.ok) return await fail(GIVE_UP, `token ${tr.status}`);
    const tok = (await tr.json()) as { id_token?: string; access_token?: string };
    if (!tok.id_token) return await fail(GIVE_UP, 'no id_token');
    const jr = await authHttp(d.jwks_uri, { headers: { accept: 'application/json' } }, e.timeoutMs);
    if (!jr.ok) return await fail(GIVE_UP, 'keys');
    let claims: Record<string, unknown>;
    try { claims = await verifyIdToken(tok.id_token, { jwks: (await jr.json()) as { keys: JsonWebKey[] }, issuer: e.url!, clientId: String(e.config.clientId), nonce: claimed.nonce }); }
    catch { return await fail(GIVE_UP, 'token not valid'); }
    const map = { ...DEFAULT_CLAIMS, ...((e.config.claims as Record<string, string> | undefined) ?? {}) };
    if (!claim(claims, map.idNumber) && d.userinfo_endpoint && tok.access_token) {
      const ur = await authHttp(d.userinfo_endpoint, { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/json' } }, e.timeoutMs).catch(() => null);
      if (ur?.ok) claims = { ...(await ur.json() as Record<string, unknown>), ...claims };
    }

    // Who the person said they were.
    const draft: MdidDraft = claimed.draft?.enc ? JSON.parse(decryptText(claimed.draft.enc)) : {};
    const typed = await typedPerson(db, claimed, draft);
    const gotId = claim(claims, map.idNumber), gotName = claim(claims, map.name), gotDob = asIsoDate(claim(claims, map.dateOfBirth));
    if (!gotId) return await fail(GIVE_UP, 'no id number in the answer');
    const nameOk = gotName ? sameName(gotName, typed.fullName) : null, dobOk = gotDob ? gotDob === typed.dateOfBirth : null, idOk = alnum(gotId) === alnum(typed.idNumber);
    if (!idOk || nameOk === false || dobOk === false) return await fail(`The details MyDigital ID confirmed do not match the ones you entered (${[!idOk && 'ID number', nameOk === false && 'name', dobOk === false && 'date of birth'].filter(Boolean).join(', ')}). Correct them, or take photographs of your ID instead.`, 'mismatch');

    const assertion = { provider: 'MYDIGITAL_ID', subject: sha(String(claims.sub)).slice(0, 16), verifiedAt: new Date().toISOString(), matched: { name: nameOk, dateOfBirth: dobOk, idNumber: true }, acr: claims.acr ?? null, amr: claims.amr ?? null };
    const autoApprove = e.config.autoApprove !== false;
    if (claimed.context === 'STORE') {
      // The shopper still has the address, the agreements and the consent to go through: the confirmation waits on the application and is used when they submit.
      const message = 'Your identity is confirmed. Continue with your order.';
      await db.query(`UPDATE kyc_provider_sessions SET status='DONE', message=$2, result=$3, draft='{}' WHERE id=$1`, [claimed.id, message, JSON.stringify({ verified: true, bind: assertionBind(typed), autoApprove, assertion })]);
      return view('DONE', message);
    }
    const out = await db.tx(async (q) => {
      let customerId = claimed.customerId as string | null;
      if (claimed.context === 'CRM_NEW') customerId = (await createCustomer(q, draft.customer!)).customer.id as string;
      const c = await recordAssertedIdentity(q, { applicationId: null, customerId, source: draft.source ?? 'CRM_ORDER', actor: claimed.createdBy ?? 'crm', personal: typed, assertion, autoApprove });
      return { customerId, c };
    });
    const message = out.c.status === 'APPROVED' ? 'The identity is confirmed.' : 'The identity was received and is being reviewed.';
    await db.query(`UPDATE kyc_provider_sessions SET status='DONE', message=$2, customer_id=$3, result=$4, draft='{}' WHERE id=$1`, [claimed.id, message, out.customerId, JSON.stringify({ caseId: out.c.id, caseStatus: out.c.status, flags: out.c.flags })]);
    return view('DONE', message, { customerId: out.customerId, caseId: out.c.id, caseStatus: out.c.status, flags: out.c.flags });
  } catch (err) {
    const known = err instanceof DomainError;
    const text = (err as Error).message;
    return await fail(known ? text : GIVE_UP, known ? 'refused' : 'error');
  }
}

/** The identity the session is about: from the application, the customer record plus the typed ID, or the form that is waiting to become a customer. */
async function typedPerson(q: Queryable, s: Row, draft: MdidDraft): Promise<Personal> {
  if (s.context === 'STORE') {
    const app = (await q.query('SELECT personal FROM applications WHERE id=$1', [s.applicationId])).rows[0];
    if (!app) throw notFound('application', s.applicationId);
    return app.personal as Personal;
  }
  const idn = draft.identity!;
  if (s.context === 'CRM_NEW') {
    const c = draft.customer!;
    return { fullName: c.displayName, dateOfBirth: idn.dateOfBirth ?? c.dateOfBirth ?? '', nationality: idn.nationality, idType: idn.idType, idNumber: c.idDocument, idExpiry: idn.idExpiry, email: c.email ?? '', phone: c.phone ?? '' };
  }
  const cust = (await q.query('SELECT display_name, date_of_birth, email, phone, id_document_hash FROM customers WHERE id=$1', [s.customerId])).rows[0];
  if (!cust) throw notFound('customer', s.customerId);
  const { hashIdDocument } = await import('./customers.js');
  if (cust.idDocumentHash && hashIdDocument(idn.idNumber) !== cust.idDocumentHash) throw rejected('The ID number does not match the one on the customer record.');
  return { fullName: cust.displayName, dateOfBirth: idn.dateOfBirth ?? (cust.dateOfBirth ? String(cust.dateOfBirth).slice(0, 10) : ''), nationality: idn.nationality, idType: idn.idType, idNumber: idn.idNumber, idExpiry: idn.idExpiry, email: cust.email ?? '', phone: cust.phone ?? '' };
}

/** What a waiting screen asks. Only the person who started a CRM session (or the holder of a store-front application) can see it. */
export async function mydigitalidSession(q: Queryable, id: string, who: { actor?: string; applicationId?: string } = {}): Promise<{ sessionId: string; status: 'PENDING' | 'DONE' | 'FAILED'; message: string | null; context: MdidContext; customerId: string | null; caseId?: string; caseStatus?: string; flags?: string[]; expired: boolean }> {
  const s = (await q.query('SELECT * FROM kyc_provider_sessions WHERE id=$1', [id])).rows[0];
  if (!s || (who.actor && s.createdBy && s.createdBy !== who.actor) || (who.applicationId && s.applicationId !== who.applicationId)) throw notFound('session', id);
  const working = s.status === 'PENDING' && s.message === 'working';
  return { sessionId: s.id, status: s.status, message: working ? null : s.message ?? null, context: s.context, customerId: s.customerId ?? null, caseId: s.result?.caseId, caseStatus: s.result?.caseStatus, flags: s.result?.flags, expired: s.status === 'PENDING' && new Date(s.expiresAt) < new Date() };
}
