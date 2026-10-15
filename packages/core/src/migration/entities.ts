import type { Queryable } from '../db.js';
import { OFFER_FILE_COLUMNS, offersExportPage } from '../offer-import.js';
import type { EntityDef, FieldDef, ReadPage, Rec } from './types.js';

/**
 * Every record type the migration engine knows. Reads use keyset paging only (never OFFSET): a page costs the same at row one and at row twenty million,
 * and each page follows the table's own index order. A composite cursor is its parts joined with "|".
 */
type Kt = 'uuid' | 'text' | 'bigint' | 'int' | 'smallint';
interface KeysetOptions { select: string; from: string; where?: string; order: string[]; types: Kt[]; keyOf: (r: Rec) => unknown[] }

async function keyset(q: Queryable, o: KeysetOptions, after: string | null, limit: number): Promise<ReadPage> {
  const parts = after ? after.split('|').map(decodeURIComponent) : null;
  const cond = parts ? `(${o.order.join(', ')}) > (${parts.map((_, i) => `$${i + 2}::${o.types[i]}`).join(', ')})` : 'TRUE';
  const rows = (await q.query(`SELECT ${o.select} FROM ${o.from} WHERE ${o.where ?? 'TRUE'} AND ${cond} ORDER BY ${o.order.join(', ')} LIMIT $1`, [limit + 1, ...(parts ?? [])])).rows as Rec[];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, next: more && last ? o.keyOf(last).map((p) => encodeURIComponent(String(p))).join('|') : null };
}
/** A table read in order of one column. */
const simple = (o: { select: string; from: string; where?: string; key: string; type: Kt; field: string }) => (q: Queryable, after: string | null, limit: number) =>
  keyset(q, { select: o.select, from: o.from, where: o.where, order: [o.key], types: [o.type], keyOf: (r) => [r[o.field]] }, after, limit);

/** Rows of a child table for a page of parent keys. */
const children = (o: { select: string; from: string; col: string; type: 'uuid' | 'text'; order: string }) => async (q: Queryable, field: string, keys: string[]): Promise<Rec[]> => {
  if (field !== o.col) throw new Error(`cannot nest ${o.from} by ${field}`);
  return (await q.query(`SELECT ${o.select} FROM ${o.from} WHERE ${o.col} = ANY($1::${o.type}[]) ORDER BY ${o.order}`, [keys])).rows as Rec[];
};
const f = (name: string, type: FieldDef['type'], hint: string, example: string, more: Partial<FieldDef> = {}): FieldDef => ({ name, type, hint, example, ...more });
const ACTIVE = ['ACTIVE', 'INACTIVE'];

