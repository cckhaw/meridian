import { CURRENCIES, currencyInfo, DEFAULT_REGIONAL, formatDate, formatDateTime, formatMoney, fromPlain, parseMoney, toPlain, type RegionalSettings } from '@meridian/types';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOffer } from './catalog.js';

import type { Db } from './db.js';
import { placeOrder } from './orders.js';
import { getBranding, getLogo, getRegional, inspectImage, marketFor, removeLogo, setBranding, setLogo, setRegional } from './settings.js';
import { freshDb, newCustomer } from './test-helpers.js';

const r = (over: Partial<RegionalSettings> = {}): RegionalSettings => ({ ...DEFAULT_REGIONAL, ...over });

describe('money formatting', () => {
  it('puts the symbol before or after, with or without a space', () => {
    expect(formatMoney(123456, r())).toBe('$1,234.56');
    expect(formatMoney(123456, r({ symbol: 'RM', symbolSpacing: true }))).toBe('RM 1,234.56');
    expect(formatMoney(123456, r({ symbol: '€', symbolPosition: 'after', symbolSpacing: true, thousandSeparator: '.', decimalSeparator: ',' }))).toBe('1.234,56 €');
    expect(formatMoney(123456, r({ symbol: 'kr', symbolPosition: 'after', symbolSpacing: true, thousandSeparator: ' ', decimalSeparator: ',' }))).toBe('1 234,56 kr');
    expect(formatMoney(123456, r({ thousandSeparator: "'" }))).toBe("$1'234.56");
    expect(formatMoney(123456, r({ thousandSeparator: '' }))).toBe('$1234.56');
  });
  it('handles negatives, zero, rounding and fewer displayed decimals', () => {
    expect(formatMoney(-5, r())).toBe('-$0.05');
    expect(formatMoney(0, r())).toBe('$0.00');
    expect(formatMoney(12345, r({ decimals: 0 }))).toBe('$123');
    expect(formatMoney(12350, r({ decimals: 0 }))).toBe('$124');
    expect(formatMoney(1234567, r({ grouping: 'indian' }))).toBe('$12,345.67');
    expect(formatMoney(12345678900, r({ grouping: 'indian' }))).toBe('$12,34,56,789.00');
    expect(formatMoney(null, r())).toBe('–');
  });
  it('supports zero- and three-decimal currencies', () => {
    expect(formatMoney(1500, r({ currency: 'JPY', symbol: '¥', exponent: 0, decimals: 0 }))).toBe('¥1,500');
    expect(formatMoney(1500123, r({ currency: 'KWD', symbol: 'KD', exponent: 3, decimals: 3 }))).toBe('KD1,500.123');
    expect(formatMoney(1500123, r({ currency: 'KWD', symbol: 'KD', exponent: 3, decimals: 2 }))).toBe('KD1,500.12');
  });
  it('parses what it formats, and refuses amounts that would lose precision', () => {
    const eu = r({ symbol: '€', symbolPosition: 'after', thousandSeparator: '.', decimalSeparator: ',' });
    expect(parseMoney('1.234,56', eu)).toBe(123456);
    expect(parseMoney('1.234,56 €', eu)).toBe(123456);
    expect(parseMoney('12', r())).toBe(1200);
    expect(parseMoney('-3.5', r())).toBe(-350);
    expect(parseMoney('1.234', r())).toBeNull();
    expect(parseMoney('abc', r())).toBeNull();
    expect(parseMoney('', r())).toBeNull();
    expect(parseMoney('1,234.50', r())).toBe(123450);
    for (const v of [0, 1, 99, 100, 123456789]) expect(parseMoney(formatMoney(v, r()), r())).toBe(v);
  });
  it('converts between plain input values and minor units', () => {
    expect(toPlain(1250, { exponent: 2 })).toBe('12.50');
    expect(toPlain(1250, { exponent: 0 })).toBe('1250');
    expect(fromPlain('12.5', { exponent: 2 })).toBe(1250);
    expect(fromPlain('19.99', { exponent: 2 })).toBe(1999);
  });
});

describe('dates', () => {
  it('formats in the chosen pattern and time zone', () => {
    const t = '2026-03-05T16:30:00Z'; // 00:30 on the 6th in Singapore
    expect(formatDate(t, r({ dateFormat: 'DD/MM/YYYY' }))).toBe('06/03/2026');
    expect(formatDate(t, r({ dateFormat: 'MM/DD/YYYY', timezone: 'America/New_York' }))).toBe('03/05/2026');
    expect(formatDate(t, r({ dateFormat: 'DD MMM YYYY' }))).toBe('06 Mar 2026');
    expect(formatDate(t, r({ dateFormat: 'YYYY-MM-DD' }))).toBe('2026-03-06');
    expect(formatDateTime(t, r({ timeFormat: '12h', dateFormat: 'DD.MM.YYYY' }))).toBe('06.03.2026 12:30 am');
    expect(formatDateTime(t, r({ timeFormat: '24h' }))).toBe('06 Mar 2026 00:30');
  });
  it('does not shift date-only values by time zone', () => {
    expect(formatDate('2026-03-05', r({ timezone: 'Pacific/Auckland', dateFormat: 'YYYY-MM-DD' }))).toBe('2026-03-05');
    expect(formatDate(null, r())).toBe('–');
    expect(formatDate('garbage', r())).toBe('–');
  });
});

