import { audit } from './audit.js';
import { assertParentFits, DEALER_TIERS, setDealerChannel } from './commission.js';
import { csvCell, parseCsv } from './csv.js';
import type { Db, Queryable, Row } from './db.js';
import { createAgent, createDealer, updateAgent, updateDealer } from './dealers.js';
import { invalid } from './errors.js';
import { getMarketSettings } from './settings.js';
import { createStore, updateStore } from './stores.js';

/**
 * Bulk loading of master data from a CSV file: dealers (with where they sit in the channel and how they are paid), their agents, and stores.
 * Each has a template to fill in and a download of what is there now, which can be edited and loaded back. A file is first CHECKED (nothing changes), and loads
 * only if every row is fine, all together. The system issues ids (DLR-00001, STORE-00001…): an empty id adds a new one, an id that exists updates it.
 * On an update a blank cell leaves the field as it is, and a single dash (-) clears it.
 */
export const BULK_MAX_ROWS = 5000;
export interface BulkRow { line: number; id: string; name: string; action: 'CREATE' | 'UPDATE'; status: 'OK' | 'ERROR' | 'SKIPPED'; message?: string }
export interface BulkResult { applied: boolean; canApply: boolean; rows: BulkRow[]; summary: { created: number; updated: number; errors: number; skipped: number } }

class RowError extends Error {}
class Rollback extends Error {}
const bad = (m: string): never => { throw new RowError(m); };

type Cells<K extends string> = { get: (k: K) => string; has: (k: K) => boolean };
const CLEAR = '-';
/** A cell on an update: undefined = leave, null = clear, text = set. */
const upd = (v: string): string | null | undefined => (v === '' ? undefined : v === CLEAR ? null : v);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const limit = (v: string, max: number, what: string) => { if (v.length > max) bad(`${what} is too long (at most ${max} characters).`); return v; };
const email = (v: string) => { if (v && v !== CLEAR && !EMAIL.test(v)) bad(`“${v}” is not an email address.`); return v; };
const statusOf = (v: string): 'ACTIVE' | 'INACTIVE' | undefined => {
  if (!v) return undefined;
  const t = v.trim().toUpperCase();
  if (t === 'ACTIVE' || t === 'ON') return 'ACTIVE';
  if (t === 'INACTIVE' || t === 'OFF') return 'INACTIVE';
  return bad('The status is ACTIVE or INACTIVE.');
};

