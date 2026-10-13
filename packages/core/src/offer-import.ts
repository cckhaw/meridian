import { fromPlain, toPlain, TEMPLATES, type OfferNode, type OfferTemplate, type RegionalSettings } from '@meridian/types';
import { audit } from './audit.js';
import { createNode, getOffer, moveNode, setStatus, updateNode, type NodeInput, type NodePatch } from './catalog.js';
import { MARKETS } from './config.js';
import { csvCell, parseCsv } from './csv.js';
import type { Db, Queryable } from './db.js';
import { invalid } from './errors.js';
import { listFulfilmentOptions, listOfferTypes } from './offer-config.js';
import { CHANNELS } from './rbac.js';
import { getRegional } from './settings.js';

export const OFFER_IMPORT_MAX_ROWS = 1000;
type Col = 'group' | 'id' | 'name' | 'type' | 'description' | 'monthly' | 'upfront' | 'tax' | 'term' | 'free' | 'etc' | 'subsidy' | 'retail' | 'fulfilment' | 'skus' | 'variants' | 'deals' | 'channels' | 'requires' | 'excludes' | 'partner' | 'market' | 'status' | 'golive';
/** Header names (as written in the template, plus a few natural variants) -> the column they mean. */
const HEADERS: Record<string, Col> = {
  group_id: 'group', group: 'group', offer_id: 'id', id: 'id', name: 'name', offer_name: 'name', type: 'type', offer_type: 'type', description: 'description',
  monthly_fee: 'monthly', monthly: 'monthly', upfront_price: 'upfront', upfront: 'upfront', price: 'upfront', prices_include_tax: 'tax', tax_inclusive: 'tax',
  contract_months: 'term', contract: 'term', contract_free_months: 'free', etc_percent: 'etc', subsidy: 'subsidy', device_retail_price: 'retail', retail_price: 'retail',
  fulfilment: 'fulfilment', fulfilment_options: 'fulfilment', stock_skus: 'skus', skus: 'skus', colours_storage: 'variants', variants: 'variants', device_contracts: 'deals', deals: 'deals',
  channels: 'channels', sold_through: 'channels', requires: 'requires', excludes: 'excludes', partner_code: 'partner', partner: 'partner', market: 'market', country: 'market', status: 'status', go_live_date: 'golive', active_from: 'golive',
};
/** The order of the columns in the template and in an export. */
const ORDER: Array<[string, Col]> = [
  ['group_id', 'group'], ['offer_id', 'id'], ['name', 'name'], ['type', 'type'], ['description', 'description'], ['monthly_fee', 'monthly'], ['upfront_price', 'upfront'], ['prices_include_tax', 'tax'],
  ['contract_months', 'term'], ['contract_free_months', 'free'], ['etc_percent', 'etc'], ['subsidy', 'subsidy'], ['device_retail_price', 'retail'], ['fulfilment', 'fulfilment'], ['stock_skus', 'skus'],
  ['colours_storage', 'variants'], ['device_contracts', 'deals'], ['channels', 'channels'], ['requires', 'requires'], ['excludes', 'excludes'], ['partner_code', 'partner'], ['market', 'market'], ['status', 'status'], ['go_live_date', 'golive'],
];

export interface OfferImportRow { line: number; id: string; name: string; action: 'CREATE' | 'UPDATE'; status: 'OK' | 'ERROR' | 'SKIPPED'; message?: string }
export interface OfferImportResult { applied: boolean; canApply: boolean; rows: OfferImportRow[]; summary: { created: number; updated: number; errors: number; skipped: number } }

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const list = (v: string) => v.split('|').map((x) => x.trim()).filter(Boolean);
const yes = (v: string): boolean | null => (/^(y|yes|true|1)$/i.test(v) ? true : /^(n|no|false|0)$/i.test(v) ? false : null);
/** The fulfilment options an offer has; offers saved before options existed carry only the flags, which are the built-in options. */
const optionsOf = (f?: OfferNode['fulfilment']): string[] => f?.options ?? [f?.requiresShipping && 'SHIP', f?.requiresCollection && 'COLLECT', f?.requiresInstallation && 'INSTALL', f?.requiresSimActivation && 'SIM'].filter(Boolean) as string[];
class RowError extends Error {}
const bad = (m: string): never => { throw new RowError(m); };

