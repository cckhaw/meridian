import { createHash } from 'node:crypto';
import { currencyInfo, DEFAULT_REGIONAL, regionalProblems, type RegionalSettings } from '@meridian/types';
import { audit } from './audit.js';
import { market, MARKETS, type Market } from './config.js';

import type { Queryable } from './db.js';
import { invalid, rejected } from './errors.js';
import { DEFAULT_THEME, isThemeId, type ThemeId } from '@meridian/types';

// ───────────────────────── regional ─────────────────────────
export async function getRegional(q: Queryable): Promise<RegionalSettings> {
  const r = (await q.query(`SELECT value FROM settings WHERE key='regional'`)).rows[0];
  return { ...DEFAULT_REGIONAL, ...(r?.value ?? {}) };
}

// ───────────────────────── markets ─────────────────────────
export interface MarketSettings {
  multiple: boolean;
  /** The market used when nobody picks one (new logins, offers, customers, store sales) while several markets are on. */
  defaultMarket: string;
  /** The markets that can be chosen. The home country (Settings → Regional) is always one of them. */
  markets: Market[];
}

const MARKET_CODE = /^[A-Z]{2}$/;
const cleanMarket = (m: Market): Market => {
  const code = String(m.code ?? '').trim().toUpperCase();
  if (!MARKET_CODE.test(code)) throw invalid(`A market code is two letters, such as SG (got “${m.code ?? ''}”).`);
  const name = String(m.name ?? '').trim();
  if (!name || name.length > 60) throw invalid(`Give market ${code} a name of up to 60 characters.`);
  const dialCode = String(m.dialCode ?? '').trim();
  if (!/^\+\d{1,4}$/.test(dialCode)) throw invalid(`The dial code of ${name} looks like +65.`);
  const taxName = String(m.taxName ?? '').trim();
  if (!taxName || taxName.length > 20) throw invalid(`Give the tax of ${name} a short name such as GST (up to 20 characters).`);
  if (!Number.isInteger(m.taxBps) || m.taxBps < 0 || m.taxBps > 10000) throw invalid(`The tax rate of ${name} must be between 0% and 100%.`);
  return { code, name, currency: '', dialCode, taxBps: m.taxBps, taxName };
};

export async function getMarketSettings(q: Queryable): Promise<MarketSettings> {
  const [row, r] = await Promise.all([q.query(`SELECT value FROM settings WHERE key='markets'`).then((x) => x.rows[0]?.value as Partial<MarketSettings> | undefined), getRegional(q)]);
  const stored = Array.isArray(row?.markets) && row.markets.length ? row.markets : Object.values(MARKETS);
  // The home country always shows the tax and dial code from Regional, which is where they are edited.
  const markets = stored.map((m) => ({ ...m, currency: r.currency, ...(m.code === r.country ? { taxBps: r.taxBps, taxName: r.taxName, dialCode: r.dialCode } : {}) }));
  if (!markets.some((m) => m.code === r.country)) markets.unshift({ ...market(r.country), code: r.country, name: market(r.country).code === r.country ? market(r.country).name : r.country, currency: r.currency });
  const defaultMarket = markets.some((m) => m.code === row?.defaultMarket) ? (row!.defaultMarket as string) : r.country;
  return { multiple: row?.multiple === true, defaultMarket, markets };
}

/** Whether anything still uses a market, so removing it would strand offers, logins, customers or stores. */
async function marketUsage(q: Queryable, code: string): Promise<string[]> {
  const n = async (sql: string) => Number((await q.query(sql, [code])).rows[0]?.n ?? 0);
  const uses: Array<[string, number]> = [
    ['offer', await n(`SELECT count(*) AS n FROM catalog_nodes WHERE level='OFFER' AND $1 = ANY(markets)`)],
    ['login', await n(`SELECT count(*) AS n FROM users WHERE market_code=$1`)],
    ['customer', await n(`SELECT count(*) AS n FROM customers WHERE market_code=$1`)],
    ['store', await n(`SELECT count(*) AS n FROM stores WHERE market_code=$1`)],
  ];
  return uses.filter(([, c]) => c > 0).map(([w, c]) => `${c} ${w}${c === 1 ? '' : 's'}`);
}