export const ENTITIES: EntityDef[] = [
  // ───────────────────────── Product ─────────────────────────
  {
    id: 'catalog_structure', label: 'Catalog structure', domain: 'product', phase: 1, importable: true, dependsOn: [], table: 'catalog_nodes',
    description: 'Network types, categories and product groups: the levels above the offers.',
    note: 'Load a parent before its children: every row names its parent. Offers have their own file.',
    fields: [
      f('id', 'text', 'Unique id: lowercase letters, digits and dashes', 'grp-sim-only', { required: true, pattern: '^[a-z0-9][a-z0-9-]{0,59}$' }),
      f('level', 'enum', 'NETWORK_TYPE, CATEGORY or GROUP', 'GROUP', { required: true, values: ['NETWORK_TYPE', 'CATEGORY', 'GROUP'] }),
      f('name', 'text', 'Shown to staff and customers', 'SIM-only plans', { required: true, max: 100 }),
      f('code', 'text', 'Short code (made from the name when empty)', 'sim-only'),
      f('parent_id', 'ref', 'The id of the level above: a network type has none, a category sits under a network type, a group under a category', 'cat-mobile-plans', { ref: 'catalog_structure' }),
      f('network_type', 'text', 'For a network type: mobile, fiber or iot', 'mobile'),
      f('status', 'enum', 'DRAFT, ACTIVE or RETIRED', 'ACTIVE', { values: ['DRAFT', 'ACTIVE', 'RETIRED'] }),
      f('markets', 'list', 'Two-letter market codes, separated by |, or empty for every market', 'SG|MY'),
    ],
    read: (q, a, l) => keyset(q, { select: `id, level, name, code, parent_id, data->>'networkType' AS network_type, status, markets`, from: 'catalog_nodes', where: `level <> 'OFFER'`, order: ['id'], types: ['text'], keyOf: (r) => [r.id] }, a, l),
  },
  {
    id: 'offers', label: 'Offers', domain: 'product', phase: 1, importable: true, dependsOn: ['catalog_structure'], table: 'catalog_nodes',
    description: 'Every offer with its prices, contract, fulfilment, variants, device contracts, channels and dependencies, in the layout of the offers import.',
    note: 'The offers template has its own, fuller guide. A row with an existing offer_id updates that offer.',
    fields: [...OFFER_FILE_COLUMNS.map((c) => f(c, 'text', c === 'offer_id' ? 'The offer’s id; blank to make one from the name' : 'See the offers template for what this column takes', '', { required: c === 'group_id' || c === 'name' || c === 'type' })),
      f('node', 'json', 'The full offer document, for reference (not read on import)', '{}', { jsonOnly: true })],
    read: async (q, a, l) => {
      const p = await offersExportPage(q, a, l);
      return { rows: p.rows, next: p.next };
    },
  },
  {
    id: 'offer_types', label: 'Offer types', domain: 'product', phase: 1, importable: false, dependsOn: [], table: 'offer_types',
    description: 'The types of offer, with the behaviour switches each carries.',
    fields: [f('id', 'text', 'Id', 'SIM_ONLY', { required: true }), f('name', 'text', 'Name', 'SIM-only plan', { required: true }), f('description', 'text', 'Description', ''), f('template', 'text', 'The preset it started from', 'SIM_ONLY', { required: true }),
      f('status', 'enum', 'ACTIVE or INACTIVE', 'ACTIVE', { values: ACTIVE }), f('sort_order', 'int', 'Order in lists', '10'), f('is_builtin', 'bool', 'Comes with the platform', 'true'), f('behaviour', 'json', 'The switches in force', '{}')],
    read: simple({ select: 'id, name, description, template, status, sort_order, is_builtin, behaviour', from: 'offer_types', key: 'id', type: 'text', field: 'id' }),
  },
  {
    id: 'fulfilment_options', label: 'Fulfilment options', domain: 'product', phase: 1, importable: false, dependsOn: [], table: 'fulfilment_options',
    description: 'The ways an offer can reach the customer: ship, collect in store, install, activate a SIM.',
    fields: [f('id', 'text', 'Id', 'SHIP', { required: true }), f('name', 'text', 'Name', 'Delivered', { required: true }), f('description', 'text', 'Description', ''), f('mechanic', 'text', 'How it works', 'SHIP', { required: true }),
      f('tracks_stock', 'bool', 'Stock is tracked', 'true'), f('status', 'enum', 'ACTIVE or INACTIVE', 'ACTIVE', { values: ACTIVE }), f('sort_order', 'int', 'Order', '10'), f('is_builtin', 'bool', 'Comes with the platform', 'true')],
    read: simple({ select: 'id, name, description, mechanic, tracks_stock, status, sort_order, is_builtin', from: 'fulfilment_options', key: 'id', type: 'text', field: 'id' }),
  },
  {
    id: 'service_types', label: 'Service types', domain: 'product', phase: 1, importable: false, dependsOn: [], table: 'service_kinds',
    description: 'Mobile, Fibre, IoT, Subscription and the types you defined, with how the network and charging system hear about their services.',
    fields: [f('id', 'text', 'Id', 'MOBILE', { required: true }), f('name', 'text', 'Name', 'Mobile', { required: true }), f('description', 'text', 'Description', ''), f('is_builtin', 'bool', 'Comes with the platform', 'true'),
      f('status', 'enum', 'ACTIVE or INACTIVE', 'ACTIVE', { values: ACTIVE }), f('identifier_prefix', 'text', 'Identifiers start with', '+'), f('expires', 'bool', 'Ends by itself', 'false'), f('validity_days', 'int', 'Default length in days', ''),
      f('provision_systems', 'json', 'Systems told', '[]'), f('provision_instruction', 'text', 'Start instruction', 'PROVISION'), f('deprovision_instruction', 'text', 'End instruction', 'DEPROVISION'), f('announce_start', 'bool', 'Tell the network at the start', 'false'), f('ocs_enabled', 'bool', 'Provision into the charging system', 'true')],
    read: simple({ select: 'id, name, description, is_builtin, status, identifier_prefix, expires, validity_days, provision_systems, provision_instruction, deprovision_instruction, announce_start, ocs_enabled', from: 'service_kinds', key: 'id', type: 'text', field: 'id' }),
  },
  {
    id: 'vip_tiers', label: 'VIP number tiers (slabs)', domain: 'product', phase: 1, importable: false, dependsOn: [], table: 'msisdn_vip_tier_rules',
    description: 'The tiers of special numbers: the patterns that make a number VIP, the one-time fee, the minimum plan and contract, and the early-termination multiplier.',
    fields: [f('tier', 'text', 'Tier code', 'GOLD', { required: true }), f('label', 'text', 'Name', 'Gold', { required: true }), f('sort_order', 'int', 'Order', '10'), f('patterns', 'json', 'The patterns that qualify', '[]'), f('one_time_fee_minor', 'money', 'One-time fee in minor units', '5000'),
      f('min_monthly_plan_minor', 'money', 'Smallest monthly plan in minor units', '0'), f('min_contract_months', 'int', 'Shortest contract', '0'), f('etc_multiplier_bps', 'int', 'Early-termination multiplier, 10000 = 1×', '10000'), f('enabled', 'bool', 'In use', 'true')],
    read: simple({ select: 'tier, label, sort_order, patterns, one_time_fee_minor, min_monthly_plan_minor, min_contract_months, etc_multiplier_bps, enabled', from: 'msisdn_vip_tier_rules', key: 'tier', type: 'text', field: 'tier' }),
  },
  {
    id: 'cancellation_rules', label: 'Terms: cancellation and return rules', domain: 'product', phase: 1, importable: false, dependsOn: [], table: 'cancellation_rules',
    description: 'The rules that decide when an order can be cancelled or returned and what it costs: the conditions and wording shown in the terms.',
    fields: [f('id', 'text', 'Id', 'cancel-before-ship', { required: true }), f('name', 'text', 'Name', 'Cancel before shipping', { required: true }), f('action', 'text', 'What it governs', 'CANCEL'), f('group_kind', 'text', 'Which part of an order', 'GOODS'),
      f('priority', 'int', 'Lower first', '10'), f('enabled', 'bool', 'In force', 'true'), f('data', 'json', 'Conditions, outcome and the wording shown in the terms', '{}')],
    read: simple({ select: 'id, name, action, group_kind, priority, enabled, data', from: 'cancellation_rules', key: 'id', type: 'text', field: 'id' }),
  },
  {
    id: 'terms', label: 'Terms: store terms and privacy links', domain: 'product', phase: 1, importable: false, dependsOn: [], table: 'settings',
    description: 'The terms and conditions and privacy notice links the store-front shows, and the version recorded with each customer’s acceptance.',
    fields: [f('terms_url', 'text', 'Terms and conditions link', 'https://example.com/terms'), f('privacy_url', 'text', 'Privacy notice link', 'https://example.com/privacy'), f('terms_version', 'text', 'Version', '1'), f('application_ttl_hours', 'int', 'Unfinished sign-ups kept for', '72')],
    read: async (q, after) => {
      if (after) return { rows: [], next: null };
      const v = (await q.query(`SELECT value FROM settings WHERE key='store'`)).rows[0]?.value ?? {};
      return { rows: [{ terms_url: v.termsUrl ?? '', privacy_url: v.privacyUrl ?? '', terms_version: v.termsVersion ?? '1', application_ttl_hours: v.applicationTtlHours ?? 72 }], next: null };
    },
  },

  // ───────────────────────── Customer ─────────────────────────
  {
    id: 'customer_segments', label: 'Customer segments', domain: 'customer', phase: 3, importable: false, dependsOn: [], table: 'customer_segments',
    description: 'The segments a customer can belong to (consumer, family, enterprise, IoT enterprise and your own).',
    fields: [f('id', 'text', 'Id', 'CONSUMER', { required: true }), f('name', 'text', 'Name', 'Consumer', { required: true }), f('description', 'text', 'Description', ''), f('individual', 'bool', 'Customers are individuals (one ID document each)', 'true'), f('status', 'enum', 'ACTIVE or INACTIVE', 'ACTIVE', { values: ACTIVE }), f('sort_order', 'int', 'Order', '10')],
    read: simple({ select: 'id, name, description, individual, status, sort_order', from: 'customer_segments', key: 'id', type: 'text', field: 'id' }),
  },
  {
    id: 'customers', label: 'Customers', domain: 'customer', phase: 3, importable: true, dependsOn: ['customer_segments'], table: 'customers',
    description: 'Customers, including enterprise departments (a customer with a parent) and IoT hierarchies (the IoT enterprise segment).',
    note: 'The id is your own key for the customer (any text up to 60 characters, or a UUID when restoring a Meridian export): other files point at it. Load a parent before its departments. Meridian never stores a raw national ID: a legacy file gives id_document, which becomes a masked reference and a keyed hash; a restore gives id_document_hash.',
    fields: [
      f('id', 'text', 'Your key for the customer, or the UUID from a Meridian export', 'LEGACY-100045', { required: true, max: 60 }),
      f('segment', 'ref', 'The segment id', 'CONSUMER', { required: true, ref: 'customer_segments' }),
      f('display_name', 'text', 'Full name, or company name', 'Alex Tan', { required: true, max: 120 }),
      f('id_document', 'text', 'The ID document number (becomes a masked reference and a hash; never stored as it is)', 'S1234567A', { importOnly: true, max: 40 }),
      f('id_document_ref', 'text', 'The masked ID reference as stored', 'S******67A', { sensitive: 'MASK' }),
      f('id_document_hash', 'text', 'Keyed hash of the ID document, for duplicate detection; use this when restoring a Meridian export', '', { sensitive: 'PSEUDONYM', pattern: '^[0-9a-f]{64}$' }),
      f('market_code', 'text', 'Two-letter market code', 'SG', { pattern: '^[A-Z]{2}$' }),
      f('parent_customer_id', 'ref', 'For a department: the id of the customer above it', '', { ref: 'customers' }),
      f('status', 'enum', 'ACTIVE or another status', 'ACTIVE', { values: ['ACTIVE', 'INACTIVE', 'CLOSED'] }),
      f('email', 'text', 'Email', 'alex@example.com', { pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' }),
      f('phone', 'text', 'Phone in international form', '+6591234567', { pattern: '^\\+?[0-9 -]{6,20}$' }),
      f('kyc_status', 'enum', 'NOT_VERIFIED or VERIFIED', 'VERIFIED', { values: ['NOT_VERIFIED', 'VERIFIED'] }),
      f('kyc_verified_at', 'timestamp', 'When identity was verified (ISO 8601)', '2024-05-01T09:30:00Z'),
      f('date_of_birth', 'date', 'YYYY-MM-DD', '1990-04-12', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
      f('gender', 'text', 'As held', ''),
      f('address', 'json', 'Address as a JSON object (line1, city, postcode, country)', '{"line1":"1 Raffles Place","city":"Singapore","postcode":"048616","country":"SG"}'),
      f('created_at', 'timestamp', 'When the customer was created (ISO 8601)', '2022-01-15T00:00:00Z'),
    ],
    nest: [{ as: 'accounts', entity: 'accounts', parentField: 'id', childField: 'customer_id' }],
    read: (q, a, l) => keyset(q, {
      select: `shard_id, id, segment, display_name, id_document_ref, id_document_hash, market_code, parent_customer_id, status, email, phone, kyc_status, kyc_verified_at, date_of_birth, gender, address, created_at`,
      from: 'customers', order: ['shard_id', 'id'], types: ['smallint', 'uuid'], keyOf: (r) => [r.shardId, r.id],
    }, a, l),
  },
  {
    id: 'accounts', label: 'Accounts', domain: 'customer', phase: 3, importable: true, dependsOn: ['customers'], table: 'accounts',
    description: 'Billing accounts: the bill cycle, currency, credit limit and deposit, and who pays.',
    note: 'The id is your own key for the account. customer_id is the key you gave the customer.',
    fields: [
      f('id', 'text', 'Your key for the account, or the UUID from a Meridian export', 'ACC-100045-1', { required: true, max: 60 }),
      f('customer_id', 'ref', 'The customer’s key', 'LEGACY-100045', { required: true, ref: 'customers' }),
      f('name', 'text', 'Account name', 'Main account'),
      f('bill_cycle_day', 'int', 'Day of month 1-28, or empty for a daily cycle', '1', { pattern: '^([1-9]|1[0-9]|2[0-8])$' }),
      f('status', 'enum', 'ACTIVE, SUSPENDED or CLOSED', 'ACTIVE', { values: ['ACTIVE', 'SUSPENDED', 'CLOSED'] }),
      f('currency', 'text', 'Three-letter currency code (the market’s when empty)', 'SGD', { pattern: '^[A-Z]{3}$' }),
      f('payer_account_id', 'ref', 'The key of the account that pays this one, if another', '', { ref: 'accounts' }),
      f('credit_limit_minor', 'money', 'Credit limit in minor units (cents)', '50000'),
      f('deposit_minor', 'money', 'Deposit held in minor units', '0'),
      f('credit_state', 'text', 'Credit state as held', 'OK'),
      f('dunning_stage', 'int', 'Dunning stage 0-5 (see the dunning file for active cases)', '0'),
      f('created_at', 'timestamp', 'When the account was opened (ISO 8601)', '2022-01-15T00:00:00Z'),
    ],
    byParent: children({ select: 'id, customer_id, name, bill_cycle_day, status, currency, payer_account_id, credit_limit_minor, deposit_minor, credit_state, dunning_stage, created_at', from: 'accounts', col: 'customer_id', type: 'uuid', order: 'customer_id, id' }),
    nest: [{ as: 'services', entity: 'services', parentField: 'id', childField: 'account_id' }],
    read: (q, a, l) => keyset(q, {
      select: `shard_id, id, customer_id, name, bill_cycle_day, status, currency, payer_account_id, credit_limit_minor, deposit_minor, credit_state, dunning_stage, created_at`,
      from: 'accounts', order: ['shard_id', 'id'], types: ['smallint', 'uuid'], keyOf: (r) => [r.shardId, r.id],
    }, a, l),
  },
  {
    id: 'service_groups', label: 'Service groups (family and shared)', domain: 'customer', phase: 4, importable: false, dependsOn: ['accounts'], table: 'service_groups',
    description: 'Groups of services that share allowances or a discount: family plans and the like.',
    fields: [f('id', 'text', 'Id', '', { required: true }), f('customer_id', 'ref', 'Customer', '', { ref: 'customers' }), f('account_id', 'ref', 'Account', '', { ref: 'accounts' }), f('name', 'text', 'Name', 'Tan family'), f('status', 'text', 'Status', 'ACTIVE'),
      f('offer_id', 'ref', 'The group plan', '', { ref: 'offers' }), f('max_supplementary', 'int', 'Most members besides the head', '3'), f('origin', 'text', 'How it was created', 'ORDER'), f('benefits', 'json', 'Shared allowances and discounts', '{}'), f('created_at', 'timestamp', 'Created', '')],
    nest: [{ as: 'members', entity: 'group_members', parentField: 'id', childField: 'group_id' }],
    read: (q, a, l) => keyset(q, { select: 'shard_id, id, customer_id, account_id, name, status, offer_id, max_supplementary, origin, benefits, created_at', from: 'service_groups', order: ['shard_id', 'id'], types: ['smallint', 'uuid'], keyOf: (r) => [r.shardId, r.id] }, a, l),
  },
  {
    id: 'group_members', label: 'Service group members', domain: 'customer', phase: 4, importable: false, dependsOn: ['service_groups', 'services'], table: 'service_group_members',
    description: 'Which services belong to which group, and their role (head or member).',
    fields: [f('group_id', 'ref', 'Group', '', { required: true, ref: 'service_groups' }), f('service_id', 'ref', 'Service', '', { required: true, ref: 'services' }), f('role', 'text', 'PRINCIPAL or SUPPLEMENTARY', 'PRINCIPAL'), f('added_at', 'timestamp', 'Added', '')],
    byParent: children({ select: 'group_id, service_id, role, added_at', from: 'service_group_members', col: 'group_id', type: 'uuid', order: 'group_id, service_id' }),
    read: (q, a, l) => keyset(q, { select: 'group_id, service_id, role, added_at', from: 'service_group_members', order: ['group_id', 'service_id'], types: ['uuid', 'uuid'], keyOf: (r) => [r.groupId, r.serviceId] }, a, l),
  },

  // ───────────────────────── Operations ─────────────────────────
  {
    id: 'stores', label: 'Stores', domain: 'operations', phase: 2, importable: true, dependsOn: [], table: 'stores',
    description: 'Retail stores.', note: 'An empty id adds a store (the system issues the id); an existing id updates it.',
    fields: [f('id', 'text', 'Store id; empty to add', 'STORE-00001'), f('name', 'text', 'Unique name', 'Orchard Flagship', { required: true, max: 120 }), f('address', 'text', 'Address', '391 Orchard Road', { max: 300 }), f('phone', 'text', 'Phone', '+6561234567', { max: 40 }),
      f('status', 'enum', 'ACTIVE or INACTIVE', 'ACTIVE', { values: ACTIVE }), f('market_code', 'text', 'Market (only when several markets are on)', '', { pattern: '^[A-Z]{2}$' })],
    read: simple({ select: 'id, name, address, phone, status, market_code', from: 'stores', key: 'id', type: 'text', field: 'id' }),
  },
  {
    id: 'dealers', label: 'Dealers', domain: 'operations', phase: 2, importable: true, dependsOn: [], table: 'dealers',
    description: 'Partner dealers with their place in the channel and how they are paid.',
    note: 'An empty id adds a dealer (the system issues the id); an existing id updates it. Load a parent dealer before its sub-dealers. Bank details need the permission to configure commission.',
    fields: [f('id', 'text', 'Dealer id; empty to add', 'DLR-00001'), f('name', 'text', 'Name', 'Metro Distribution', { required: true, max: 120 }), f('contact_name', 'text', 'Contact', 'Alex Lim'), f('email', 'text', 'Email', 'alex@metro.example', { pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' }),
      f('phone', 'text', 'Phone', '+6591234567'), f('status', 'enum', 'ACTIVE or INACTIVE', 'ACTIVE', { values: ACTIVE }), f('tier', 'enum', 'Channel tier', 'DEALER', { values: ['MASTER_DISTRIBUTOR', 'DEALER', 'SUB_DEALER', 'FRANCHISE'] }),
      f('parent_dealer_id', 'ref', 'The dealer above in the channel', '', { ref: 'dealers' }), f('bank_account_name', 'text', 'Bank account name', 'Metro Pte Ltd'), f('bank_account_no', 'text', 'Bank account number', '0011223344', { sensitive: 'MASK' }),
      f('bank_code', 'text', 'Bank code', 'DBS'), f('sap_vendor_no', 'text', 'SAP vendor number', 'V10001')],
    nest: [{ as: 'agents', entity: 'agents', parentField: 'id', childField: 'dealer_id' }],
    read: simple({ select: 'id, name, contact_name, email, phone, status, tier, parent_dealer_id, bank_account_name, bank_account_no, bank_code, sap_vendor_no', from: 'dealers', key: 'id', type: 'text', field: 'id' }),
  },
  {
    id: 'agents', label: 'Agents (dealer hierarchy)', domain: 'operations', phase: 2, importable: true, dependsOn: ['dealers'], table: 'dealer_agents',
    description: 'The agents who sell for each dealer.', note: 'An empty id adds an agent (the system issues the id); an agent stays with its dealer.',
    fields: [f('id', 'text', 'Agent id; empty to add', 'DLR-00001-A001'), f('dealer_id', 'ref', 'The dealer', 'DLR-00001', { required: true, ref: 'dealers' }), f('name', 'text', 'Name', 'Priya Nair', { required: true }), f('email', 'text', 'Email', 'priya@metro.example'), f('phone', 'text', 'Phone', '+6591234568'),
      f('status', 'enum', 'ACTIVE or INACTIVE', 'ACTIVE', { values: ACTIVE })],
    byParent: children({ select: 'id, dealer_id, name, email, phone, status', from: 'dealer_agents', col: 'dealer_id', type: 'text', order: 'dealer_id, id' }),
    read: simple({ select: 'id, dealer_id, name, email, phone, status', from: 'dealer_agents', key: 'id', type: 'text', field: 'id' }),
  },
  {
    id: 'commission_plans', label: 'Commission plans', domain: 'operations', phase: 2, importable: false, dependsOn: [], table: 'commission_plans',
    description: 'Commission plans: hold days and override percentages.',
    fields: [f('id', 'text', 'Plan id', '', { required: true }), f('name', 'text', 'Name', 'Partner plan 2026', { required: true }), f('status', 'text', 'ACTIVE or INACTIVE', 'ACTIVE'), f('valid_from', 'date', 'From', ''), f('valid_to', 'date', 'To', ''),
      f('hold_days', 'int', 'Days an earning is held before approval', '30'), f('override_bps', 'json', 'Upline override percentages in basis points', '[100]'), f('note', 'text', 'Note', '')],
    nest: [{ as: 'rules', entity: 'commission_rules', parentField: 'id', childField: 'plan_id' }, { as: 'policies', entity: 'commission_policies', parentField: 'id', childField: 'plan_id' }, { as: 'assignments', entity: 'commission_assignments', parentField: 'id', childField: 'plan_id' }],
    read: simple({ select: 'id, name, status, valid_from, valid_to, hold_days, override_bps, note', from: 'commission_plans', key: 'id', type: 'uuid', field: 'id' }),
  },
  {
    id: 'commission_rules', label: 'Commission rules and volume slabs', domain: 'operations', phase: 2, importable: false, dependsOn: ['commission_plans'], table: 'commission_rules',
    description: 'The rules of each plan: what they match, the rate or fixed amount, and the volume slabs.',
    fields: [f('id', 'text', 'Rule id', '', { required: true }), f('plan_id', 'ref', 'Plan', '', { required: true, ref: 'commission_plans' }), f('name', 'text', 'Name', 'SIM-only'), f('priority', 'int', 'Lower first', '100'), f('match_kinds', 'json', 'Offer kinds', '[]'),
      f('match_offer_ids', 'json', 'Offer ids', '[]'), f('min_term_months', 'int', 'Shortest contract', ''), f('max_term_months', 'int', 'Longest contract', ''), f('match_tiers', 'json', 'Seller tiers', '[]'), f('calc', 'text', 'PERCENT or FIXED', 'PERCENT'),
      f('rate_bps', 'int', 'Rate in basis points', '500'), f('fixed_minor', 'money', 'Fixed amount in minor units', '0'), f('slab_mode', 'text', 'MARGINAL or RETROACTIVE', 'MARGINAL'), f('slabs', 'json', 'Volume slabs', '[]'), f('status', 'text', 'Status', 'ACTIVE')],
    byParent: children({ select: 'id, plan_id, name, priority, match_kinds, match_offer_ids, min_term_months, max_term_months, match_tiers, calc, rate_bps, fixed_minor, slab_mode, slabs, status', from: 'commission_rules', col: 'plan_id', type: 'uuid', order: 'plan_id, priority, id' }),
    read: simple({ select: 'id, plan_id, name, priority, match_kinds, match_offer_ids, min_term_months, max_term_months, match_tiers, calc, rate_bps, fixed_minor, slab_mode, slabs, status', from: 'commission_rules', key: 'id', type: 'uuid', field: 'id' }),
  },
  {
    id: 'commission_policies', label: 'Commission claw-back policies', domain: 'operations', phase: 2, importable: false, dependsOn: ['commission_plans'], table: 'clawback_policies',
    description: 'When and how much commission is taken back if a customer leaves early.',
    fields: [f('id', 'text', 'Policy id', '', { required: true }), f('plan_id', 'ref', 'Plan', '', { required: true, ref: 'commission_plans' }), f('name', 'text', 'Name', 'Early churn'), f('min_term_months', 'int', 'Applies from this contract length', ''), f('triggers', 'json', 'TERMINATION, PORT_OUT, ORDER_CANCELLED', '[]'),
      f('tiers', 'json', 'The windows and percentages', '[]'), f('include_overrides', 'bool', 'Upline override is taken back too', 'true'), f('status', 'text', 'Status', 'ACTIVE')],
    byParent: children({ select: 'id, plan_id, name, min_term_months, triggers, tiers, include_overrides, status', from: 'clawback_policies', col: 'plan_id', type: 'uuid', order: 'plan_id, id' }),
    read: simple({ select: 'id, plan_id, name, min_term_months, triggers, tiers, include_overrides, status', from: 'clawback_policies', key: 'id', type: 'uuid', field: 'id' }),
  },
  {
    id: 'commission_assignments', label: 'Commission plan assignments', domain: 'operations', phase: 2, importable: false, dependsOn: ['commission_plans'], table: 'commission_assignments',
    description: 'Which dealer, salesperson, store or channel earns by which plan.',
    fields: [f('id', 'text', 'Id', '', { required: true }), f('plan_id', 'ref', 'Plan', '', { required: true, ref: 'commission_plans' }), f('kind', 'text', 'DEALER, SALESPERSON, STORE or CHANNEL', 'DEALER'), f('actor_id', 'text', 'Who earns', 'DLR-00001')],
    byParent: children({ select: 'id, plan_id, kind, actor_id', from: 'commission_assignments', col: 'plan_id', type: 'uuid', order: 'plan_id, id' }),
    read: simple({ select: 'id, plan_id, kind, actor_id', from: 'commission_assignments', key: 'id', type: 'uuid', field: 'id' }),
  },

  // ───────────────────────── Subscriber and financial ─────────────────────────
  {
    id: 'sims', label: 'SIM inventory (ICCID)', domain: 'subscriber', phase: 1, importable: true, dependsOn: [], table: 'iccid_inventory',
    description: 'SIM cards and eSIM profiles: ICCID, the IMSI on it, its state and where it is.',
    note: 'A SIM in use by a service is loaded with the services file (the state moves to ACTIVE there).',
    fields: [f('iccid', 'text', 'ICCID: 19 or 20 digits starting 89', '8960123456789012345', { required: true, pattern: '^89\\d{17,18}$' }), f('kind', 'enum', 'PHYSICAL or ESIM', 'PHYSICAL', { values: ['PHYSICAL', 'ESIM'] }),
      f('state', 'enum', 'State of the SIM', 'WAREHOUSE_INVENTORY', { values: ['WAREHOUSE_INVENTORY', 'DISTRIBUTED_DEALER', 'RESERVED', 'ACTIVE', 'DAMAGED_SCRAPPED', 'DECOMMISSIONED'] }),
      f('location_id', 'text', 'Warehouse or store id', 'WH-MAIN'), f('imsi', 'text', 'IMSI on the SIM: 15 digits', '525010000000001', { pattern: '^\\d{15}$' }), f('activation_code', 'text', 'eSIM activation code', '', { sensitive: 'PSEUDONYM' }), f('batch', 'text', 'Batch', 'BATCH-1')],
    read: simple({ select: 'iccid, kind, state, location_id, imsi, activation_code, batch', from: 'iccid_inventory', key: 'iccid', type: 'text', field: 'iccid' }),
  },
  {
    id: 'imsis', label: 'IMSI pool', domain: 'subscriber', phase: 1, importable: true, dependsOn: [], table: 'imsi_inventory',
    description: 'IMSIs and where each is in its life: free, bound to a SIM, active, resting.',
    fields: [f('imsi', 'text', 'IMSI: 15 digits', '525010000000001', { required: true, pattern: '^\\d{15}$' }), f('state', 'enum', 'State', 'POOL_UNASSIGNED', { values: ['POOL_UNASSIGNED', 'BOUND_TO_SIM', 'ACTIVE', 'QUARANTINED', 'RECYCLED'] }),
      f('iccid', 'ref', 'The SIM it is bound to', '', { ref: 'sims' }), f('previous_msisdn', 'text', 'Number it last served', ''), f('quarantine_until', 'date', 'Resting until', ''), f('batch', 'text', 'Batch', 'BATCH-1')],
    read: simple({ select: 'imsi, state, iccid, previous_msisdn, quarantine_until, batch', from: 'imsi_inventory', key: 'imsi', type: 'text', field: 'imsi' }),
  },
  {
    id: 'msisdns', label: 'Number inventory (MSISDN)', domain: 'subscriber', phase: 1, importable: true, dependsOn: [], table: 'msisdn_inventory',
    description: 'Phone numbers: state, VIP tier and pattern.',
    fields: [f('msisdn', 'text', 'Number in international form', '+6591000001', { required: true, pattern: '^\\+\\d{8,15}$' }), f('state', 'enum', 'State', 'AVAILABLE', { values: ['AVAILABLE', 'RESERVED_CHECKOUT', 'ASSIGNED_ACTIVE', 'QUARANTINE_COOLING', 'BLOCKED_VIP', 'AUCTION_HOLD', 'PORTED_OUT'] }),
      f('tier', 'text', 'VIP tier (STANDARD for ordinary numbers)', 'STANDARD'), f('pattern_code', 'text', 'The pattern that made it VIP', ''), f('quarantine_until', 'date', 'Resting until', ''), f('batch', 'text', 'Batch', 'BATCH-1')],
    read: simple({ select: 'msisdn, state, tier, pattern_code, quarantine_until, batch', from: 'msisdn_inventory', key: 'msisdn', type: 'text', field: 'msisdn' }),
  },
  {
    id: 'services', label: 'Services (active subscriptions)', domain: 'subscriber', phase: 4, importable: true, dependsOn: ['accounts', 'offers'], table: 'services',
    description: 'The services customers have: number or circuit, plan, state, contract, SIM and IMSI.',
    note: 'The id is your own key for the service. account_id is the key you gave the account; offer_id must exist in the catalog. A mobile number must be in international form.',
    fields: [
      f('id', 'text', 'Your key for the service, or the UUID from a Meridian export', 'SVC-9000045', { required: true, max: 60 }),
      f('account_id', 'ref', 'The account’s key', 'ACC-100045-1', { required: true, ref: 'accounts' }),
      f('type', 'enum', 'MOBILE, FIBER, IOT or SUBSCRIPTION', 'MOBILE', { required: true, values: ['MOBILE', 'FIBER', 'IOT', 'SUBSCRIPTION'] }),
      f('identifier', 'text', 'The number (MSISDN) for mobile, or the circuit, device or subscription id', '+6591234567', { required: true, max: 40 }),
      f('offer_id', 'ref', 'The offer (plan) id in the catalog', 'plan-sim-5g', { required: true, ref: 'offers' }),
      f('status', 'enum', 'PENDING, ACTIVE, SUSPENDED, PORTING_OUT or TERMINATED', 'ACTIVE', { required: true, values: ['PENDING', 'ACTIVE', 'SUSPENDED', 'PORTING_OUT', 'TERMINATED'] }),
      f('activated_at', 'timestamp', 'When it started (ISO 8601)', '2023-02-01T00:00:00Z'),
      f('contract_start', 'timestamp', 'Contract start (ISO 8601)', '2023-02-01T00:00:00Z'),
      f('contract_term_months', 'int', 'Contract length in months, empty for none', '24'),
      f('terminated_at', 'timestamp', 'When it ended, for a terminated service', ''),
      f('terminated_reason', 'text', 'Why it ended', ''),
      f('suspended_reason', 'text', 'Why it is suspended', ''),
      f('bar_level', 'enum', 'NONE, THROTTLE, SOFT or HARD', 'NONE', { values: ['NONE', 'THROTTLE', 'SOFT', 'HARD'] }),
      f('iccid', 'ref', 'The SIM (ICCID)', '8960123456789012345', { ref: 'sims', pattern: '^89\\d{17,18}$' }),
      f('imsi', 'text', 'The IMSI', '525010000000001', { pattern: '^\\d{15}$' }),
      f('vip_tier', 'text', 'VIP tier of the number', ''),
      f('service_kind', 'text', 'The service type, for one you defined', ''),
      f('expires_at', 'timestamp', 'When it ends by itself', ''),
      f('created_at', 'timestamp', 'When the record was created (ISO 8601)', '2023-02-01T00:00:00Z'),
    ],
    byParent: children({ select: 'id, account_id, type, identifier, offer_id, status, activated_at, contract_start, contract_term_months, terminated_at, terminated_reason, suspended_reason, bar_level, iccid, imsi, vip_tier, service_kind, expires_at, created_at', from: 'services', col: 'account_id', type: 'uuid', order: 'account_id, identifier, id' }),
    read: (q, a, l) => keyset(q, {
      select: `shard_id, id, account_id, type, identifier, offer_id, status, activated_at, contract_start, contract_term_months, terminated_at, terminated_reason, suspended_reason, bar_level, iccid, imsi, vip_tier, service_kind, expires_at, created_at`,
      from: 'services', order: ['shard_id', 'identifier', 'id'], types: ['smallint', 'text', 'uuid'], keyOf: (r) => [r.shardId, r.identifier, r.id],
    }, a, l),
  },
  {
    id: 'gl_balances', label: 'Sub-ledger balances', domain: 'subscriber', phase: 5, importable: false, dependsOn: [], table: 'gl_entries',
    description: 'The sub-ledger as a trial balance: debits, credits and the balance per account code and currency.',
    note: 'A summary for audit and migration planning: history is not loaded back line by line.',
    fields: [f('account_code', 'text', 'Account code', '1100', { required: true }), f('currency', 'text', 'Currency', 'SGD', { required: true }), f('debit_minor', 'money', 'Total debits in minor units', '0'), f('credit_minor', 'money', 'Total credits in minor units', '0'),
      f('balance_minor', 'money', 'Debits less credits', '0'), f('entries', 'int', 'Number of journal lines', '0'), f('last_entry_date', 'date', 'Latest entry', '')],
    read: async (q, after) => {
      if (after) return { rows: [], next: null };
      const rows = (await q.query(`SELECT account_code, currency, sum(debit_minor) AS debit_minor, sum(credit_minor) AS credit_minor, sum(debit_minor) - sum(credit_minor) AS balance_minor, count(*) AS entries, max(entry_date) AS last_entry_date FROM gl_entries GROUP BY account_code, currency ORDER BY account_code, currency`)).rows as Rec[];
      return { rows, next: null };
    },
  },
  {
    id: 'account_balances', label: 'Account balances (receivables)', domain: 'subscriber', phase: 5, importable: true, dependsOn: ['accounts'], table: 'invoices',
    description: 'What each account owes: the unpaid part of its open invoices.',
    note: 'On import each row becomes one opening-balance invoice for the account, so the amount is billed, collected and dunned like any other.',
    fields: [f('account_id', 'ref', 'The account’s key', 'ACC-100045-1', { required: true, ref: 'accounts' }), f('currency', 'text', 'Currency (the account’s when empty)', 'SGD', { pattern: '^[A-Z]{3}$' }),
      f('balance_minor', 'money', 'Amount owed in minor units (cents); positive', '12500', { required: true, pattern: '^\\d{1,12}$' }), f('open_invoices', 'int', 'How many open invoices make it up (information)', '2'),
      f('due_date', 'date', 'When it falls due (import): YYYY-MM-DD; the oldest due date in an export', '2026-09-30', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' })],
    read: async (q, after, limit) => {
      const rows = (await q.query(
        `SELECT account_id, currency, sum(total_minor - paid_minor - credited_minor) AS balance_minor, count(*) AS open_invoices, min(due_date) AS due_date
           FROM invoices WHERE status IN ('ISSUED','OVERDUE') AND ($1::text IS NULL OR account_id > $1::uuid) GROUP BY account_id, currency ORDER BY account_id LIMIT $2`, [after, limit + 1])).rows as Rec[];
      const more = rows.length > limit;
      const page = rows.slice(0, limit);
      return { rows: page, next: more ? String(page[page.length - 1]!.accountId) : null };
    },
  },
  {
    id: 'dunning_states', label: 'Active dunning cases', domain: 'subscriber', phase: 5, importable: true, dependsOn: ['accounts'], table: 'dunning_runs',
    description: 'Accounts that are being chased for an overdue balance: the stage, and the due date the ladder counts from.',
    note: 'On import this records the case and the account’s stage only. It does not bar services or send notices: bars already in force on the old network are carried by the services file.',
    fields: [f('account_id', 'ref', 'The account’s key', 'ACC-100045-1', { required: true, ref: 'accounts' }), f('stage', 'int', 'Dunning stage 1-5 as in the ladder', '2', { required: true, pattern: '^[1-5]$' }), f('anchor_due', 'date', 'The due date of the oldest unpaid invoice: YYYY-MM-DD', '2026-08-31', { required: true, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
      f('started_at', 'timestamp', 'When the case began (ISO 8601)', '2026-09-02T00:00:00Z'), f('last_step', 'text', 'The last ladder step applied', 'REMIND')],
    read: simple({ select: `r.id::text AS run_id, r.account_id, a.dunning_stage AS stage, r.anchor_due, r.started_at, r.last_step`, from: 'dunning_runs r JOIN accounts a ON a.id = r.account_id', where: `r.status = 'ACTIVE'`, key: 'r.id', type: 'bigint', field: 'runId' }),
  },
];

export const entityById = (id: string): EntityDef | undefined => ENTITIES.find((e) => e.id === id);
export const exportFields = (e: EntityDef) => e.fields.filter((x) => !x.importOnly);
export const importFields = (e: EntityDef) => e.fields.filter((x) => !x.jsonOnly);