const amount = (v: string, what: string, r: Pick<RegionalSettings, 'exponent' | 'currency'>): number => {
  if (!/^\d+(\.\d+)?$/.test(v)) bad(`${what}: “${v}” is not an amount. Write it like 12.50, without a currency symbol or thousands separators.`);
  if ((v.split('.')[1]?.length ?? 0) > r.exponent) bad(`${what}: ${r.currency} has ${r.exponent} decimal places.`);
  return fromPlain(v, r);
};
const whole = (v: string, what: string, min: number, max: number): number => {
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) bad(`${what}: “${v}” should be a whole number from ${min} to ${max}.`);
  return Number(v);
};

interface Ctx { regional: RegionalSettings; types: Map<string, { template: OfferTemplate; active: boolean }>; options: Map<string, { mechanic: string; active: boolean }>; groups: Set<string> }

/** What one CSV row asks for, as a new offer or as changes to an existing one. A blank cell on an existing offer means "leave as it is". */
function plan(get: (c: Col) => string, has: (c: Col) => boolean, ctx: Ctx, existing: OfferNode | null, id: string): { input?: NodeInput; patch?: NodePatch; group?: string; status?: string; goLive?: string } {
  const r = ctx.regional;
  const cell = (c: Col) => (has(c) ? get(c) : '');
  const group = cell('group'), typeId = cell('type');
  if (group && !ctx.groups.has(group)) bad(`Unknown group “${group}”. Use a group id from the template (the group, not a category or network type).`);
  let template: OfferTemplate | null = null;
  if (typeId) {
    const t = ctx.types.get(typeId) ?? ctx.types.get(typeId.toUpperCase());
    if (!t) bad(`Unknown offer type “${typeId}”. Use one of the type ids listed in the template.`);
    if (!t!.active && (!existing || existing.kind !== typeId)) bad(`Offer type “${typeId}” is switched off.`);
    template = t!.template;
  } else if (existing) template = (ctx.types.get(existing.kind)?.template ?? (existing.template as OfferTemplate | undefined) ?? (existing.kind as OfferTemplate)) ?? null;
  else bad('Choose the offer type.');
  const tpl = TEMPLATES[template!] ?? bad('This offer has an unknown type.');
  const taxText = cell('tax');
  const tax = taxText ? yes(taxText) : null;
  if (taxText && tax === null) bad(`prices_include_tax: write yes or no (not “${taxText}”).`);

  // prices: only the ones given are touched on an existing offer
  const monthly = cell('monthly'), upfront = cell('upfront');
  const prices = [...(existing?.prices ?? [])].map((p) => ({ ...p }));
  const setPrice = (type: 'RECURRING' | 'ONE_TIME', v: string, what: string) => {
    const minor = amount(v, what, r);
    const cur = prices.find((p) => p.type === type);
    if (cur) cur.amount = { amountMinor: minor, currency: r.currency };
    else prices.push({ type, amount: { amountMinor: minor, currency: r.currency }, taxInclusive: tax ?? true, ...(type === 'RECURRING' ? { periodMonths: 1 } : {}) } as never);
  };
  if (monthly) setPrice('RECURRING', monthly, 'monthly_fee');
  if (upfront) setPrice('ONE_TIME', upfront, 'upfront_price');
  if (tax !== null) for (const p of prices) p.taxInclusive = tax;
  const pricesGiven = !!(monthly || upfront || tax !== null);

  // contract: given as a term (and, for a device, a subsidy)
  const termText = cell('term');
  let contract: OfferNode['contract'] | undefined;
  if (termText || (!existing && !tpl.contract) || (!existing && tpl.contract === 'none')) {
    const term = termText ? whole(termText, 'contract_months', 0, 36) : 0;
    if (term && ![12, 24, 36].includes(term)) bad('contract_months: use 0, 12, 24 or 36.');
    if (term && tpl.contract === 'none') bad('This type of offer is sold without a contract (leave contract_months empty or 0).');
    const subsidy = cell('subsidy');
    const free = cell('free') ? whole(cell('free'), 'contract_free_months', 0, 35) : 1;
    contract = term === 0 ? { termMonths: 0 } : subsidy
      ? { termMonths: term as 12 | 24 | 36, etc: { method: 'SUBSIDY_AMORTISED', waiveInLastMonths: free }, subsidy: { subsidyAmount: { amountMinor: amount(subsidy, 'subsidy', r), currency: r.currency }, deviceRetailPrice: { amountMinor: cell('retail') ? amount(cell('retail'), 'device_retail_price', r) : bad('A device on contract needs device_retail_price with the subsidy.'), currency: r.currency } } }
      : { termMonths: term as 12 | 24 | 36, etc: { method: 'REMAINING_RECURRING_PERCENT', percentOfRemaining: cell('etc') ? whole(cell('etc'), 'etc_percent', 0, 100) : 50, waiveInLastMonths: free } };
  }

  // fulfilment: option ids; a new offer gets its type's usual options like the wizard does
  const optText = cell('fulfilment');
  let fulfilment: OfferNode['fulfilment'] | undefined;
  const skus = list(cell('skus').replace(/;/g, '|'));
  if (optText || skus.length || !existing) {
    let optIds = list(optText);
    for (const o of optIds) { const f = ctx.options.get(o); if (!f) bad(`Unknown fulfilment option “${o}”. Use the ids listed in the template.`); if (!f!.active && !(existing?.fulfilment?.options ?? []).includes(o)) bad(`Fulfilment option “${o}” is switched off.`); }
    if (!optText && !existing) optIds = tpl.defaults.map((m) => [...ctx.options].find(([, f]) => f.mechanic === m && f.active)?.[0]).filter(Boolean) as string[];
    fulfilment = { options: optText || !existing ? optIds : optionsOf(existing!.fulfilment), inventorySkus: skus.length || !existing ? skus : existing!.fulfilment?.inventorySkus ?? [] } as never;
  }

  const variants = cell('variants') ? list(cell('variants')).map((v) => {
    const [colour = '', storage = '', sku = '', delta = ''] = v.split('/').map((x) => x.trim());
    if (!colour || !sku) bad(`colours_storage: “${v}” should look like Colour/Storage/SKU/price difference (storage and difference may be empty).`);
    return { id: slug(`${colour}-${storage}`) || slug(sku), colour, storage: storage || undefined, sku, priceDeltaMinor: delta ? (delta.startsWith('-') ? -amount(delta.slice(1), 'price difference', r) : amount(delta, 'price difference', r)) : undefined };
  }) : undefined;
  const deals = cell('deals') ? list(cell('deals')).map((d) => {
    const [term = '', sub = '', free = ''] = d.split(':').map((x) => x.trim());
    if (!term || !sub) bad(`device_contracts: “${d}” should look like months:subsidy (for example 24:400), optionally :free months.`);
    return { termMonths: whole(term, 'device_contracts months', 12, 36), subsidyMinor: amount(sub, 'device_contracts subsidy', r), ...(free ? { waiveInLastMonths: whole(free, 'device_contracts free months', 0, 35) } : {}) };
  }) : undefined;
  const channels = cell('channels') ? list(cell('channels')).map((c) => c.toUpperCase()) : undefined;
  for (const c of channels ?? []) if (!(CHANNELS as readonly string[]).includes(c)) bad(`Unknown channel “${c}”. Use ${CHANNELS.join(', ')}.`);
  const market = cell('market').toUpperCase();
  if (market && !/^[A-Z]{2}$/.test(market)) bad('market: use a two-letter country code such as SG.');
  const status = cell('status').toUpperCase();
  if (status && !['DRAFT', 'SCHEDULED', 'ACTIVE', 'RETIRED'].includes(status)) bad('status: use DRAFT, SCHEDULED or ACTIVE.');
  if (status === 'RETIRED' && !existing) bad('A new offer cannot start retired.');
  const goLive = cell('golive');
  if (status === 'SCHEDULED' && !/^\d{4}-\d{2}-\d{2}$/.test(goLive)) bad('A scheduled offer needs go_live_date as YYYY-MM-DD.');
  if (goLive && status !== 'SCHEDULED') bad('go_live_date only goes with status SCHEDULED.');

  const common = {
    description: cell('description') || undefined, ...(pricesGiven || !existing ? { prices } : {}), ...(contract ? { contract } : {}), ...(fulfilment ? { fulfilment } : {}),
    ...(cell('partner') ? { partnerCode: cell('partner') } : {}), ...(cell('requires') ? { requires: list(cell('requires')) } : {}), ...(cell('excludes') ? { excludes: list(cell('excludes')) } : {}),
    ...(channels ? { salesChannels: channels } : {}), ...(variants ? { variants } : {}), ...(deals ? { deals } : {}),
  };
  if (existing) return { patch: { ...(cell('name') ? { name: cell('name') } : {}), ...(typeId ? { kind: typeId } : {}), ...(market ? { markets: [market] } : {}), ...common } as NodePatch, group: group || undefined, status: status || undefined, goLive };
  if (!group) bad('Choose the group the offer belongs to (group_id).');
  if (!cell('name')) bad('Give the offer a name.');
  const country = market || (MARKETS[ctx.regional.country] ? ctx.regional.country : '');
  return {
    input: { id, level: 'OFFER', code: id, name: cell('name'), path: '', parentId: group, status: 'DRAFT', kind: typeId, markets: country ? [country] : [], characteristics: {}, requires: [], excludes: [], ...common } as unknown as NodeInput,
    status: status || undefined, goLive,
  };
}