export async function setMarketSettings(q: Queryable, actor: string, s: { multiple: boolean; defaultMarket?: string; markets?: Market[] }): Promise<MarketSettings> {
  const before = await getMarketSettings(q);
  const r = await getRegional(q);
  const markets = (s.markets ?? before.markets).map(cleanMarket);
  const codes = new Set<string>();
  for (const m of markets) { if (codes.has(m.code)) throw invalid(`Market ${m.code} is listed twice.`); codes.add(m.code); }
  if (!codes.has(r.country)) throw invalid(`${r.country} is your own country (Settings → Regional), so it stays in the list.`);
  const defaultMarket = (s.defaultMarket ?? before.defaultMarket).trim().toUpperCase();
  if (!codes.has(defaultMarket)) throw invalid(`The default market ${defaultMarket} must be one of the markets in the list.`);
  for (const old of before.markets) {
    if (codes.has(old.code)) continue;
    const used = await marketUsage(q, old.code);
    if (used.length) throw rejected(`${old.name} cannot be removed: ${used.join(', ')} still use it. Move them to another market first.`);
  }
  const value = { multiple: !!s.multiple, defaultMarket, markets: markets.map(({ currency: _c, ...m }) => m) };
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('markets', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(value), actor]);
  await audit(q, actor, 'settings', 'markets', 'update', { multiple: value.multiple, defaultMarket, markets: value.markets.map((m) => m.code), from: before.markets.map((m) => m.code) });
  return getMarketSettings(q);
}

/**
 * How markets apply right now. With one market (the default) everything belongs to the deployment's own country from Settings → Regional:
 * no market is asked for, none filters an offer, a customer or a login. With several, `home` is still the country the currency and tax
 * settings describe, `default` is the market used when nobody picks one, and every offer, login, customer and order carries a market.
 */
export async function marketMode(q: Queryable): Promise<{ multiple: boolean; home: string; default: string }> {
  const [m, r] = await Promise.all([getMarketSettings(q), getRegional(q)]);
  return { multiple: m.multiple, home: r.country, default: m.multiple ? m.defaultMarket : r.country };
}

/** The market to use for something: the one asked for when several markets are on (it must be one of them), else the default market. */
export async function effectiveMarket(q: Queryable, asked?: string | null): Promise<string> {
  const m = await getMarketSettings(q);
  const r = await getRegional(q);
  if (!m.multiple) return r.country;
  if (!asked) return m.defaultMarket;
  const code = asked.trim().toUpperCase();
  if (!m.markets.some((x) => x.code === code)) throw invalid(`unknown market ${asked}`);
  return code;
}

/** The market to match when looking for a duplicate ID document: any market when there is only one. */
export async function marketDuplicates(q: Queryable, code: string): Promise<string | null> {
  return (await marketMode(q)).multiple ? code : null;
}

/**
 * A market with the deployment's regional settings applied. The deployment keeps one currency (offer prices and the ledger are in it), so every
 * market uses it; the home country also takes the tax and dial code set in Regional, other markets keep their own.
 */
export async function marketFor(q: Queryable, code: string): Promise<Market> {
  const [ms, r] = await Promise.all([getMarketSettings(q), getRegional(q)]);
  const base = ms.multiple ? ms.markets.find((m) => m.code === code.trim()) ?? market(code) : ms.markets.find((m) => m.code === r.country)!;
  const own = !ms.multiple || base.code === r.country;
  return { ...base, currency: r.currency, taxBps: own ? r.taxBps : base.taxBps, taxName: own ? r.taxName : base.taxName, dialCode: own ? r.dialCode : base.dialCode };
}

const TRANSACTION_TABLES = ['orders', 'invoices', 'payments', 'gl_entries', 'commissions'] as const;
export async function hasTransactions(q: Queryable): Promise<boolean> {
  for (const t of TRANSACTION_TABLES) if ((await q.query(`SELECT 1 FROM ${t} LIMIT 1`)).rows.length) return true;
  return false;
}

/** Rescales every catalog price from one currency exponent to another, keeping the numeric amount (9.00 SGD becomes 9 JPY). */
function rescaleMoney(m: { amountMinor: number; currency: string }, to: string, fromExp: number, toExp: number) {
  const f = 10 ** Math.abs(toExp - fromExp);
  return { ...m, currency: to, amountMinor: toExp >= fromExp ? m.amountMinor * f : Math.round(m.amountMinor / f) };
}

