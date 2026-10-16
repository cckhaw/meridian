import { createHash } from 'node:crypto';
import type { Queryable } from './db.js';
import { loadDocumentBytes } from './documents.js';
import { hubEndpointWithSecret } from './integration-hub.js';

/**
 * The ID check service (hub group `identity`, kind KYC_OCR): a REST service that reads the photographs, compares the face and judges liveness.
 *
 * What we send:   POST {url}  { reference, idType, claimed: {fullName, dateOfBirth, idNumber, idExpiry, nationality}, images: { ID_FRONT, ID_BACK, SELFIE: base64 JPEG } }
 * What we read:   any JSON. `config.map` says where each value is (dot paths); the defaults below fit a typical service. Every value is optional: a service that only
 *                 checks the document (no face, no liveness) is fine, and what it does not return is simply not judged.
 * What we decide: PASS (clean), REVIEW (doubtful: a person looks, with the verdict in front of them), FAIL (the service says no, or the face is clearly someone else),
 *                 UNAVAILABLE (the service could not be reached or answered nonsense: the case drops to manual review, nothing is rejected because of it).
 */
export type ProviderStatus = 'PASS' | 'REVIEW' | 'FAIL' | 'UNAVAILABLE';
export interface ProviderVerdict {
  provider: 'OCR';
  mode: 'REST' | 'SIMULATOR';
  status: ProviderStatus;
  /** What a reviewer should know, in plain words. */
  reasons: string[];
  checks: { document: string | null; nameMatch: boolean | null; dobMatch: boolean | null; idNumberMatch: boolean | null; faceMatch: number | null; liveness: string | null };
  reference: string | null;
  ms: number;
  checkedAt: string;
}
export interface ProviderSettings {
  mode: 'REST' | 'SIMULATOR'; url: string | null; timeoutMs: number; authKind: 'NONE' | 'BEARER' | 'HEADER'; authHeader: string; secret: string | null;
  map: Record<string, string>; passValues: string[]; failValues: string[]; faceMatchMin: number; faceFailBelow: number; autoApprove: boolean; autoReject: boolean;
}
export interface ProviderInput {
  reference: string; idType: string;
  claimed: { fullName: string; dateOfBirth: string; idNumber: string; idExpiry?: string | null; nationality?: string | null };
  images: Array<{ kind: string; bytes: Buffer }>;
}

type HttpLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
let http: HttpLike = (url, init) => fetch(url, init) as unknown as ReturnType<HttpLike>;
/** Test seam: stands in for the ID check service. */
export const setKycProviderHttp = (f: HttpLike | null) => { http = f ?? ((url, init) => fetch(url, init) as unknown as ReturnType<HttpLike>); };

export const DEFAULT_MAP: Record<string, string> = {
  verdict: 'verdict', reasons: 'reasons', reference: 'id',
  fullName: 'extracted.fullName', dateOfBirth: 'extracted.dateOfBirth', idNumber: 'extracted.idNumber', idExpiry: 'extracted.expiry',
  faceMatch: 'faceMatch.score', liveness: 'liveness.result',
};
const DEFAULT_PASS = ['PASS', 'PASSED', 'APPROVED', 'ACCEPT', 'ACCEPTED', 'CLEAN', 'OK', 'VERIFIED', 'SUCCESS', 'TRUE'];
const DEFAULT_FAIL = ['FAIL', 'FAILED', 'REJECT', 'REJECTED', 'DECLINED', 'DENIED', 'FRAUD', 'FALSE'];

/** The service's settings with the secret in the clear, or null when none is switched on. */
export async function providerSettings(q: Queryable): Promise<ProviderSettings | null> {
  const e = await hubEndpointWithSecret(q, 'identity', 'KYC_OCR');
  if (!e) return null;
  const c = e.config as Record<string, any>;
  const mode = c.mode === 'SIMULATOR' ? 'SIMULATOR' : 'REST';
  if (mode === 'REST' && !e.url) return null;
  return {
    mode, url: e.url, timeoutMs: e.timeoutMs || 15000, authKind: (c.authKind ?? (e.secret ? 'BEARER' : 'NONE')) as ProviderSettings['authKind'], authHeader: String(c.authHeader ?? 'X-Api-Key'), secret: e.secret,
    map: { ...DEFAULT_MAP, ...(c.map ?? {}) }, passValues: (c.passValues ?? DEFAULT_PASS).map((x: string) => x.toUpperCase()), failValues: (c.failValues ?? DEFAULT_FAIL).map((x: string) => x.toUpperCase()),
    faceMatchMin: ratio(c.faceMatchMin, 0.8), faceFailBelow: ratio(c.faceFailBelow, 0.3), autoApprove: c.autoApprove !== false, autoReject: c.autoReject !== false,
  };
}

/** A score of 0..1, or 0..100 which is read as a percentage. */
function ratio(v: unknown, dflt: number): number { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? (n > 1 ? n / 100 : n) : dflt; }
function pick(o: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let cur: any = o;
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.')) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[part]; }
  return cur;
}
const words = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
export function sameName(a: string, b: string): boolean {
  const x = new Set(words(a)), y = new Set(words(b));
  if (!x.size || !y.size) return false;
  let hit = 0; for (const w of x) if (y.has(w)) hit++;
  return hit / Math.max(x.size, y.size) >= 0.6;
}
const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const asDate = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{2})[/.-](\d{2})[/.-](\d{4})$/.exec(s); if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s); if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return null;
};