class Rollback extends Error {}

/**
 * Checks an offers file, and with `apply` loads it. The offer id is the key: a row whose id already exists updates that offer (blank cells leave a
 * field as it is), any other row creates one. Both paths run the same code the offer form uses, so every rule it enforces holds here too; the check is
 * that code run inside a transaction that is always undone. The file loads only if every row is valid, and then all together.
 */
export async function importOffers(db: Db, text: string, o: { apply: boolean; actor: string }): Promise<OfferImportResult> {
  const parsed = parseCsv(text).filter((r) => !(r.cells[0] ?? '').trimStart().startsWith('#') && r.cells.some((c) => c.trim()));
  if (!parsed.length) throw invalid('The file is empty. Download the template and fill it in.');
  const header = parsed[0]!.cells.map((c) => c.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const idx: Partial<Record<Col, number>> = {};
  header.forEach((h, i) => { const k = HEADERS[h]; if (k && idx[k] === undefined) idx[k] = i; });
  const missing = (['group', 'name', 'type'] as const).filter((k) => idx[k] === undefined);
  if (missing.length) throw invalid(`The header row needs group_id, name and type (and usually monthly_fee or upfront_price). Missing: ${missing.map((m) => (m === 'group' ? 'group_id' : m)).join(', ')}. Found: ${header.join(', ') || 'nothing'}.`);
  const body = parsed.slice(1);
  if (!body.length) throw invalid('The file has a header but no rows.');
  if (body.length > OFFER_IMPORT_MAX_ROWS) throw invalid(`A file can have at most ${OFFER_IMPORT_MAX_ROWS} offers (this one has ${body.length}). Split it into several files.`);

  const regional = await getRegional(db);
  const ctx: Ctx = {
    regional,
    types: new Map((await listOfferTypes(db)).map((t) => [t.id, { template: t.template, active: t.status === 'ACTIVE' }])),
    options: new Map((await listFulfilmentOptions(db)).map((f) => [f.id, { mechanic: f.mechanic, active: f.status === 'ACTIVE' }])),
    groups: new Set((await db.query(`SELECT id FROM catalog_nodes WHERE level='GROUP'`)).rows.map((r) => r.id as string)),
  };
  const rows: OfferImportRow[] = [];
  const seen = new Map<string, number>();
  const tx = async () => db.tx(async (q) => {
    let n = 0;
    for (const src of body) {
      const get = (c: Col) => (idx[c] === undefined ? '' : (src.cells[idx[c]!] ?? '').trim());
      const has = (c: Col) => idx[c] !== undefined;
      const name = get('name');
      const id = get('id') || slug(name);
      const row: OfferImportRow = { line: src.line, id, name, action: 'CREATE', status: 'OK' };
      rows.push(row);
      if (!get('group') && !name && !get('type') && !get('id')) { row.status = 'SKIPPED'; row.message = 'Empty row.'; continue; }
      const sp = `row${n++}`;
      await q.query(`SAVEPOINT ${sp}`);
      try {
        if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(id)) bad(id ? `Offer id “${id}” may only contain lowercase letters, digits and dashes.` : 'Give the offer a name (or an offer_id).');
        if (seen.has(id)) bad(`Offer ${id} is already on line ${seen.get(id)}. Each offer can appear once.`);
        const found = (await q.query(`SELECT level FROM catalog_nodes WHERE id=$1`, [id])).rows[0];
        if (found && found.level !== 'OFFER') bad(`“${id}” is already used by a ${String(found.level).toLowerCase().replace('_', ' ')}. Choose another offer_id.`);
        const existing = found ? await getOffer(q, id) : null;
        row.action = existing ? 'UPDATE' : 'CREATE';
        if (existing) row.name = existing.name;
        const p = plan(get, has, ctx, existing, id);
        if (p.input) {
          const node = await createNode(q, p.input, o.actor);
          if (p.status && p.status !== 'DRAFT') await setStatus(q, node.id, p.status as 'ACTIVE' | 'SCHEDULED', o.actor, p.goLive ? new Date(`${p.goLive}T00:00:00Z`).toISOString() : undefined);
        } else {
          if (p.group && p.group !== existing!.parentId) await moveNode(q, id, p.group, o.actor);
          if (Object.keys(p.patch ?? {}).length) await updateNode(q, id, p.patch!, o.actor);
          if (p.status && (p.status !== existing!.status || p.status === 'SCHEDULED')) await setStatus(q, id, p.status as 'ACTIVE', o.actor, p.goLive ? new Date(`${p.goLive}T00:00:00Z`).toISOString() : undefined);
        }
        seen.set(id, src.line);
        await q.query(`RELEASE SAVEPOINT ${sp}`);
      } catch (e) {
        await q.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        row.status = 'ERROR';
        const d = (e as { details?: unknown }).details;
        row.message = e instanceof RowError ? e.message : Array.isArray(d) && d.length ? d.join('; ') : (e as Error).message;
      }
    }
    const errors = rows.some((r) => r.status === 'ERROR');
    if (!o.apply || errors || !rows.some((r) => r.status === 'OK')) throw new Rollback();
    await audit(q, o.actor, 'catalog', 'import', 'OFFERS_IMPORTED', { created: rows.filter((r) => r.action === 'CREATE' && r.status === 'OK').length, updated: rows.filter((r) => r.action === 'UPDATE' && r.status === 'OK').length });
  });
  let applied = false;
  try { await tx(); applied = o.apply; } catch (e) { if (!(e instanceof Rollback)) throw e; }
  const summary = {
    created: rows.filter((r) => r.action === 'CREATE' && r.status === 'OK').length, updated: rows.filter((r) => r.action === 'UPDATE' && r.status === 'OK').length,
    errors: rows.filter((r) => r.status === 'ERROR').length, skipped: rows.filter((r) => r.status === 'SKIPPED').length,
  };
  if (o.apply && !applied) {
    if (summary.errors) throw invalid(`${summary.errors} ${summary.errors === 1 ? 'row has' : 'rows have'} a problem, so nothing was loaded. Fix ${summary.errors === 1 ? 'it' : 'them'} and try again.`);
    throw invalid('There is nothing to load: every row was empty.');
  }
  return { applied, canApply: summary.errors === 0 && summary.created + summary.updated > 0, rows, summary };
}