export async function setRegional(q: Queryable, actor: string, input: RegionalSettings): Promise<{ regional: RegionalSettings; repriced: number }> {
  const cur = currencyInfo(input.currency);
  if (!cur) throw invalid(`unknown currency ${input.currency}`);
  const next: RegionalSettings = { ...input, exponent: cur.exponent, symbol: input.symbol.trim(), country: input.country.toUpperCase() };
  const problems = regionalProblems(next);
  if (problems.length) throw invalid(problems.join(' '));
  try { new Intl.DateTimeFormat('en', { timeZone: next.timezone }); } catch { throw invalid(`unknown timezone ${next.timezone}`); }

  const before = await getRegional(q);
  let repriced = 0;
  if (before.currency !== next.currency) {
    // Money already booked is in the old currency and cannot be silently re-labelled.
    if (await hasTransactions(q)) throw rejected(`The currency cannot change from ${before.currency} to ${next.currency} once orders, invoices or payments exist.`);
    const offers = (await q.query(`SELECT id, data FROM catalog_nodes WHERE level='OFFER'`)).rows;
    for (const o of offers) {
      const d = o.data ?? {};
      const re = (m: any) => (m && typeof m.amountMinor === 'number' ? rescaleMoney(m, next.currency, before.exponent, next.exponent) : m);
      const data = {
        ...d,
        ...(d.prices ? { prices: d.prices.map((p: any) => ({ ...p, amount: re(p.amount) })) } : {}),
        ...(d.contract?.subsidy ? { contract: { ...d.contract, subsidy: { deviceRetailPrice: re(d.contract.subsidy.deviceRetailPrice), subsidyAmount: re(d.contract.subsidy.subsidyAmount) } } } : {}),
      };
      await q.query(`UPDATE catalog_nodes SET data=$2, updated_at=now() WHERE id=$1`, [o.id, JSON.stringify(data)]);
      repriced++;
    }
    await q.query('UPDATE accounts SET currency=$1', [next.currency]);
  }
  await q.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ('regional', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [JSON.stringify(next), actor],
  );
  await audit(q, actor, 'settings', 'regional', 'update', { from: before, to: next, repricedOffers: repriced });
  return { regional: next, repriced };
}

// ───────────────────────── branding ─────────────────────────
export interface Branding {
  name: string;
  theme: ThemeId;
  /** sha256 of the uploaded logo (cache-busting), or null when none is set. */
  logo: { sha256: string; width: number; height: number } | null;
  /** The browser-tab icon, same shape; null when none is set (the built-in icon is used). */
  favicon: { sha256: string; width: number; height: number } | null;
}
export const DEFAULT_BRAND_NAME = 'Meridian';
export const FAVICON_RECOMMENDATION = { width: 256, height: 256, maxBytes: 256 * 1024, formats: ['PNG', 'JPEG', 'WebP'], note: 'Square, simple and bold. Shown at 16 to 64px in the browser tab.' } as const;
export const LOGO_RECOMMENDATION = { width: 480, height: 120, maxBytes: 512 * 1024, formats: ['PNG', 'JPEG', 'WebP'], note: 'Transparent PNG, about 4:1 wide. Shown at up to 40px tall.' } as const;

