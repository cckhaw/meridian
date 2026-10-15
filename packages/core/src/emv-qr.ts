import { invalid } from './errors.js';

/**
 * Merchant-presented QR payment codes (EMVCo "MPM"), the format under the instant-payment QR schemes of Southeast Asia: SGQR / PayNow (Singapore), PromptPay
 * (Thailand), QRIS (Indonesia), DuitNow QR (Malaysia) and QR Ph (Philippines). A payload is a list of tag-length-value fields ending in a CRC-16. Meridian
 * writes the amount, the currency, the country, the merchant's name and city, the bill reference and the checksum; the part that says WHICH scheme and WHICH
 * merchant account (tags 02–51) is either built here (PromptPay, PayNow) or given by the operator exactly as their acquirer issued it (the other schemes),
 * because that part is the acquirer's to define. Always scan a sample with the scheme's own app before going live.
 */
export const QR_SCHEMES = ['PAYNOW', 'PROMPTPAY', 'QRIS', 'DUITNOW', 'QRPH'] as const;
export type QrScheme = (typeof QR_SCHEMES)[number];
export const QR_SCHEME_LABEL: Record<QrScheme, string> = { PAYNOW: 'SGQR / PayNow', PROMPTPAY: 'PromptPay', QRIS: 'QRIS', DUITNOW: 'DuitNow QR', QRPH: 'QR Ph' };
const NUMERIC_CURRENCY: Record<string, string> = { SGD: '702', THB: '764', IDR: '360', MYR: '458', PHP: '608', USD: '840' };
const COUNTRY: Record<QrScheme, string> = { PAYNOW: 'SG', PROMPTPAY: 'TH', QRIS: 'ID', DUITNOW: 'MY', QRPH: 'PH' };

export interface QrMerchant {
  /** PayNow: the company's UEN. */
  uen?: string;
  /** PromptPay: a mobile number (`0812345678`) or a 13-digit tax id. */
  proxy?: string;
  /** Any scheme: the merchant account field(s) exactly as the acquirer issued them, as tag → already-built value (for example `{ "26": "0014A00000061500010..." }`). */
  accounts?: Record<string, string>;
  name: string;
  city: string;
  /** Merchant category code (4 digits). */
  mcc?: string;
}

const tlv = (tag: string, value: string) => { if (value.length > 99) throw invalid(`QR field ${tag} is too long.`); return `${tag}${String(value.length).padStart(2, '0')}${value}`; };

/** CRC-16/CCITT-FALSE (polynomial 0x1021, initial value 0xFFFF), the checksum EMVCo QR codes end with. */
export function crc16(s: string): string {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const ascii = (s: string, max: number) => s.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').trim().slice(0, max);

export function qrMerchantProblem(scheme: QrScheme, m: Partial<QrMerchant> | undefined): string | null {
  if (!m) return `${QR_SCHEME_LABEL[scheme]} is not set up.`;
  if (!ascii(m.name ?? '', 25) || !ascii(m.city ?? '', 15)) return 'The merchant name and city are needed.';
  if (m.accounts && Object.keys(m.accounts).length) {
    for (const [t, v] of Object.entries(m.accounts)) if (!/^(0[2-9]|[1-4]\d|5[01])$/.test(t) || !v || v.length > 99) return `Merchant account field ${t} is not valid (tags 02 to 51, up to 99 characters).`;
    return null;
  }
  if (scheme === 'PAYNOW') return /^[A-Z0-9]{9,10}$/i.test(m.uen ?? '') ? null : 'PayNow needs the company’s UEN.';
  if (scheme === 'PROMPTPAY') return /^(0\d{9}|\d{13})$/.test(m.proxy ?? '') ? null : 'PromptPay needs a mobile number (0812345678) or a 13-digit tax id.';
  return `${QR_SCHEME_LABEL[scheme]} needs the merchant account field(s) from your acquirer.`;
}

/** Builds the text a QR code carries. `amountMinor` is in the currency's minor units (`exponent` decimals); a QR with an amount is a one-off (dynamic) code. */
export function buildEmvQr(o: { scheme: QrScheme; merchant: QrMerchant; currency: string; amountMinor?: number; exponent?: number; reference?: string }): string {
  const problem = qrMerchantProblem(o.scheme, o.merchant);
  if (problem) throw invalid(problem);
  const cur = NUMERIC_CURRENCY[o.currency];
  if (!cur) throw invalid(`No QR currency code for ${o.currency}.`);
  const m = o.merchant;
  const fields: string[] = [tlv('00', '01'), tlv('01', o.amountMinor ? '12' : '11')];
  if (m.accounts && Object.keys(m.accounts).length) for (const t of Object.keys(m.accounts).sort()) fields.push(tlv(t, m.accounts[t]!));
  else if (o.scheme === 'PAYNOW') fields.push(tlv('26', tlv('00', 'SG.PAYNOW') + tlv('01', '2') + tlv('02', m.uen!.toUpperCase()) + tlv('03', '0')));
  else if (o.scheme === 'PROMPTPAY') {
    const p = m.proxy!;
    fields.push(tlv('29', tlv('00', 'A000000677010111') + (p.length === 10 ? tlv('01', `0066${p.slice(1)}`) : tlv('02', p))));
  }
  fields.push(tlv('52', m.mcc && /^\d{4}$/.test(m.mcc) ? m.mcc : '4814'), tlv('53', cur));
  if (o.amountMinor) { const e = o.exponent ?? 2; fields.push(tlv('54', (o.amountMinor / 10 ** e).toFixed(e))); }
  fields.push(tlv('58', COUNTRY[o.scheme]), tlv('59', ascii(m.name, 25)), tlv('60', ascii(m.city, 15)));
  const ref = ascii(o.reference ?? '', 25).replace(/[^A-Za-z0-9]/g, '');
  if (ref) fields.push(tlv('62', tlv('01', ref)));
  const body = fields.join('') + '6304';
  return body + crc16(body);
}

/** Reads a payload back into tag → value, checking the checksum. For tests and for anyone wanting to look at a code. */
export function parseEmvQr(payload: string): { ok: boolean; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= payload.length) {
    const tag = payload.slice(i, i + 2), len = Number(payload.slice(i + 2, i + 4));
    if (!Number.isInteger(len)) return { ok: false, fields };
    fields[tag] = payload.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  const ok = !!fields['63'] && payload.length >= 4 && crc16(payload.slice(0, -4)) === payload.slice(-4);
  return { ok, fields };
}