/** Turns whatever the service answered into our verdict. Pure, so it can be tried with any answer. */
export function judge(body: unknown, claimed: ProviderInput['claimed'], st: Pick<ProviderSettings, 'map' | 'passValues' | 'failValues' | 'faceMatchMin' | 'faceFailBelow'>): Omit<ProviderVerdict, 'provider' | 'mode' | 'ms' | 'checkedAt'> {
  const reasons: string[] = [];
  let status: ProviderStatus = 'PASS';
  const raise = (to: ProviderStatus) => { const rank = { PASS: 0, REVIEW: 1, FAIL: 2, UNAVAILABLE: 3 }; if (rank[to] > rank[status]) status = to; };
  const get = (k: string) => pick(body, st.map[k]);

  const verdictRaw = get('verdict');
  const verdict = typeof verdictRaw === 'boolean' ? (verdictRaw ? 'TRUE' : 'FALSE') : verdictRaw == null ? null : String(verdictRaw).toUpperCase();
  let document: string | null = verdict;
  if (verdict != null) {
    if (st.failValues.includes(verdict)) { raise('FAIL'); reasons.push(`The service did not accept the document (${verdict}).`); }
    else if (!st.passValues.includes(verdict)) { raise('REVIEW'); reasons.push(`The service could not decide on the document (${verdict}).`); }
  }
  const sentReasons = get('reasons');
  if (Array.isArray(sentReasons) && status !== 'PASS') for (const r of sentReasons.slice(0, 5)) reasons.push(String(typeof r === 'object' && r ? ((r as any).message ?? (r as any).code ?? JSON.stringify(r)) : r).slice(0, 200));

  // What the service read off the document, against what the person typed.
  const nm = get('fullName'), dob = get('dateOfBirth'), idn = get('idNumber'), exp = get('idExpiry');
  const nameMatch = typeof nm === 'string' && nm.trim() ? sameName(nm, claimed.fullName) : null;
  const dobRead = dob == null ? null : asDate(dob);
  const dobMatch = dobRead ? dobRead === claimed.dateOfBirth : null;
  const idNumberMatch = typeof idn === 'string' && idn.trim() ? alnum(idn) === alnum(claimed.idNumber) : null;
  if (nameMatch === false) { raise('REVIEW'); reasons.push(`The name read from the ID (${String(nm).slice(0, 80)}) differs from the one given.`); }
  if (dobMatch === false) { raise('REVIEW'); reasons.push(`The date of birth read from the ID (${dobRead}) differs from the one given.`); }
  if (idNumberMatch === false) { raise('REVIEW'); reasons.push('The ID number read from the ID differs from the one given.'); }
  const expRead = exp == null ? null : asDate(exp);
  if (expRead && expRead < new Date().toISOString().slice(0, 10)) { raise('REVIEW'); reasons.push(`The service reads the ID as expired (${expRead}).`); }

  // Face and liveness only when the service does them.
  const faceRaw = get('faceMatch');
  const face = faceRaw == null || faceRaw === '' ? null : ratio(faceRaw, NaN);
  const faceMatch = face != null && Number.isFinite(face) ? Math.round(face * 1000) / 1000 : null;
  if (faceMatch != null) {
    if (faceMatch < st.faceFailBelow) { raise('FAIL'); reasons.push(`The face on the selfie does not match the ID (score ${faceMatch}).`); }
    else if (faceMatch < st.faceMatchMin) { raise('REVIEW'); reasons.push(`The face match is low (score ${faceMatch}).`); }
  }
  const liveRaw = get('liveness');
  const liveness = liveRaw == null ? null : typeof liveRaw === 'boolean' ? (liveRaw ? 'PASS' : 'FAIL') : String(liveRaw).toUpperCase();
  if (liveness && !st.passValues.includes(liveness)) { raise('REVIEW'); reasons.push(`The liveness check did not pass (${liveness}).`); }

  if (verdict == null && nameMatch == null && dobMatch == null && idNumberMatch == null && faceMatch == null && liveness == null) { raise('REVIEW'); reasons.push('The service answered, but nothing in the answer could be read. Check the response map.'); }
  const ref = get('reference');
  return { status, reasons, checks: { document, nameMatch, dobMatch, idNumberMatch, faceMatch, liveness }, reference: ref == null ? null : String(ref).slice(0, 100) };
}

