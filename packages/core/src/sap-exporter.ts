import { createHash } from 'node:crypto';
import { audit } from './audit.js';
import { csvCell, parseCsv } from './csv.js';
import type { Queryable } from './db.js';
import { invalid } from './errors.js';
import type { Resolved } from './coa.js';

// ───────────────────────── settings ─────────────────────────
export const SAP_FORMATS = ['FLAT', 'IDOC', 'JSON', 'CSV'] as const;
export type SapFormat = (typeof SAP_FORMATS)[number];
export const SAP_TRANSPORTS = ['MANUAL', 'REST', 'SFTP', 'RFC'] as const;
export type SapTransportKind = (typeof SAP_TRANSPORTS)[number];

export interface SapSettings {
  /** SAP company code (BUKRS) the journals are posted in. */
  companyCode: string;
  /** SAP document type (BLART), for example SA (G/L account document). */
  documentType: string;
  /** Ledger group (LDGRP / ledger), blank for the leading ledger. */
  ledgerGroup: string;
  /** The file produced by a run. */
  format: SapFormat;
  /** DAILY_SUMMARY: one SAP document per posting day and currency, lines summed per account / cost centre / profit centre. DETAIL: one SAP document per BSS journal. */
  aggregate: 'DAILY_SUMMARY' | 'DETAIL';
  /** How the file reaches SAP. MANUAL: staff download it. */
  transport: SapTransportKind;
  /** REST endpoint that takes the file (transport REST). The bearer token is read from MERIDIAN_SAP_TOKEN, never stored here. */
  endpoint: string;
  /** The daily close runs by itself when the daily job runs. */
  autoClose: boolean;
  /** Every ingested event is exported on its own, straight away, as well as in the batches. */
  realtime: boolean;
}
export const DEFAULT_SAP: SapSettings = { companyCode: '1000', documentType: 'SA', ledgerGroup: '', format: 'FLAT', aggregate: 'DAILY_SUMMARY', transport: 'MANUAL', endpoint: '', autoClose: false, realtime: false };