/** One offer as a CSV row, the inverse of what the importer reads (so an export can be edited and loaded back). */
function offerRow(n: OfferNode, r: Pick<RegionalSettings, 'exponent'>): Record<Col, string> {
  const rec = n.prices.find((p) => p.type === 'RECURRING'), once = n.prices.find((p) => p.type === 'ONE_TIME');
  const plain = (m?: number) => (m === undefined ? '' : toPlain(m, r));
  const c = n.contract;
  return {
    group: n.parentId ?? '', id: n.id, name: n.name, type: n.kind, description: n.description ?? '', monthly: plain(rec?.amount.amountMinor), upfront: plain(once?.amount.amountMinor), tax: (rec ?? once)?.taxInclusive === false ? 'no' : 'yes',
    term: c?.termMonths ? String(c.termMonths) : '', free: c?.termMonths ? String(c.etc?.waiveInLastMonths ?? '') : '', etc: c?.etc?.method === 'REMAINING_RECURRING_PERCENT' ? String(c.etc.percentOfRemaining ?? '') : '',
    subsidy: plain(c?.subsidy?.subsidyAmount.amountMinor), retail: plain(c?.subsidy?.deviceRetailPrice.amountMinor), fulfilment: optionsOf(n.fulfilment).join('|'), skus: (n.fulfilment?.inventorySkus ?? []).join('|'),
    variants: (n.variants ?? []).map((v) => `${v.colour}/${v.storage ?? ''}/${v.sku}/${v.priceDeltaMinor ? plain(v.priceDeltaMinor) : ''}`).join('|'),
    deals: (n.deals ?? []).map((d) => `${d.termMonths}:${plain(d.subsidyMinor)}${d.waiveInLastMonths !== undefined ? `:${d.waiveInLastMonths}` : ''}`).join('|'),
    channels: (n.salesChannels ?? []).join('|'), requires: n.requires.join('|'), excludes: n.excludes.join('|'), partner: n.partnerCode ?? '', market: n.markets[0] ?? '',
    status: n.status === 'RETIRED' ? '' : n.status, golive: '',
  };
}

