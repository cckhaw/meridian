/**
 * Shared pieces of the load-test scripts (run.mjs, load-pools.mjs): argument parsing, a seeded random source, the HTTP session with retry/backoff,
 * the concurrency governor, the bounded worker pool and a few pure planners. Everything here is free of I/O except Session.call, so it can be
 * tested with `node --test scripts/load-test/`.
 */
import { randomUUID } from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv) {
  return Object.fromEntries(argv.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] !== undefined && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null)).filter(Boolean));
}

/** A small seeded generator, so a run can be repeated with --seed. */
export function makeRng(seed) {
  let s = Number(seed) % 4294967296;
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;
  const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const shuffle = (a) => { const o = a.slice(); for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; };
  /** items: [[value, weight], …] */
  const weighted = (items) => { const t = items.reduce((n, [, w]) => n + w, 0); let x = rnd() * t; for (const [v, w] of items) { x -= w; if (x < 0) return v; } return items[items.length - 1][0]; };
  return { rnd, pick, chance, between, shuffle, weighted };
}

// ─────────────────────────── retry policy ───────────────────────────
const BEFORE_SEND = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);
const INFRA_TEXT = /time[d-]?\s?out|ETIMEDOUT|ECONNRESET|upstream|bad gateway|gateway|deadline|temporarily unavailable|too many connections|connection (terminated|refused|reset)|FUNCTION_INVOCATION|socket hang up/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The error code of a failed fetch (undici hides it under .cause). */
export const errorCode = (e) => e?.cause?.code ?? e?.code ?? '';

/**
 * Decides whether a failed call is worth repeating. `safe` means repeating cannot do harm: a read, or a write that carries an idempotency key.
 * A write that is not safe is repeated only when it cannot have been processed: the connection never opened, or the server said 429.
 */
export function shouldRetry({ method = 'GET', status = 0, error, bodyText = '', idempotent = false }) {
  const safe = SAFE_METHODS.has(method) || idempotent;
  if (error) {
    const code = errorCode(error);
    if (BEFORE_SEND.has(code)) return { retry: true, reason: code };
    return { retry: safe, reason: code || 'network error' };
  }
  if (status === 429) return { retry: true, reason: '429' };
  if ([502, 503, 504, 408, 520, 521, 522, 523, 524].includes(status)) return { retry: safe, reason: String(status) };
  if (status === 500 && INFRA_TEXT.test(bodyText)) return { retry: safe, reason: '500 (infrastructure timeout)' };
  return { retry: false, reason: '' };
}

/** Whether a call counts against the error rate that slows the run down: infrastructure trouble, not a business refusal (4xx). */
export const isInfraFailure = ({ status, error, bodyText = '' }) => !!error || status === 429 || status === 502 || status === 503 || status === 504 || status === 408 || (status >= 520 && status <= 524) || (status === 500 && INFRA_TEXT.test(bodyText));

/** Retry-After as milliseconds (seconds, or an HTTP date). */
export function parseRetryAfter(v, now = Date.now()) {
  if (!v) return 0;
  if (/^\d+(\.\d+)?$/.test(String(v).trim())) return Math.round(Number(v) * 1000);
  const t = Date.parse(v); return Number.isNaN(t) ? 0 : Math.max(0, t - now);
}

/** Exponential backoff with equal jitter (half fixed, half random); a Retry-After from the server wins when it is longer. attempt starts at 1. */
export function backoffDelay(attempt, { retryAfterMs = 0, base = 400, cap = 20_000, rnd = Math.random } = {}) {
  const exp = Math.min(cap, base * 2 ** (attempt - 1));
  const own = exp / 2 + rnd() * (exp / 2);
  return Math.round(Math.max(own, Math.min(retryAfterMs, 120_000) + rnd() * 250));
}

// ─────────────────────────── concurrency governor ───────────────────────────
/**
 * A global limit on calls in flight. Normally `limit`; when more than `threshold` of the last `window` calls failed for infrastructure
 * reasons it drops (halving, never below `min`) and stays down for `holdMs`, then recovers to `limit`.
 */
export class Governor {
  constructor({ limit = 6, min = 2, window = 50, threshold = 0.2, holdMs = 60_000, minSamples = 20, now = Date.now } = {}) {
    Object.assign(this, { limit, min: Math.min(min, limit), window, threshold, holdMs, minSamples, now });
    this._eff = limit; this.inflight = 0; this.ring = []; this.holdUntil = 0; this.waiters = []; this.trips = 0;
  }
  get effective() {
    if (this._eff < this.limit && this.now() >= this.holdUntil) { this._eff = this.limit; this.ring = []; this._wake(); }
    return this._eff;
  }
  get errorRate() { return this.ring.length ? this.ring.filter((x) => !x).length / this.ring.length : 0; }
  record(ok) {
    this.ring.push(!!ok); if (this.ring.length > this.window) this.ring.shift();
    if (this.ring.length >= this.minSamples && this.errorRate > this.threshold) {
      this._eff = Math.max(this.min, Math.floor(this._eff / 2)); this.holdUntil = this.now() + this.holdMs; this.ring = []; this.trips++;
    }
  }
  async acquire() {
    while (this.inflight >= this.effective) await new Promise((r) => { this.waiters.push(r); setTimeout(r, 1000).unref?.(); });
    this.inflight++;
  }
  release() { this.inflight = Math.max(0, this.inflight - 1); this._wake(); }
  _wake() { const w = this.waiters; this.waiters = []; w.forEach((r) => r()); }
}