export async function getSapSettings(q: Queryable): Promise<SapSettings> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='sap'`)).rows[0]?.value as Partial<SapSettings> | undefined;
  return { ...DEFAULT_SAP, ...v, companyCode: v?.companyCode ?? process.env.MERIDIAN_SAP_COMPANY_CODE ?? DEFAULT_SAP.companyCode };
}
export function cleanSapSettings(s: Partial<SapSettings>): SapSettings {
  const code = (v: unknown, what: string, max: number, optional = false) => {
    const t = typeof v === 'string' ? v.trim() : '';
    if (!t && optional) return '';
    if (!/^[A-Za-z0-9]{1,}$/.test(t) || t.length > max) throw invalid(`${what} is up to ${max} letters or digits.`);
    return t.toUpperCase();
  };
  const out: SapSettings = {
    companyCode: code(s.companyCode, 'The company code', 4), documentType: code(s.documentType, 'The document type', 2), ledgerGroup: code(s.ledgerGroup, 'The ledger group', 4, true),
    format: s.format as SapFormat, aggregate: s.aggregate as SapSettings['aggregate'], transport: s.transport as SapTransportKind, endpoint: (s.endpoint ?? '').trim(), autoClose: !!s.autoClose, realtime: !!s.realtime,
  };
  if (!(SAP_FORMATS as readonly string[]).includes(out.format)) throw invalid(`The file format is one of ${SAP_FORMATS.join(', ')}.`);
  if (out.aggregate !== 'DAILY_SUMMARY' && out.aggregate !== 'DETAIL') throw invalid('Summarise by day, or one document per journal.');
  if (!(SAP_TRANSPORTS as readonly string[]).includes(out.transport)) throw invalid(`The transport is one of ${SAP_TRANSPORTS.join(', ')}.`);
  if (out.transport === 'REST' && !/^https:\/\/[^\s]+$/.test(out.endpoint)) throw invalid('The REST endpoint is an https:// address.');
  return out;
}
export async function setSapSettings(q: Queryable, actor: string, s: Partial<SapSettings>): Promise<SapSettings> {
  const v = cleanSapSettings({ ...(await getSapSettings(q)), ...s }); // a partial update keeps everything it does not mention
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('sap', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(v), actor]);
  await audit(q, actor, 'settings', 'sap', 'update', { ...v });
  return v;
}

// ───────────────────────── documents ─────────────────────────
/** A ledger line with the SAP posting the rules gave it. */
export interface ExportEntry {
  id: number; journalId: string; entryDate: string; sourceType: string; sourceId: string; accountCode: string; description: string;
  debitMinor: number; creditMinor: number; currency: string; stream: string | null; eventType: string | null; sap: Resolved;
}
export interface SapItem { lineNo: number; postingKey: '40' | '50'; sapAccount: string; amountMinor: number; costCenter: string; profitCenter: string; taxCode: string; text: string; assignment: string }
export interface SapDocument { reference: string; postingDate: string; documentDate: string; currency: string; headerText: string; items: SapItem[] }
export interface FileTotals { documents: number; items: number; debitMinor: number; creditMinor: number; byAccount: Record<string, { debitMinor: number; creditMinor: number }> }
export interface RenderedFile { fileName: string; contentType: string; content: string; sha256: string }

const SAP_MAX_ITEMS = 999; // a SAP accounting document holds at most 999 line items
const clip = (v: string, n: number) => v.replace(/[\r\n|]+/g, ' ').trim().slice(0, n);
const ymd = (d: string) => d.replaceAll('-', '');

/** Minor units to the decimal SAP expects, with the currency's own number of decimals. */
export const toDecimal = (minor: number, exponent: number) => (exponent === 0 ? String(minor) : `${minor < 0 ? '-' : ''}${Math.floor(Math.abs(minor) / 10 ** exponent)}.${String(Math.abs(minor) % 10 ** exponent).padStart(exponent, '0')}`);
export const fromDecimal = (v: string, exponent: number) => Math.round(Number(v) * 10 ** exponent);

/**
 * Turns sub-ledger entries into SAP general-ledger journal files. The same documents can be written as a pipe-delimited flat file (the layout FB01 / LSMW batch input
 * loads), an IDoc (FIDCCP02: E1FIKPF header and E1FISEG items), a JSON payload shaped like BAPI_ACCDOC_POST, or CSV. Every document balances; amounts are exact (summed
 * per side, never netted), so the file totals equal the ledger totals and a reconciliation can prove it.
 */
export class SapExporter {
  constructor(private readonly settings: SapSettings, private readonly exponent = 2) {}

  documents(entries: ExportEntry[], runRef: string): SapDocument[] {
    const docs: SapDocument[] = [];
    const groups = new Map<string, ExportEntry[]>();
    for (const e of entries) {
      const k = this.settings.aggregate === 'DETAIL' ? `J|${e.journalId}` : `D|${e.entryDate}|${e.currency}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
    }
    for (const [key, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const first = list[0]!;
      const summary = key.startsWith('D|');
      let items = summary ? this.summed(list) : list.map((e, i) => this.item(i + 1, e));
      if (items.length > SAP_MAX_ITEMS) items = this.summed(list);
      if (items.length > SAP_MAX_ITEMS) throw invalid(`A SAP document holds at most ${SAP_MAX_ITEMS} lines, and ${first.entryDate} needs ${items.length} even summed: add posting rules that group more lines together.`);
      docs.push({
        reference: `${runRef}-${String(docs.length + 1).padStart(4, '0')}`, postingDate: first.entryDate, documentDate: first.entryDate, currency: first.currency,
        headerText: summary ? `Meridian ${first.entryDate} summary` : clip(`${first.sourceType} ${first.sourceId}`, 25), items: items.map((it, i) => ({ ...it, lineNo: i + 1 })),
      });
    }
    return docs;
  }

  private item(lineNo: number, e: ExportEntry): SapItem {
    const debit = e.debitMinor > 0;
    return { lineNo, postingKey: debit ? '40' : '50', sapAccount: e.sap.sapAccount, amountMinor: debit ? e.debitMinor : e.creditMinor, costCenter: e.sap.costCenter ?? '', profitCenter: e.sap.profitCenter ?? '', taxCode: e.sap.taxCode ?? '', text: clip(e.description, 50), assignment: clip(`${e.sourceType}:${e.sourceId}`, 18) };
  }

  /** One line per account / cost centre / profit centre / tax code and side. */
  private summed(list: ExportEntry[]): SapItem[] {
    const m = new Map<string, SapItem & { n: number }>();
    for (const e of list) {
      const it = this.item(0, e);
      const k = [it.postingKey, it.sapAccount, it.costCenter, it.profitCenter, it.taxCode].join('|');
      const cur = m.get(k);
      if (cur) { cur.amountMinor += it.amountMinor; cur.n++; } else m.set(k, { ...it, n: 1, text: clip(e.sap.ruleName, 50), assignment: '' });
    }
    return [...m.values()].sort((a, b) => a.sapAccount.localeCompare(b.sapAccount) || a.postingKey.localeCompare(b.postingKey)).map(({ n, ...it }) => ({ ...it, text: n > 1 ? clip(`${it.text} (${n})`, 50) : it.text }));
  }

  static totals(docs: SapDocument[]): FileTotals {
    const t: FileTotals = { documents: docs.length, items: 0, debitMinor: 0, creditMinor: 0, byAccount: {} };
    for (const d of docs) for (const i of d.items) {
      t.items++;
      const a = (t.byAccount[i.sapAccount] ??= { debitMinor: 0, creditMinor: 0 });
      if (i.postingKey === '40') { t.debitMinor += i.amountMinor; a.debitMinor += i.amountMinor; } else { t.creditMinor += i.amountMinor; a.creditMinor += i.amountMinor; }
    }
    return t;
  }

  render(docs: SapDocument[], format: SapFormat, meta: { batchNo: string; createdAt: Date }): RenderedFile {
    const s = this.settings, x = this.exponent, amt = (n: number) => toDecimal(n, x);
    const stamp = meta.createdAt.toISOString().replace(/[-:]/g, '').slice(0, 15);
    let content: string, contentType: string, ext: string;
    if (format === 'FLAT') {
      const t = SapExporter.totals(docs);
      const rows = [`F|MERIDIAN|${meta.batchNo}|${meta.createdAt.toISOString()}|${s.companyCode}`];
      for (const d of docs) {
        rows.push(['H', s.companyCode, s.documentType, ymd(d.documentDate), ymd(d.postingDate), d.currency, d.reference, clip(d.headerText, 25), s.ledgerGroup].join('|'));
        for (const i of d.items) rows.push(['I', i.lineNo, i.postingKey, i.sapAccount, amt(i.amountMinor), i.taxCode, i.costCenter, i.profitCenter, clip(i.text, 50), clip(i.assignment, 18)].join('|'));
      }
      rows.push(`T|${t.documents}|${t.items}|${amt(t.debitMinor)}|${amt(t.creditMinor)}`);
      content = rows.join('\r\n') + '\r\n'; contentType = 'text/plain'; ext = 'txt';
    } else if (format === 'CSV') {
      const head = ['CompanyCode', 'PostingDate', 'DocType', 'DocumentRef', 'Currency', 'LineNo', 'PostingKey', 'GLAccount', 'DC', 'Amount', 'CostCenter', 'ProfitCenter', 'TaxCode', 'Text', 'Reference'];
      const rows = docs.flatMap((d) => d.items.map((i) => [s.companyCode, ymd(d.postingDate), s.documentType, d.reference, d.currency, i.lineNo, i.postingKey, i.sapAccount, i.postingKey === '40' ? 'D' : 'C', amt(i.amountMinor), i.costCenter, i.profitCenter, i.taxCode, i.text, i.assignment].map((v) => csvCell(String(v))).join(',')));
      content = [head.join(','), ...rows].join('\r\n') + '\r\n'; contentType = 'text/csv'; ext = 'csv';
    } else if (format === 'IDOC') {
      const esc = (v: string | number) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<FIDCCP02_BATCH>'];
      docs.forEach((d, n) => {
        parts.push('  <FIDCCP02>', '    <IDOC BEGIN="1">',
          `      <EDI_DC40 SEGMENT="1"><TABNAM>EDI_DC40</TABNAM><DIRECT>2</DIRECT><IDOCTYP>FIDCCP02</IDOCTYP><MESTYP>FIDCCH</MESTYP><SNDPRT>LS</SNDPRT><SNDPRN>MERIDIAN</SNDPRN><RCVPRT>LS</RCVPRT><RCVPRN>SAPGL</RCVPRN><DOCNUM>${esc(meta.batchNo.replace(/\D/g, '').padStart(8, '0') + String(n + 1).padStart(8, '0'))}</DOCNUM></EDI_DC40>`,
          `      <E1FIKPF SEGMENT="1"><BUKRS>${esc(s.companyCode)}</BUKRS><BLART>${esc(s.documentType)}</BLART><BLDAT>${ymd(d.documentDate)}</BLDAT><BUDAT>${ymd(d.postingDate)}</BUDAT><WAERS>${esc(d.currency)}</WAERS><XBLNR>${esc(d.reference)}</XBLNR><BKTXT>${esc(clip(d.headerText, 25))}</BKTXT>${s.ledgerGroup ? `<LDGRP>${esc(s.ledgerGroup)}</LDGRP>` : ''}</E1FIKPF>`);
        for (const i of d.items) parts.push(`      <E1FISEG SEGMENT="1"><BUZEI>${String(i.lineNo).padStart(3, '0')}</BUZEI><BSCHL>${i.postingKey}</BSCHL><HKONT>${esc(i.sapAccount)}</HKONT><WRBTR>${amt(i.amountMinor)}</WRBTR><MWSKZ>${esc(i.taxCode)}</MWSKZ><KOSTL>${esc(i.costCenter)}</KOSTL><PRCTR>${esc(i.profitCenter)}</PRCTR><SGTXT>${esc(i.text)}</SGTXT><ZUONR>${esc(i.assignment)}</ZUONR></E1FISEG>`);
        parts.push('    </IDOC>', '  </FIDCCP02>');
      });
      parts.push('</FIDCCP02_BATCH>');
      content = parts.join('\n') + '\n'; contentType = 'application/xml'; ext = 'xml';
    } else {
      const payload = {
        source: 'MERIDIAN', batch: meta.batchNo, createdAt: meta.createdAt.toISOString(),
        documents: docs.map((d) => ({
          DOCUMENTHEADER: { COMP_CODE: s.companyCode, DOC_TYPE: s.documentType, DOC_DATE: ymd(d.documentDate), PSTNG_DATE: ymd(d.postingDate), REF_DOC_NO: d.reference, HEADER_TXT: clip(d.headerText, 25), ...(s.ledgerGroup ? { LEDGER_GROUP: s.ledgerGroup } : {}) },
          ACCOUNTGL: d.items.map((i) => ({ ITEMNO_ACC: String(i.lineNo).padStart(10, '0'), GL_ACCOUNT: i.sapAccount, COSTCENTER: i.costCenter || undefined, PROFIT_CTR: i.profitCenter || undefined, TAX_CODE: i.taxCode || undefined, ITEM_TEXT: i.text, ALLOC_NMBR: i.assignment || undefined })),
          CURRENCYAMOUNT: d.items.map((i) => ({ ITEMNO_ACC: String(i.lineNo).padStart(10, '0'), CURRENCY: d.currency, AMT_DOCCUR: (i.postingKey === '40' ? '' : '-') + amt(i.amountMinor) })), // BAPI convention: debit positive, credit negative
        })),
      };
      content = JSON.stringify(payload, null, 2) + '\n'; contentType = 'application/json'; ext = 'json';
    }
    return { fileName: `meridian-gl-${meta.batchNo}-${stamp}.${ext}`, contentType, content, sha256: createHash('sha256').update(content).digest('hex') };
  }

  /** Reads a file back and totals what is actually in it, the way SAP would see it. Used by the reconciliation: it does not trust the batch's own totals. */
  static parse(content: string, format: SapFormat, exponent = 2): FileTotals {
    const docs: SapDocument[] = [];
    const item = (d: SapDocument, key: string, account: string, minor: number) => d.items.push({ lineNo: d.items.length + 1, postingKey: key === '40' ? '40' : '50', sapAccount: account, amountMinor: minor, costCenter: '', profitCenter: '', taxCode: '', text: '', assignment: '' });
    const blank = (ref: string): SapDocument => ({ reference: ref, postingDate: '', documentDate: '', currency: '', headerText: '', items: [] });
    if (format === 'FLAT') {
      let cur: SapDocument | null = null;
      for (const line of content.split(/\r?\n/)) {
        const f = line.split('|');
        if (f[0] === 'H') { cur = blank(f[6] ?? ''); docs.push(cur); } else if (f[0] === 'I' && cur) item(cur, f[2]!, f[3]!, fromDecimal(f[4]!, exponent));
      }
    } else if (format === 'CSV') {
      const rows = parseCsv(content);
      const head = rows[0]?.cells ?? [];
      const col = (n: string) => head.indexOf(n);
      const byRef = new Map<string, SapDocument>();
      for (const r of rows.slice(1)) {
        const ref = r.cells[col('DocumentRef')] ?? '';
        let d = byRef.get(ref);
        if (!d) { d = blank(ref); byRef.set(ref, d); docs.push(d); }
        item(d, r.cells[col('PostingKey')] ?? '', r.cells[col('GLAccount')] ?? '', fromDecimal(r.cells[col('Amount')] ?? '0', exponent));
      }
    } else if (format === 'IDOC') {
      for (const block of content.split('<FIDCCP02>').slice(1)) {
        const d = blank((/<XBLNR>(.*?)<\/XBLNR>/.exec(block)?.[1] ?? ''));
        docs.push(d);
        for (const m of block.matchAll(/<E1FISEG[^>]*>.*?<BSCHL>(\d+)<\/BSCHL><HKONT>(.*?)<\/HKONT><WRBTR>(.*?)<\/WRBTR>/g)) item(d, m[1]!, m[2]!.replace(/&amp;/g, '&'), fromDecimal(m[3]!, exponent));
      }
    } else {
      const j = JSON.parse(content) as { documents: Array<{ DOCUMENTHEADER: { REF_DOC_NO: string }; ACCOUNTGL: Array<{ GL_ACCOUNT: string }>; CURRENCYAMOUNT: Array<{ AMT_DOCCUR: string }> }> };
      for (const x of j.documents) {
        const d = blank(x.DOCUMENTHEADER.REF_DOC_NO);
        docs.push(d);
        x.ACCOUNTGL.forEach((a, n) => { const v = fromDecimal(x.CURRENCYAMOUNT[n]!.AMT_DOCCUR, exponent); item(d, v >= 0 ? '40' : '50', a.GL_ACCOUNT, Math.abs(v)); });
      }
    }
    return SapExporter.totals(docs);
  }
}