/** The file to fill in: the header, the valid ids to use (groups, types, options, channels), and optionally every current offer so they can be edited in bulk. */
export async function offersTemplate(q: Queryable, o: { withOffers?: boolean } = {}): Promise<string> {
  const regional = await getRegional(q);
  const groups = (await q.query(`SELECT id, name FROM catalog_nodes WHERE level='GROUP' AND status <> 'RETIRED' ORDER BY path LIMIT 300`)).rows;
  const types = await listOfferTypes(q, { activeOnly: true });
  const options = await listFulfilmentOptions(q, { activeOnly: true });
  const head = [
    '# Meridian offers import. Lines that start with # are ignored; keep the header row below.',
    '# The offer_id is the key: a row whose offer_id already exists UPDATES that offer (a blank cell leaves a field as it is); otherwise it creates a new offer. With no offer_id, it is made from the name.',
    `# Amounts are plain numbers in ${regional.currency} (12.50), no symbol. Lists use | between items. A new offer starts as DRAFT unless status says otherwise.`,
    '# group_id: the group the offer belongs to. ' + (groups.length ? groups.map((g) => `${g.id} = ${g.name}`).join('; ') : 'no groups yet: create them in the catalog first'),
    '# type: ' + types.map((t) => `${t.id} = ${t.name}`).join('; '),
    '# fulfilment (optional; a new offer gets its type\'s usual options): ' + options.map((f) => `${f.id} = ${f.name}`).join('; '),
    '# prices_include_tax: yes or no. contract_months: 0, 12, 24 or 36. A contract with a device also needs subsidy and device_retail_price; any other contract uses etc_percent (default 50).',
    '# stock_skus: SKUs separated by |. colours_storage: Colour/Storage/SKU/price difference, separated by | (for example Black/256GB/IP18-256-BLK/0|Black/512GB/IP18-512-BLK/300).',
    '# device_contracts (outright devices): months:subsidy[:free months] separated by | (for example 24:400|12:200). channels: ' + CHANNELS.join(', ') + '. requires and excludes: offer ids separated by |.',
    '# status: DRAFT, SCHEDULED (with go_live_date as YYYY-MM-DD, the start of that day in UTC) or ACTIVE.',
    ORDER.map(([h]) => h).join(','),
  ];
  const rows: string[] = [];
  if (o.withOffers) {
    const ids = (await q.query(`SELECT id FROM catalog_nodes WHERE level='OFFER' ORDER BY path LIMIT ${OFFER_IMPORT_MAX_ROWS}`)).rows.map((r) => r.id as string);
    for (const id of ids) { const row = offerRow(await getOffer(q, id), regional); rows.push(ORDER.map(([, c]) => csvCell(row[c])).join(',')); }
  }
  return [...head, ...rows].join('\r\n') + '\r\n';
}