/** Counters for the progress line: calls, infrastructure failures, retries, and the call rate over the last 30 seconds. */
export class Metrics {
  constructor(now = Date.now) { this.now = now; this.calls = 0; this.failures = 0; this.retries = 0; this.stamps = []; }
  onCall(infraFail) { this.calls++; if (infraFail) this.failures++; this.stamps.push(this.now()); }
  rate(windowMs = 30_000) { const cut = this.now() - windowMs; while (this.stamps.length && this.stamps[0] < cut) this.stamps.shift(); return this.stamps.length / (windowMs / 1000); }
}

// ─────────────────────────── HTTP session ───────────────────────────
export class Session {
  constructor(name, { base, gov, metrics, maxAttempts = 5, timeoutMs = 120_000, rnd = Math.random, sleepFn = sleep, onRetry } = {}) {
    Object.assign(this, { name, base, gov, metrics, maxAttempts, timeoutMs, rnd, sleepFn, onRetry }); this.cookie = ''; this.creds = null;
  }
  /** One HTTP exchange, repeated on transient failures (see shouldRetry). opts.idempotent marks a write that is safe to repeat. Never throws on a failed request. */
  async call(path, method = 'GET', body, headers = {}, opts = {}) {
    const idempotent = !!opts.idempotent || !!headers['idempotency-key'];
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let last;
    for (let attempt = 1; attempt <= (opts.attempts ?? this.maxAttempts); attempt++) {
      await this.gov?.acquire();
      let res, error, text = '';
      try {
        const r = await fetch(`${this.base}/api${path}`, { method, signal: AbortSignal.timeout(this.timeoutMs), headers: { 'content-type': 'application/json', origin: this.base, ...(this.cookie ? { cookie: this.cookie } : {}), ...headers }, body: payload });
        text = await r.text(); res = r;
      } catch (e) { error = e; } finally { this.gov?.release(); }
      let json; try { json = JSON.parse(text); } catch { json = text ? { raw: text.slice(0, 200) } : {}; }
      if (res) { const set = res.headers.get('set-cookie'); const m = set && /((?:__Host-)?meridian_session=[^;]+)/.exec(set); if (m) this.cookie = m[1]; }
      const status = res?.status ?? 0;
      const infra = isInfraFailure({ status, error, bodyText: text });
      this.gov?.record(!infra); this.metrics?.onCall(infra);
      last = { status, ok: !!res && status < 300, json: error ? { error: { message: `${errorCode(error) || 'network error'}: ${String(error.cause?.message ?? error.message).slice(0, 120)}` } } : json, replay: res?.headers.get('x-idempotent-replay') === 'true', attempts: attempt };
      if (status === 401 && this.creds && !opts.noRelogin && path !== '/auth/login') {   // the session ended (idle or absolute expiry): sign in again once and repeat
        if (await this.relogin()) { attempt--; opts = { ...opts, noRelogin: true }; continue; }
      }
      if (last.ok) return last;
      const d = shouldRetry({ method, status, error, bodyText: text, idempotent });
      if (!d.retry || attempt >= (opts.attempts ?? this.maxAttempts)) return last;
      this.metrics && this.metrics.retries++;
      this.onRetry?.(this.name, path, d.reason, attempt);
      await this.sleepFn(backoffDelay(attempt, { retryAfterMs: parseRetryAfter(res?.headers.get('retry-after')), rnd: this.rnd }));
    }
    return last;
  }
  async login(username, password, otp) {
    this.creds = { username, password, otp: undefined };
    let r = await this.call('/auth/login', 'POST', { username, password }, {}, { noRelogin: true });
    if (r.json?.mfaRequired) {
      if (!otp) throw new Error(`${username} needs a second factor: set ADMIN_OTP`);
      this.otpUsed = true;
      r = await this.call('/auth/verify-2fa', 'POST', { challenge: r.json.challenge.token, code: otp }, {}, { noRelogin: true });
    }
    if (!r.ok) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    this.user = r.json.user; return this;
  }
  async relogin() {
    if (!this.creds || this.otpUsed || this.relogging) return false;   // a one-time code cannot be used twice: restart with --resume instead
    this.relogging = true;
    try { this.cookie = ''; await this.login(this.creds.username, this.creds.password); return true; } catch { return false; } finally { this.relogging = false; }
  }
}