describe('currency list', () => {
  it('is worldwide, unique, and exposes minor-unit digits', () => {
    expect(CURRENCIES.length).toBeGreaterThan(140);
    expect(new Set(CURRENCIES.map((c) => c.code)).size).toBe(CURRENCIES.length);
    expect(currencyInfo('JPY')?.exponent).toBe(0);
    expect(currencyInfo('KWD')?.exponent).toBe(3);
    expect(currencyInfo('MYR')?.symbol).toBe('RM');
  });
});

describe('regional settings', () => {
  let db: Db;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db.close(); });

  it('rejects an unusable configuration', async () => {
    await expect(setRegional(db, 't', r({ currency: 'XXX' }))).rejects.toThrow(/unknown currency/);
    await expect(setRegional(db, 't', r({ thousandSeparator: '.', decimalSeparator: '.' }))).rejects.toThrow(/different/);
    await expect(setRegional(db, 't', r({ decimals: 3 }))).rejects.toThrow(/Decimals/);
    await expect(setRegional(db, 't', r({ timezone: 'Mars/Base' }))).rejects.toThrow(/timezone/);
    await expect(setRegional(db, 't', r({ taxBps: 20_000 }))).rejects.toThrow(/Tax rate/);
  });

  it('switches currency before any transaction and re-denominates the catalog; blocks it afterwards', async () => {
    const before = await getOffer(db, 'plan-phone-24');
    const rec = before.prices.find((p) => p.type === 'RECURRING')!;
    const res = await setRegional(db, 'root', r({ currency: 'MYR', symbol: 'RM', symbolSpacing: true, taxName: 'SST', taxBps: 800, country: 'MY', dialCode: '+60' }));
    expect(res.repriced).toBeGreaterThan(0);
    const after = await getOffer(db, 'plan-phone-24');
    const rec2 = after.prices.find((p) => p.type === 'RECURRING')!;
    expect(rec2.amount.currency).toBe('MYR');
    expect(rec2.amount.amountMinor).toBe(rec.amount.amountMinor); // same numeric amount, new currency
    expect((await marketFor(db, 'SG')).currency).toBe('MYR');
    expect((await getRegional(db)).symbol).toBe('RM');

    // MYR-priced offers can now be ordered; the order is in MYR.
    const { customer } = await newCustomer(db);
    const order = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] });
    expect(order.currency).toBe('MYR');

    await expect(setRegional(db, 'root', r({ currency: 'USD', symbol: '$' }))).rejects.toThrow(/cannot change/);
    // Everything else stays editable after trading starts.
    const ok = await setRegional(db, 'root', r({ currency: 'MYR', symbol: 'RM', symbolPosition: 'after', thousandSeparator: ' ', decimalSeparator: ',', taxName: 'SST', taxBps: 800 }));
    expect(ok.regional.symbolPosition).toBe('after');
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity='settings' AND entity_id='regional'`)).rows[0]!.n).toBe(2);
  });
});

// Minimal valid PNG header + IHDR (+ filler) of a given size.
const png = (w: number, h: number, pad = 0) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const len = Buffer.alloc(4); len.writeUInt32BE(13);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, Buffer.from('IHDR'), ihdr, Buffer.alloc(4), deflateSync(Buffer.alloc(8)), Buffer.alloc(pad)]);
};

describe('branding and logo', () => {
  let db: Db;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db.close(); });

  it('reads dimensions from PNG, JPEG and WebP headers and refuses everything else', () => {
    expect(inspectImage(png(480, 120))).toEqual({ contentType: 'image/png', width: 480, height: 120 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x78, 0x01, 0xe0, 0x03, 0x01, 0x22, 0x00]);
    expect(inspectImage(jpeg)).toEqual({ contentType: 'image/jpeg', width: 480, height: 120 });
    const webp = Buffer.alloc(40); webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12); webp.writeUIntLE(479, 24, 3); webp.writeUIntLE(119, 27, 3);
    expect(inspectImage(webp)).toEqual({ contentType: 'image/webp', width: 480, height: 120 });
    expect(inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(inspectImage(Buffer.from('GIF89a......................................'))).toBeNull();
  });

  it('stores a valid logo, rejects oversized, tiny and non-image files, and can remove it', async () => {
    expect((await getBranding(db)).logo).toBeNull();
    const b = await setLogo(db, 'root', png(480, 120));
    expect(b.logo).toMatchObject({ width: 480, height: 120 });
    expect((await getLogo(db))?.contentType).toBe('image/png');
    await expect(setLogo(db, 'root', png(480, 120, 600 * 1024))).rejects.toThrow(/larger than/);
    await expect(setLogo(db, 'root', png(8, 8))).rejects.toThrow(/between/);
    await expect(setLogo(db, 'root', Buffer.from('<svg/>'))).rejects.toThrow(/PNG, JPEG or WebP/);
    expect((await getLogo(db))?.sha256).toBe(b.logo!.sha256); // failed uploads leave the old logo alone
    expect((await removeLogo(db, 'root')).logo).toBeNull();
  });

  it('saves the brand name and theme with validation', async () => {
    expect(await getBranding(db)).toMatchObject({ name: 'Meridian', theme: 'ocean' });
    expect(await setBranding(db, 'root', { name: '  Acme Mobile ', theme: 'forest' })).toMatchObject({ name: 'Acme Mobile', theme: 'forest' });
    await expect(setBranding(db, 'root', { name: '', theme: 'forest' })).rejects.toThrow(/Brand name/);
    await expect(setBranding(db, 'root', { name: 'X', theme: 'neon' })).rejects.toThrow(/unknown theme/);
  });
});