// ───────────────────────── delivery ─────────────────────────
export interface DeliveryResult { ok: boolean; reference?: string; detail: string }
export interface SapTransport {
  readonly kind: SapTransportKind;
  deliver(file: RenderedFile & { format: SapFormat }, ctx: { batchId: string; batchNo: string }): Promise<DeliveryResult>;
}
/** The file is for staff to download and load; nothing is sent. */
export class ManualTransport implements SapTransport {
  readonly kind = 'MANUAL' as const;
  async deliver(): Promise<DeliveryResult> { return { ok: true, detail: 'Ready to download. Nothing is sent automatically.' }; }
}
/** Posts the file to an https endpoint (an SAP Integration Suite flow, an API management gateway or a CPI iFlow) with a bearer token from MERIDIAN_SAP_TOKEN. */
export class RestTransport implements SapTransport {
  readonly kind = 'REST' as const;
  constructor(private readonly endpoint: string, private readonly token = process.env.MERIDIAN_SAP_TOKEN, private readonly fetchImpl: typeof fetch = fetch) {}
  async deliver(file: RenderedFile & { format: SapFormat }, ctx: { batchId: string; batchNo: string }): Promise<DeliveryResult> {
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST', signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': file.contentType, 'x-meridian-batch': ctx.batchNo, 'x-meridian-batch-id': ctx.batchId, 'x-meridian-sha256': file.sha256, 'idempotency-key': ctx.batchId, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: file.content,
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) return { ok: false, detail: `SAP endpoint answered ${res.status}: ${text.slice(0, 200)}` };
      let reference: string | undefined;
      try { const j = JSON.parse(text) as { reference?: string; documentNumber?: string }; reference = j.reference ?? j.documentNumber; } catch { /* a plain-text answer is fine */ }
      return { ok: true, reference, detail: `Delivered (${res.status})` };
    } catch (e) { return { ok: false, detail: `Could not reach the SAP endpoint: ${(e as Error).message}` }; }
  }
}
/** SFTP and RFC need a connector that is deployed with the integration, not with the CRM. Choosing them records the failure and leaves the file downloadable. */
export class UnsupportedTransport implements SapTransport {
  constructor(readonly kind: SapTransportKind) {}
  async deliver(): Promise<DeliveryResult> { return { ok: false, detail: `${this.kind} delivery needs a connector that is not set up in this deployment. The file is saved: download it and load it into SAP, or choose REST.` }; }
}
export function transportFor(s: SapSettings): SapTransport {
  if (s.transport === 'REST') return new RestTransport(s.endpoint);
  if (s.transport === 'SFTP' || s.transport === 'RFC') return new UnsupportedTransport(s.transport);
  return new ManualTransport();
}