// ─────────────────────────── worker pool ───────────────────────────
/** Runs fn over items with `size` workers. A throwing item is handed to onError and does not stop the others. */
export async function pool(items, size, fn, onError = () => {}) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, size), items.length) }, async () => {
    while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch (e) { onError(e, items[k], k); } }
  }));
}

// ─────────────────────────── pure planners ───────────────────────────
/** Splits a list into chunks of at most `size`. */
export const chunks = (list, size) => { const out = []; for (let i = 0; i < list.length; i += Math.max(1, size)) out.push(list.slice(i, i + size)); return out; };

/**
 * How many orders each of `customers` customers gets so the total is `total`: most 2 to 6, some 10 or more, some 1. Returns an array of counts
 * that sums to exactly `total` (when there is at least one customer).
 */
export function orderCounts(customers, total, rng) {
  if (!customers) return [];
  const raw = Array.from({ length: customers }, () => rng.weighted([[1, 12], [2, 18], [3, 20], [4, 18], [5, 12], [6, 8], [rng.between(10, 18), 12]]));
  const sum = raw.reduce((a, b) => a + b, 0);
  const scaled = raw.map((n) => Math.max(1, Math.round((n * total) / sum)));
  let diff = total - scaled.reduce((a, b) => a + b, 0);
  for (let guard = 0; diff !== 0 && guard < total * 4 + 100; guard++) {
    const k = rng.between(0, customers - 1);
    if (diff > 0) { scaled[k]++; diff--; } else if (scaled[k] > 1) { scaled[k]--; diff++; } else if (scaled.every((n) => n <= 1)) break;
  }
  return scaled;
}

/** Picks the item with the fewest uses so far (ties broken at random): round-robin with some chance in it, so every item is reached. */
export function leastUsed(items, used, rng, key = (x) => x) {
  let best = [], min = Infinity;
  for (const it of items) { const n = used.get(key(it)) ?? 0; if (n < min) { min = n; best = [it]; } else if (n === min) best.push(it); }
  return best.length ? rng.pick(best) : undefined;
}

/**
 * Sim type for a plan line given what the place has: a physical SIM when the place has cards (and the dice allow), otherwise an eSIM; null when
 * neither is possible (then the line cannot be sold there).
 */
export function chooseSim({ physical, esim, esimShare }, rng) {
  if (physical && esim) return rng.chance(esimShare) ? 'ESIM' : 'PHYSICAL';
  if (physical) return 'PHYSICAL';
  if (esim) return 'ESIM';
  return null;
}

/** Scale estimate for the stock check: the plan lines an order target needs (1.3 x orders x plan share) and what each kind of line takes. */
export function estimateNeeds({ orders, planShare = 0.8, esimShare = 0.35 }) {
  const planLines = Math.ceil(1.3 * orders * planShare);
  const esims = Math.ceil(planLines * esimShare), physical = planLines - esims;
  return { planLines, msisdn: planLines, physical, esims, imsi: esims };
}

/** Refusal messages worth learning from, as a small classification the order loop acts on. */
export function classifyRefusal(msg) {
  const m = String(msg);
  let x;
  if ((x = /insufficient stock for (\S+) at (\S+) \(available (-?\d+)/i.exec(m))) return { kind: 'sku', sku: x[1], location: x[2], available: Number(x[3]) };
  if (/no free SIM cards at your store/i.test(m)) return { kind: 'store-sims' };
  if (/no free SIM cards in the warehouse/i.test(m)) return { kind: 'warehouse-sims' };
  if (/no eSIM profiles left|IMSI pool is empty/i.test(m)) return { kind: 'esims' };
  if (/no standard numbers left|no temporary number/i.test(m)) return { kind: 'msisdn' };
  if (/requires .*Buy one in the same order/i.test(m)) return { kind: 'requires' };
  if (/cannot be combined with/i.test(m)) return { kind: 'excludes' };
  if (/not sold through this channel/i.test(m)) return { kind: 'channel' };
  if (/credit check is needed/i.test(m)) return { kind: 'credit-check' };
  if (/identity verification|KYC/i.test(m)) return { kind: 'kyc' };
  if (/already being processed/i.test(m)) return { kind: 'in-flight' };
  return { kind: 'other' };
}

/** Records steps and their first distinct error messages. */
export class StepLog {
  constructor(maxErrors = 5) { this.stats = {}; this.errors = {}; this.max = maxErrors; }
  note(key, ok, err) {
    (this.stats[key] ??= { ok: 0, failed: 0 })[ok ? 'ok' : 'failed']++;
    if (!ok) { const e = (this.errors[key] ??= []); const m = String(err).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>').slice(0, 200); if (e.length < this.max && !e.includes(m)) e.push(m); }
  }
}

export const newKey = () => randomUUID();