/** A stand-in for trying the flow before a real service is connected. The ID number's ending picks the answer. */
function simulate(i: ProviderInput): unknown {
  const n = alnum(i.claimed.idNumber);
  if (n.endsWith('5555')) throw new Error('simulated outage');
  const base = { id: `SIM-${i.reference.slice(0, 8)}`, verdict: 'PASS', extracted: { fullName: i.claimed.fullName, dateOfBirth: i.claimed.dateOfBirth, idNumber: i.claimed.idNumber, expiry: i.claimed.idExpiry ?? null }, faceMatch: { score: 0.94 }, liveness: { result: 'PASS' } };
  if (n.endsWith('9999')) return { ...base, verdict: 'FAIL', faceMatch: { score: 0.12 }, reasons: ['Simulated: the document looks altered.'] };
  if (n.endsWith('0000')) return { ...base, verdict: 'REVIEW', faceMatch: { score: 0.62 }, reasons: ['Simulated: the photograph is hard to read.'] };
  return base;
}

/** Sends the photographs to the service. Never throws: any failure to get a usable answer is UNAVAILABLE, which sends the case to a person. */
export async function runProviderCheck(st: ProviderSettings, i: ProviderInput): Promise<ProviderVerdict> {
  const t0 = Date.now();
  const done = (v: Omit<ProviderVerdict, 'provider' | 'mode' | 'ms' | 'checkedAt'>): ProviderVerdict => ({ provider: 'OCR', mode: st.mode, ...v, ms: Date.now() - t0, checkedAt: new Date().toISOString() });
  const unavailable = (why: string) => done({ status: 'UNAVAILABLE', reasons: [`The ID check service could not be used (${why}). A person will review the documents.`], checks: { document: null, nameMatch: null, dobMatch: null, idNumberMatch: null, faceMatch: null, liveness: null }, reference: null });
  try {
    let body: unknown;
    if (st.mode === 'SIMULATOR') body = simulate(i);
    else {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      if (st.secret && st.authKind === 'BEARER') headers.authorization = `Bearer ${st.secret}`;
      if (st.secret && st.authKind === 'HEADER') headers[st.authHeader] = st.secret;
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), st.timeoutMs);
      try {
        const res = await http(st.url!, { method: 'POST', headers, signal: ctl.signal, body: JSON.stringify({
          reference: i.reference, idType: i.idType, claimed: i.claimed,
          images: Object.fromEntries(i.images.map((m) => [m.kind, m.bytes.toString('base64')])),
        }) });
        if (!res.ok) return unavailable(`it answered ${res.status}`);
        body = await res.json();
      } finally { clearTimeout(timer); }
    }
    return done(judge(body, i.claimed, st));
  } catch (e) {
    return unavailable((e as Error).name === 'AbortError' ? 'it did not answer in time' : 'it could not be reached');
  }
}

/** Loads the case's photographs from the vault and asks the service. Null when no service is switched on. */
export async function checkCaseWithProvider(q: Queryable, o: { caseId: string; docs: Array<{ id: string; kind: string }>; idType: string; claimed: ProviderInput['claimed'] }): Promise<{ verdict: ProviderVerdict; settings: ProviderSettings } | null> {
  const st = await providerSettings(q);
  if (!st) return null;
  const images: ProviderInput['images'] = [];
  for (const d of o.docs) if (['ID_FRONT', 'ID_BACK', 'SELFIE'].includes(d.kind)) images.push({ kind: d.kind, bytes: await loadDocumentBytes(q, d.id) });
  return { verdict: await runProviderCheck(st, { reference: o.caseId, idType: o.idType, claimed: o.claimed, images }), settings: st };
}

/** Which ways of proving identity are open, for the screens that offer a choice. Photographs are always open. */
export async function kycMethods(q: Queryable): Promise<{ photos: true; ocr: boolean; mydigitalid: { store: boolean; crm: boolean; label: string } }> {
  const [m, ocr] = await Promise.all([hubEndpointWithSecret(q, 'identity', 'KYC_MYDIGITALID'), providerSettings(q)]);
  const ready = !!m && !!m.url && !!m.config.clientId;
  const has = (k: string) => ready && typeof m!.config[k] === 'string' && !!m!.config[k];
  return { photos: true, ocr: !!ocr, mydigitalid: { store: has('redirectUriStore'), crm: has('redirectUriCrm'), label: String(m?.config.buttonLabel ?? 'MyDigital ID') } };
}

/** Ties a MyDigital ID confirmation to the details it confirmed, so a changed name, number or date of birth afterwards no longer counts. */
export function assertionBind(p: { fullName?: string; idNumber?: string; dateOfBirth?: string }): string {
  return createHash('sha256').update(`${words(p.fullName ?? '').sort().join(' ')}|${alnum(p.idNumber ?? '')}|${p.dateOfBirth ?? ''}`).digest('hex');
}
/** A store-front application whose applicant has confirmed their identity with MyDigital ID and has not changed the details since. */
export async function verifiedAssertion(q: Queryable, applicationId: string, personal: { fullName?: string; idNumber?: string; dateOfBirth?: string }): Promise<{ assertion: Record<string, unknown>; autoApprove: boolean } | null> {
  const r = (await q.query(`SELECT result FROM kyc_provider_sessions WHERE application_id=$1 AND status='DONE' AND result->>'verified'='true' ORDER BY created_at DESC LIMIT 1`, [applicationId])).rows[0];
  if (!r || r.result.bind !== assertionBind(personal)) return null;
  return { assertion: r.result.assertion, autoApprove: r.result.autoApprove !== false };
}