interface Sheet<K extends string> { body: Array<{ line: number; cells: string[] }>; idx: Partial<Record<K, number>> }
function readSheet<K extends string>(text: string, aliases: Record<string, K>, required: K[], labels: Record<K, string>): Sheet<K> {
  const parsed = parseCsv(text).filter((r) => !(r.cells[0] ?? '').trimStart().startsWith('#') && r.cells.some((c) => c.trim()));
  if (!parsed.length) throw invalid('The file is empty. Download the template and fill it in.');
  const header = parsed[0]!.cells.map((c) => c.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const idx: Partial<Record<K, number>> = {};
  for (const [i, h] of header.entries()) {
    const k = aliases[h];
    if (!k) { if (h) throw invalid(`The column “${parsed[0]!.cells[i]!.trim()}” is not one this import knows. The columns are: ${[...new Set(Object.values(aliases))].map((c) => labels[c as K]).join(', ')}.`); continue; }
    if (idx[k] !== undefined) throw invalid(`The column ${labels[k]} appears twice.`);
    idx[k] = i;
  }
  const missing = required.filter((k) => idx[k] === undefined);
  if (missing.length) throw invalid(`The header row is missing ${missing.map((m) => labels[m]).join(', ')}. Download the template for the right header.`);
  const body = parsed.slice(1);
  if (!body.length) throw invalid('The file has a header but no rows.');
  if (body.length > BULK_MAX_ROWS) throw invalid(`A file can have at most ${BULK_MAX_ROWS} rows (this one has ${body.length}). Split it into several files.`);
  return { body, idx };
}

type Handler<K extends string> = (q: Queryable, c: Cells<K>, write: boolean, seen: Set<string>) => Promise<{ id: string; name: string; action: 'CREATE' | 'UPDATE' }>;

/**
 * Runs a sheet through a handler. Pass one is the check: updates are applied inside a transaction that is always undone, creates are only validated (so a check
 * never uses up an id from the system's counter). If asked to load and the check is clean, pass two does it for real, all in one transaction.
 */
async function runSheet<K extends string>(db: Db, sheet: Sheet<K>, o: { apply: boolean; actor: string; entity: string }, handler: Handler<K>): Promise<BulkResult> {
  const pass = async (write: boolean): Promise<BulkRow[]> => {
    const rows: BulkRow[] = [];
    const seen = new Set<string>();
    let n = 0;
    try {
      await db.tx(async (q) => {
        for (const src of sheet.body) {
          const cells: Cells<K> = { get: (k) => (sheet.idx[k] === undefined ? '' : (src.cells[sheet.idx[k]!] ?? '').trim()), has: (k) => sheet.idx[k] !== undefined };
          const row: BulkRow = { line: src.line, id: '', name: '', action: 'CREATE', status: 'OK' };
          rows.push(row);
          if (!src.cells.some((c) => c.trim())) { row.status = 'SKIPPED'; row.message = 'Empty row.'; continue; }
          const sp = `row${n++}`;
          await q.query(`SAVEPOINT ${sp}`);
          try {
            const r = await handler(q, cells, write, seen);
            Object.assign(row, r);
            await q.query(`RELEASE SAVEPOINT ${sp}`);
          } catch (e) {
            await q.query(`ROLLBACK TO SAVEPOINT ${sp}`);
            row.status = 'ERROR';
            row.message = e instanceof RowError ? e.message : (e as { details?: string[] }).details?.length ? (e as { details: string[] }).details.join('; ') : (e as Error).message;
          }
        }
        if (!write || rows.some((r) => r.status === 'ERROR')) throw new Rollback();
        await audit(q, o.actor, o.entity, 'import', 'IMPORTED', { created: rows.filter((r) => r.action === 'CREATE' && r.status === 'OK').length, updated: rows.filter((r) => r.action === 'UPDATE' && r.status === 'OK').length });
      });
    } catch (e) { if (!(e instanceof Rollback)) throw e; }
    return rows;
  };
  let rows = await pass(false);
  const count = (rs: BulkRow[]) => ({
    created: rs.filter((r) => r.action === 'CREATE' && r.status === 'OK').length, updated: rs.filter((r) => r.action === 'UPDATE' && r.status === 'OK').length,
    errors: rs.filter((r) => r.status === 'ERROR').length, skipped: rs.filter((r) => r.status === 'SKIPPED').length,
  });
  let summary = count(rows);
  let applied = false;
  if (o.apply) {
    if (summary.errors) throw invalid(`${summary.errors} ${summary.errors === 1 ? 'row has' : 'rows have'} a problem, so nothing was loaded. Fix ${summary.errors === 1 ? 'it' : 'them'} and try again.`);
    if (!summary.created && !summary.updated) throw invalid('There is nothing to load: every row was empty.');
    rows = await pass(true);
    summary = count(rows);
    if (summary.errors) throw invalid(`The file changed under us: ${rows.find((r) => r.status === 'ERROR')?.message}. Nothing was loaded; check it again.`);
    applied = true;
  }
  return { applied, canApply: summary.errors === 0 && summary.created + summary.updated > 0, rows, summary };
}

const sheetText = (head: string[], cols: string[], rows: string[][]) => [...head, cols.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
const STATUS_HELP = 'status: ACTIVE or INACTIVE (a new one is ACTIVE).';
const EDIT_HELP = 'An id that exists UPDATES it (a blank cell leaves the field as it is, a single - clears it); an empty id adds a new one with an id the system issues. Lines that start with # are ignored; keep the header row.';
const EXCEL_HELP = 'Opening in Excel? Format phone and account number columns as Text first, or Excel drops the + and leading zeros.';

// ───────────────────────── dealers ─────────────────────────
type DealerCol = 'id' | 'name' | 'contact' | 'email' | 'phone' | 'status' | 'tier' | 'parent' | 'bankName' | 'bankNo' | 'bankCode' | 'sap';
const DEALER_LABEL: Record<DealerCol, string> = { id: 'dealer_id', name: 'name', contact: 'contact_name', email: 'email', phone: 'phone', status: 'status', tier: 'tier', parent: 'parent_dealer_id', bankName: 'bank_account_name', bankNo: 'bank_account_no', bankCode: 'bank_code', sap: 'sap_vendor_no' };
const DEALER_ORDER = Object.keys(DEALER_LABEL) as DealerCol[];
const DEALER_ALIASES: Record<string, DealerCol> = { dealer_id: 'id', id: 'id', name: 'name', dealer_name: 'name', contact_name: 'contact', contact: 'contact', email: 'email', phone: 'phone', status: 'status', tier: 'tier', parent_dealer_id: 'parent', parent: 'parent', bank_account_name: 'bankName', bank_account_no: 'bankNo', bank_code: 'bankCode', sap_vendor_no: 'sap', sap_vendor: 'sap' };
const CHANNEL_COLS: DealerCol[] = ['tier', 'parent', 'bankName', 'bankNo', 'bankCode', 'sap'];

export async function dealersFile(q: Queryable, o: { withData?: boolean; actor?: string; channel: boolean }): Promise<string> {
  const head = [
    '# Meridian dealers. ' + EDIT_HELP,
    `# tier: ${DEALER_TIERS.join(', ')} (default DEALER). parent_dealer_id: the dealer above this one in the channel (an existing dealer id), at most six levels. Load parents before their sub-dealers.`,
    '# tier, parent and the bank and SAP columns need the permission to configure commission; leave them empty otherwise. ' + STATUS_HELP,
    '# ' + EXCEL_HELP,
    '# Example: ,Metro Distribution,Alex Lim,alex@metro.example,+6591234567,ACTIVE,MASTER_DISTRIBUTOR,,Metro Distribution Pte Ltd,0011223344,DBS,V10001',
  ];
  const rows: string[][] = [];
  if (o.withData) {
    for (const r of (await q.query(`SELECT * FROM dealers ORDER BY id LIMIT ${BULK_MAX_ROWS}`)).rows as Row[]) {
      const v: Record<DealerCol, string> = { id: r.id, name: r.name, contact: r.contactName ?? '', email: r.email ?? '', phone: r.phone ?? '', status: r.status, tier: r.tier, parent: r.parentDealerId ?? '', bankName: r.bankAccountName ?? '', bankNo: r.bankAccountNo ?? '', bankCode: r.bankCode ?? '', sap: r.sapVendorNo ?? '' };
      if (!o.channel) for (const c of ['bankName', 'bankNo', 'bankCode', 'sap'] as DealerCol[]) v[c] = '';
      rows.push(DEALER_ORDER.map((c) => v[c]));
    }
    if (o.actor) await audit(q, o.actor, 'dealer', 'export', 'EXPORTED', { rows: rows.length, bankDetails: o.channel });
  }
  return sheetText(head, DEALER_ORDER.map((c) => DEALER_LABEL[c]), rows);
}

export async function importDealers(db: Db, text: string, o: { apply: boolean; actor: string; channel: boolean }): Promise<BulkResult> {
  const sheet = readSheet(text, DEALER_ALIASES, ['name'], DEALER_LABEL);
  return runSheet(db, sheet, { ...o, entity: 'dealer' }, async (q, c, write, seen) => {
    const id = c.get('id').toUpperCase();
    const existing = id ? (await q.query('SELECT * FROM dealers WHERE id=$1', [id])).rows[0] : null;
    if (id && !existing) bad(`Dealer ${id} does not exist. Dealer ids are issued by the system: leave dealer_id empty to add a new dealer.`);
    if (id && seen.has(id)) bad(`Dealer ${id} appears twice in this file.`);
    if (id) seen.add(id);
    const name = limit(c.get('name'), 120, 'The name');
    if (!existing && !name) bad('A new dealer needs a name.');
    if (name === CLEAR) bad('A dealer must keep a name.');
    const contact = upd(limit(c.get('contact'), 120, 'The contact name')), mail = upd(email(limit(c.get('email'), 200, 'The email'))), phone = upd(limit(c.get('phone'), 40, 'The phone number'));
    const status = statusOf(c.get('status'));
    const channel: Record<string, string | null | undefined> = {
      bankAccountName: upd(limit(c.get('bankName'), 120, 'The account name')), bankAccountNo: upd(limit(c.get('bankNo'), 60, 'The account number')), bankCode: upd(limit(c.get('bankCode'), 30, 'The bank code')), sapVendorNo: upd(limit(c.get('sap'), 30, 'The SAP vendor number')),
    };
    const tierRaw = c.get('tier').toUpperCase().replace(/[\s-]+/g, '_');
    if (tierRaw && !(DEALER_TIERS as readonly string[]).includes(tierRaw)) bad(`The tier is one of ${DEALER_TIERS.join(', ')}.`);
    const parent = upd(c.get('parent').toUpperCase());
    const touchesChannel = !!tierRaw || parent !== undefined || Object.values(channel).some((v) => v !== undefined);
    if (touchesChannel && !o.channel) bad('Changing the tier, parent, bank or SAP details needs the permission to configure commission. Leave those cells empty.');
    if (parent) await assertParentFits(q, existing ? id : null, parent).catch((e) => bad(`Parent ${parent}: ${(e as Error).message}`));
    if (!existing && name) { if (seen.has(`name:${name.toLowerCase()}`)) bad(`A new dealer called ${name} appears twice in this file.`); seen.add(`name:${name.toLowerCase()}`); }
    const chan = { ...(tierRaw ? { tier: tierRaw } : {}), ...(parent !== undefined ? { parentDealerId: parent } : {}), ...channel } as Parameters<typeof setDealerChannel>[3];
    if (existing) {
      await updateDealer(q, o.actor, id, { ...(name ? { name } : {}), ...(contact !== undefined ? { contactName: contact as string } : {}), ...(mail !== undefined ? { email: mail as string } : {}), ...(phone !== undefined ? { phone: phone as string } : {}), ...(status ? { status } : {}) });
      if (touchesChannel) await setDealerChannel(q, o.actor, id, chan);
      return { id, name: name || existing.name, action: 'UPDATE' };
    }
    if (!write) return { id: '', name, action: 'CREATE' }; // the check never uses up an id from the counter
    const made = await createDealer(q, o.actor, { name, contactName: contact ?? undefined, email: mail ?? undefined, phone: phone ?? undefined });
    if (status === 'INACTIVE') await updateDealer(q, o.actor, made.id as string, { status });
    if (touchesChannel) await setDealerChannel(q, o.actor, made.id as string, chan);
    return { id: made.id as string, name, action: 'CREATE' };
  });
}

// ───────────────────────── agents ─────────────────────────
type AgentCol = 'id' | 'dealer' | 'name' | 'email' | 'phone' | 'status';
const AGENT_LABEL: Record<AgentCol, string> = { id: 'agent_id', dealer: 'dealer_id', name: 'name', email: 'email', phone: 'phone', status: 'status' };
const AGENT_ORDER = Object.keys(AGENT_LABEL) as AgentCol[];
const AGENT_ALIASES: Record<string, AgentCol> = { agent_id: 'id', id: 'id', dealer_id: 'dealer', dealer: 'dealer', name: 'name', agent_name: 'name', email: 'email', phone: 'phone', status: 'status' };

export async function agentsFile(q: Queryable, o: { withData?: boolean; actor?: string; dealerId?: string | null }): Promise<string> {
  const head = [
    '# Meridian dealer agents. ' + EDIT_HELP,
    '# dealer_id: the dealer the agent sells for (an existing, active dealer). An agent stays with its dealer: to move one, switch it off and add a new one. ' + STATUS_HELP,
    '# ' + EXCEL_HELP,
    '# Example: ,DLR-00001,Priya Nair,priya@metro.example,+6591234568,ACTIVE',
  ];
  const rows: string[][] = [];
  if (o.withData) {
    for (const r of (await q.query(`SELECT * FROM dealer_agents WHERE ($1::text IS NULL OR dealer_id=$1) ORDER BY id LIMIT ${BULK_MAX_ROWS}`, [o.dealerId ?? null])).rows as Row[]) rows.push([r.id, r.dealerId, r.name, r.email ?? '', r.phone ?? '', r.status]);
    if (o.actor) await audit(q, o.actor, 'dealer_agent', 'export', 'EXPORTED', { rows: rows.length });
  }
  return sheetText(head, AGENT_ORDER.map((c) => AGENT_LABEL[c]), rows);
}

/** `dealerId` limits the file to one dealer, for a dealer's own login. */
export async function importAgents(db: Db, text: string, o: { apply: boolean; actor: string; dealerId?: string | null }): Promise<BulkResult> {
  const sheet = readSheet(text, AGENT_ALIASES, ['name'], AGENT_LABEL);
  return runSheet(db, sheet, { ...o, entity: 'dealer_agent' }, async (q, c, write, seen) => {
    const id = c.get('id').toUpperCase();
    const existing = id ? (await q.query('SELECT * FROM dealer_agents WHERE id=$1', [id])).rows[0] : null;
    if (id && !existing) bad(`Agent ${id} does not exist. Agent ids are issued by the system: leave agent_id empty to add a new agent.`);
    if (id && seen.has(id)) bad(`Agent ${id} appears twice in this file.`);
    if (id) seen.add(id);
    const dealerId = (existing ? existing.dealerId : c.get('dealer').toUpperCase()) as string;
    if (existing && c.get('dealer') && c.get('dealer').toUpperCase() !== existing.dealerId) bad(`Agent ${id} belongs to ${existing.dealerId}; an agent cannot move to another dealer. Switch it off and add a new one.`);
    if (o.dealerId && dealerId !== o.dealerId) bad('You can only load agents for your own dealer.');
    const name = limit(c.get('name'), 120, 'The name');
    if (name === CLEAR || (!existing && !name)) bad(existing ? 'An agent must keep a name.' : 'A new agent needs a name.');
    const mail = upd(email(limit(c.get('email'), 200, 'The email'))), phone = upd(limit(c.get('phone'), 40, 'The phone number'));
    const status = statusOf(c.get('status'));
    if (existing) {
      await updateAgent(q, o.actor, id, { ...(name ? { name } : {}), ...(mail !== undefined ? { email: mail as string } : {}), ...(phone !== undefined ? { phone: phone as string } : {}), ...(status ? { status } : {}) });
      return { id, name: name || existing.name, action: 'UPDATE' };
    }
    if (!dealerId) bad('A new agent needs a dealer_id.');
    const d = (await q.query('SELECT status FROM dealers WHERE id=$1', [dealerId])).rows[0];
    if (!d) bad(`Dealer ${dealerId} does not exist.`);
    if (d!.status !== 'ACTIVE') bad(`Dealer ${dealerId} is inactive.`);
    if (!write) return { id: '', name, action: 'CREATE' };
    const made = await createAgent(q, o.actor, dealerId, { name, email: mail ?? undefined, phone: phone ?? undefined });
    if (status === 'INACTIVE') await updateAgent(q, o.actor, made.id as string, { status });
    return { id: made.id as string, name, action: 'CREATE' };
  });
}

// ───────────────────────── stores ─────────────────────────
type StoreCol = 'id' | 'name' | 'address' | 'phone' | 'status' | 'market';
const STORE_LABEL: Record<StoreCol, string> = { id: 'store_id', name: 'name', address: 'address', phone: 'phone', status: 'status', market: 'market_code' };
const STORE_ORDER = Object.keys(STORE_LABEL) as StoreCol[];
const STORE_ALIASES: Record<string, StoreCol> = { store_id: 'id', id: 'id', name: 'name', store_name: 'name', address: 'address', phone: 'phone', status: 'status', market_code: 'market', market: 'market' };

export async function storesFile(q: Queryable, o: { withData?: boolean; actor?: string }): Promise<string> {
  const multi = (await getMarketSettings(q)).multiple;
  const head = [
    '# Meridian stores. ' + EDIT_HELP,
    '# name: each store has its own name. ' + STATUS_HELP + (multi ? ' market_code: the two-letter code of the market the store sells in.' : ' market_code is only used when several markets are switched on: leave it empty.'),
    '# ' + EXCEL_HELP,
    '# Example: ,Orchard Flagship,"391 Orchard Road, Singapore",+6561234567,ACTIVE,',
  ];
  const rows: string[][] = [];
  if (o.withData) {
    for (const r of (await q.query(`SELECT * FROM stores ORDER BY id LIMIT ${BULK_MAX_ROWS}`)).rows as Row[]) rows.push([r.id, r.name, r.address ?? '', r.phone ?? '', r.status, multi && r.marketCode ? String(r.marketCode).trim() : '']);
    if (o.actor) await audit(q, o.actor, 'store', 'export', 'EXPORTED', { rows: rows.length });
  }
  return sheetText(head, STORE_ORDER.map((c) => STORE_LABEL[c]), rows);
}

export async function importStores(db: Db, text: string, o: { apply: boolean; actor: string }): Promise<BulkResult> {
  const sheet = readSheet(text, STORE_ALIASES, ['name'], STORE_LABEL);
  const mset = await getMarketSettings(db);
  return runSheet(db, sheet, { ...o, entity: 'store' }, async (q, c, write, seen) => {
    const id = c.get('id').toUpperCase();
    const existing = id ? (await q.query('SELECT * FROM stores WHERE upper(id)=$1', [id])).rows[0] : null;
    if (id && !existing) bad(`Store ${id} does not exist. Store ids are issued by the system: leave store_id empty to add a new store.`);
    const key = existing ? (existing.id as string) : '';
    if (key && seen.has(key)) bad(`Store ${key} appears twice in this file.`);
    if (key) seen.add(key);
    const name = limit(c.get('name'), 120, 'The name');
    if (name === CLEAR || (!existing && !name)) bad(existing ? 'A store must keep a name.' : 'A new store needs a name.');
    const address = upd(limit(c.get('address'), 300, 'The address')), phone = upd(limit(c.get('phone'), 40, 'The phone number'));
    const status = statusOf(c.get('status'));
    const mk = c.get('market').toUpperCase();
    if (mk && mk !== CLEAR) {
      if (!mset.multiple) bad('Several markets are not switched on, so market_code must be empty.');
      if (!mset.markets.some((m) => m.code === mk)) bad(`Market ${mk} is not one of: ${mset.markets.map((m) => m.code).join(', ')}.`);
    }
    if (name) {
      const clash = (await q.query('SELECT id FROM stores WHERE lower(name)=lower($1) AND ($2::text IS NULL OR id <> $2)', [name, existing?.id ?? null])).rows[0];
      if (clash) bad(`There is already a store called ${name} (${clash.id}).`);
      if (seen.has(`name:${name.toLowerCase()}`)) bad(`A store called ${name} appears twice in this file.`);
      seen.add(`name:${name.toLowerCase()}`);
    }
    const marketCode = mk === CLEAR ? '' : mk || undefined;
    if (existing) {
      await updateStore(q, o.actor, existing.id as string, { ...(name ? { name } : {}), ...(address !== undefined ? { address: address ?? '' } : {}), ...(phone !== undefined ? { phone: phone ?? '' } : {}), ...(status ? { status } : {}), ...(marketCode !== undefined ? { marketCode } : {}) });
      return { id: existing.id as string, name: name || (existing.name as string), action: 'UPDATE' };
    }
    if (!write) return { id: '', name, action: 'CREATE' };
    const made = await createStore(q, o.actor, { name, address: address ?? undefined, phone: phone ?? undefined, marketCode });
    if (status === 'INACTIVE') await updateStore(q, o.actor, made.id as string, { status });
    return { id: made.id as string, name, action: 'CREATE' };
  });
}
