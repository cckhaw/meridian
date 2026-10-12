import { createHash } from 'node:crypto';
import { currencyInfo, DEFAULT_REGIONAL, regionalProblems, type RegionalSettings } from '@meridian/types';
import { audit } from './audit.js';
import { market, type Market } from './config.js';

import type { Queryable } from './db.js';
import { invalid, rejected } from './errors.js';
import { DEFAULT_THEME, isThemeId, type ThemeId } from '@meridian/types';

// ───────────────────────── regional ─────────────────────────
export async function getRegional(q: Queryable): Promise<RegionalSettings> {
  const r = (await q.query(`SELECT value FROM settings WHERE key='regional'`)).rows[0];
  return { ...DEFAULT_REGIONAL, ...(r?.value ?? {}) };
}

/** A market with the deployment's regional settings applied (currency, tax, dial code). Use this, not the static table, for money. */
export async function marketFor(q: Queryable, code: string): Promise<Market> {
  const base = market(code);
  const r = await getRegional(q);
  return { ...base, currency: r.currency, taxBps: r.taxBps, taxName: r.taxName, dialCode: base.code === r.country ? r.dialCode : base.dialCode };
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
}
export const DEFAULT_BRAND_NAME = 'Meridian';
export const LOGO_RECOMMENDATION = { width: 480, height: 120, maxBytes: 512 * 1024, formats: ['PNG', 'JPEG', 'WebP'], note: 'Transparent PNG, about 4:1 wide. Shown at up to 40px tall.' } as const;

export async function getBranding(q: Queryable): Promise<Branding> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='branding'`)).rows[0]?.value ?? {};
  const logo = (await q.query(`SELECT sha256, width, height FROM assets WHERE name='logo'`)).rows[0];
  return {
    name: typeof v.name === 'string' && v.name.trim() ? v.name : DEFAULT_BRAND_NAME,
    theme: isThemeId(v.theme) ? v.theme : DEFAULT_THEME,
    logo: logo ? { sha256: logo.sha256, width: logo.width, height: logo.height } : null,
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

export async function setLogo(q: Queryable, actor: string, bytes: Buffer): Promise<Branding> {
  if (bytes.length === 0) throw invalid('The logo file is empty.');
  if (bytes.length > LOGO_RECOMMENDATION.maxBytes) throw invalid(`The logo is larger than ${LOGO_RECOMMENDATION.maxBytes / 1024} KB.`);
  const info = inspectImage(bytes);
  if (!info) throw invalid('The logo must be a PNG, JPEG or WebP image (SVG is not accepted).');
  if (info.width < 32 || info.height < 16 || info.width > 4096 || info.height > 4096) throw invalid(`The logo is ${info.width}×${info.height}px; it must be between 32×16 and 4096×4096.`);
  const sha = createHash('sha256').update(bytes).digest('hex');
  await q.query(
    `INSERT INTO assets (name, content_type, bytes, sha256, width, height, updated_by) VALUES ('logo',$1,$2,$3,$4,$5,$6)
     ON CONFLICT (name) DO UPDATE SET content_type=EXCLUDED.content_type, bytes=EXCLUDED.bytes, sha256=EXCLUDED.sha256, width=EXCLUDED.width, height=EXCLUDED.height, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [info.contentType, bytes, sha, info.width, info.height, actor],
  );
  await audit(q, actor, 'settings', 'logo', 'update', { sha256: sha, width: info.width, height: info.height, bytes: bytes.length });
  return getBranding(q);
}
export async function removeLogo(q: Queryable, actor: string): Promise<Branding> {
  await q.query(`DELETE FROM assets WHERE name='logo'`);
  await audit(q, actor, 'settings', 'logo', 'remove');
  return getBranding(q);
}
export async function getLogo(q: Queryable): Promise<{ contentType: string; bytes: Buffer; sha256: string } | null> {
  const r = (await q.query(`SELECT content_type, bytes, sha256 FROM assets WHERE name='logo'`)).rows[0];
  return r ? { contentType: r.contentType, bytes: Buffer.from(r.bytes), sha256: r.sha256 } : null;
}