export async function getBranding(q: Queryable): Promise<Branding> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='branding'`)).rows[0]?.value ?? {};
  const imgs = (await q.query(`SELECT name, sha256, width, height FROM assets WHERE name IN ('logo','favicon')`)).rows;
  const pick = (n: string) => { const r = imgs.find((x) => x.name === n); return r ? { sha256: r.sha256 as string, width: r.width as number, height: r.height as number } : null; };
  return {
    name: typeof v.name === 'string' && v.name.trim() ? v.name : DEFAULT_BRAND_NAME,
    theme: isThemeId(v.theme) ? v.theme : DEFAULT_THEME,
    logo: pick('logo'),
    favicon: pick('favicon'),
  };
}

export async function setBranding(q: Queryable, actor: string, input: { name: string; theme: string }): Promise<Branding> {
  const name = input.name.trim();
  if (!name || name.length > 40) throw invalid('Brand name must be 1–40 characters.');
  if (!isThemeId(input.theme)) throw invalid(`unknown theme ${input.theme}`);
  await q.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ('branding', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [JSON.stringify({ name, theme: input.theme }), actor],
  );
  await audit(q, actor, 'settings', 'branding', 'update', { name, theme: input.theme });
  return getBranding(q);
}

// ── logo upload ──
export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';
export interface ImageInfo { contentType: ImageType; width: number; height: number }

/** Identifies PNG/JPEG/WebP by magic bytes (never by the claimed type or file name) and reads the dimensions. SVG is refused: it can carry scripts. */
export function inspectImage(b: Buffer): ImageInfo | null {
  if (b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.subarray(12, 16).toString('ascii') === 'IHDR') {
    return { contentType: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { contentType: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  if (b.length > 30 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') {
    const kind = b.subarray(12, 16).toString('ascii');
    if (kind === 'VP8X') return { contentType: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { contentType: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { contentType: 'image/webp', width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
  }
  return null;
}

type BrandImage = 'logo' | 'favicon';
const IMAGE_RULES = {
  logo: { label: 'logo', max: LOGO_RECOMMENDATION.maxBytes, minW: 32, minH: 16 },
  favicon: { label: 'favicon', max: FAVICON_RECOMMENDATION.maxBytes, minW: 16, minH: 16 },
} as const;
async function setBrandImage(q: Queryable, kind: BrandImage, actor: string, bytes: Buffer): Promise<Branding> {
  const r = IMAGE_RULES[kind];
  if (bytes.length === 0) throw invalid(`The ${r.label} file is empty.`);
  if (bytes.length > r.max) throw invalid(`The ${r.label} is larger than ${r.max / 1024} KB.`);
  const info = inspectImage(bytes);
  if (!info) throw invalid(`The ${r.label} must be a PNG, JPEG or WebP image (SVG is not accepted).`);
  if (info.width < r.minW || info.height < r.minH || info.width > 4096 || info.height > 4096) throw invalid(`The ${r.label} is ${info.width}×${info.height}px; it must be between ${r.minW}×${r.minH} and 4096×4096.`);
  if (kind === 'favicon' && info.width !== info.height) throw invalid(`The favicon must be square; this one is ${info.width}×${info.height}px.`);
  const sha = createHash('sha256').update(bytes).digest('hex');
  await q.query(
    `INSERT INTO assets (name, content_type, bytes, sha256, width, height, updated_by) VALUES ($7,$1,$2,$3,$4,$5,$6)
     ON CONFLICT (name) DO UPDATE SET content_type=EXCLUDED.content_type, bytes=EXCLUDED.bytes, sha256=EXCLUDED.sha256, width=EXCLUDED.width, height=EXCLUDED.height, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [info.contentType, bytes, sha, info.width, info.height, actor, kind],
  );
  await audit(q, actor, 'settings', kind, 'update', { sha256: sha, width: info.width, height: info.height, bytes: bytes.length });
  return getBranding(q);
}
async function removeBrandImage(q: Queryable, kind: BrandImage, actor: string): Promise<Branding> {
  await q.query(`DELETE FROM assets WHERE name=$1`, [kind]);
  await audit(q, actor, 'settings', kind, 'remove');
  return getBranding(q);
}
async function getBrandImage(q: Queryable, kind: BrandImage): Promise<{ contentType: string; bytes: Buffer; sha256: string } | null> {
  const r = (await q.query(`SELECT content_type, bytes, sha256 FROM assets WHERE name=$1`, [kind])).rows[0];
  return r ? { contentType: r.contentType, bytes: Buffer.from(r.bytes), sha256: r.sha256 } : null;
}
export const setLogo = (q: Queryable, actor: string, bytes: Buffer) => setBrandImage(q, 'logo', actor, bytes);
export const removeLogo = (q: Queryable, actor: string) => removeBrandImage(q, 'logo', actor);
export const getLogo = (q: Queryable) => getBrandImage(q, 'logo');
export const setFavicon = (q: Queryable, actor: string, bytes: Buffer) => setBrandImage(q, 'favicon', actor, bytes);
export const removeFavicon = (q: Queryable, actor: string) => removeBrandImage(q, 'favicon', actor);
export const getFavicon = (q: Queryable) => getBrandImage(q, 'favicon');
