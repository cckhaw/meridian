import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { placeOrder } from '../orders.js';
import { freshDb, newCustomer } from '../test-helpers.js';
import { ENTITIES, DOMAINS, PHASES, createExportJob, startExport, templateCsv, entityById, importFields } from './index.js';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  const { customer } = await newCustomer(db, { idDocument: 'S7654321B', email: 'mod@example.com' });
  await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] });
  // Secrets the archive must never carry, planted where each module keeps them.
  await db.query(`INSERT INTO webhook_subscriptions (id, kind, name, target_url, auth_kind, secret_enc, events, created_by) VALUES (gen_random_uuid(), 'OUTBOUND', 'hook', 'https://example.com/h', 'HMAC', 'ENC-SECRET-WEBHOOK', '{}', 'root')`);
  await db.query(`INSERT INTO integration_endpoints (id, group_key, kind, name, url, config, secret_enc) VALUES (gen_random_uuid(), 'network', 'OCS', 'ocs-1', 'https://ocs.example.com', '{"apiKey":"CONFIG-API-KEY","mode":"live"}', 'ENC-SECRET-ENDPOINT')`);
  await db.query(`INSERT INTO settings (key, value, updated_by) VALUES ('probe', '{"clientSecret":"SETTINGS-SECRET","region":"sg"}', 'root')`);
});
afterAll(async () => { await db.close(); });

/**
 * The guard that keeps the migration module up to date. Every table is either described by a data set (so it is exported, and imported where it can be), or named here
 * with the reason it is not. A new table, or a new column on a described one, fails these tests until somebody decides which it is.
 */
const LEFT_OUT: Record<string, string> = {
  // the migration engine's own state
  _migrations: 'schema bookkeeping', data_templates: 'the migration engine', migration_blobs: 'the migration engine', migration_job_items: 'the migration engine', migration_jobs: 'the migration engine', migration_keys: 'the migration engine', migration_refs: 'the migration engine', migration_uploads: 'the migration engine',
  // secrets and sessions
  sessions: 'live sessions', auth_attempts: 'sign-in throttling', password_history: 'password hashes', password_reset_tokens: 'reset tokens', mfa_challenges: 'one-time challenges', mfa_methods: 'MFA secrets', mfa_recovery_codes: 'recovery code hashes', sso_states: 'in-flight sign-ins', kyc_provider_sessions: 'in-flight MyDigital ID attempts (short-lived, hold encrypted form data)', subscriber_otps: 'one-time codes', directory_sync_runs: 'directory sync log',
  // queues, caches and counters that rebuild themselves
  idempotency_keys: 'request de-duplication', gateway_idempotency_keys: 'request de-duplication', rate_limit_buckets: 'live counters', webhook_events: 'delivery queue', webhook_event_log: 'delivery log', event_deliveries: 'delivery queue', integration_audit_log: 'API call log (very large; ship it to a log store)',
  user_notifications: 'in-app alerts, short-lived and personal',
  lifecycle_outbox: 'outbound queue', ocs_jobs: 'provisioning queue', print_jobs: 'print-house queue', ledger_events: 'posting de-duplication', ledger_dead_letters: 'posting failures', order_counters: 'number counters', shard_map: 'deployment topology',
  number_reservation_locks: 'live holds', inventory_reservations: 'live holds', msisdn_quarantine: 'rebuilt from the number pool', identifier_registry: 'rebuilt from services', simulation_ledger: 'scratch what-if data', simulation_runs: 'scratch what-if data',
  bill_run_items: 'per-account results of a run (the invoices are exported)', bill_run_exclusions: 'part of a run', dunning_steps: 'step history of past runs', journal_batch_files: 'journal file contents (checksums are in the batches)', legacy_group_memberships: 'retired table',
  // binary content
  assets: 'logos and images (upload them again)', kyc_documents: 'identity document images (copy from the vault bucket; only the records are exported)',
  // fibre working data that the provider systems own
  fiber_addresses: 'address cache', fiber_import_jobs: 'import log', fiber_qualifications: 'qualification request log', fiber_reservations: 'live port holds', fiber_serviceability_cache: 'cache',
};
// gl_entries is exported as a trial balance (gl_balances); its partitions are not tables of their own.
const SUMMARISED = new Set(['gl_entries']);
/** Columns that are bookkeeping on every table, not data. */
const BOOKKEEPING = new Set(['shard_id', 'version', 'updated_at', 'updated_by', 'created_by', 'created_at', 'added_by']);
/** Columns a data set leaves out, with the reason: a secret, the file content, a value rebuilt from other records, or one that is internal. */
const NOT_IN_FILE: Record<string, Record<string, string>> = {
  catalog_nodes: { path: 'rebuilt from the parents', data: 'the offer document is in the offers file', kind: 'the offers file has type' },
  customers: { hierarchy_path: 'rebuilt from parent_customer_id' },
  services: { order_id: 'the order that created it', customer_id: 'derived from the account', port_in_id: 'rebuilt by the port-in request' },
  iccid_inventory: { transfer_id: 'live', service_id: 'set by services', reserved_until: 'live hold', order_id: 'live hold', previous_state: 'internal' },
  imsi_inventory: { service_id: 'set by services' },
  msisdn_inventory: { service_id: 'set by services', reserved_by: 'live hold', reserved_until: 'live hold', previous_state: 'internal' },
  gl_entries: { event_type: 'summarised', journal_id: 'summarised', id: 'summarised', exported_batch_id: 'summarised', source_type: 'summarised', event_id: 'summarised', entry_date: 'summarised', description: 'summarised', source_id: 'summarised', stream: 'summarised', posted_at: 'summarised' },
  dunning_runs: { ladder: 'internal', workflow_id: 'internal', status: 'only active cases', resets: 'internal', ended_at: 'only active cases', rule_version: 'internal', id: 'internal', rule_id: 'internal', rule_code: 'internal', paused_until: 'internal' },
  bill_runs: { claimed_until: 'lease', workflow_id: 'internal' }, orders: { workflow_id: 'internal' }, payments: { idempotency_key: 'internal' },
  applications: { token_hash: 'the access token of an application' },
  workforce_appointments: { last_event_rank: 'internal', last_event_at: 'internal' },
  documents: { data: 'the file content (kept in the bucket or the database, copied separately)' },
  kyc_cases: { id_number_enc: 'the encrypted ID number' },
  fiber_providers: { adapter_secret_enc: 'adapter secret' },
  fiber_coverage_polygons: { min_lng: 'derived from geometry', min_lat: 'derived from geometry', max_lng: 'derived from geometry', max_lat: 'derived from geometry' },
  commission_payout_batches: { content: 'the payout file (holds bank details)' },
  users: { avatar: 'profile picture', password_hash: 'secret', password_changed_at: 'security state', failed_attempts: 'security state', locked_until: 'security state' },
  oauth_clients: { prev_expires_at: 'secret rotation', prev_secret_hash: 'secret', secret_hash: 'secret' },
  api_clients: { hmac_secret_enc: 'secret', key_hash: 'secret' },
  webhook_subscriptions: { secret_enc: 'secret' }, integration_endpoints: { secret_enc: 'secret' },
};
/** Fields of a data set that are not columns of its table: computed, summarised or taken from a document. */
const VIRTUAL: Record<string, string[]> = {
  settings: ['terms_url', 'privacy_url', 'terms_version', 'application_ttl_hours', 'type_a', 'type_b'],
  catalog_nodes: ['network_type', 'item_type', 'unit', 'unlimited', 'sku', 'description', 'quantity', 'group_id', 'offer_id', 'type', 'monthly_fee', 'upfront_price', 'prices_include_tax', 'contract_months', 'contract_free_months', 'etc_percent', 'subsidy', 'device_retail_price', 'fulfilment', 'stock_skus', 'colours_storage', 'device_contracts', 'channels', 'requires', 'excludes', 'partner_code', 'market', 'go_live_date', 'validity_days', 'ocs_plan_code', 'suspension_mode', 'suspension_fee', 'group_plan', 'max_group_members', 'allowed_member_offers', 'shared_pool_quota_gb', 'characteristics', 'node'],
  customers: ['id_document'], gl_entries: ['balance_minor', 'entries', 'last_entry_date'], invoices: ['balance_minor', 'open_invoices'], dunning_runs: ['stage'],
  offer_types: [], customer_segments: [],
};

describe('the migration module covers every module', () => {
  it('every table is described by a data set or named, with a reason, as left out', async () => {
    const tables = (await db.query(`SELECT c.relname AS t FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1`)).rows.map((r) => r.t as string);
    const described = new Set(ENTITIES.map((e) => e.table));
    const unclassified = tables.filter((t) => !described.has(t) && !(t in LEFT_OUT) && !SUMMARISED.has(t));
    expect(unclassified, `New table(s) with no data set and no reason to leave them out: add a data set in migration/entities-modules.ts, or name each in LEFT_OUT with the reason.`).toEqual([]);
    expect(Object.keys(LEFT_OUT).filter((t) => described.has(t) || !tables.includes(t)), 'LEFT_OUT names a table that is described or no longer exists').toEqual([]);
  });

  it('every column of a described table is in its data set, or named with the reason it is not', async () => {
    const cols = (await db.query(`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema='public'`)).rows as Array<{ t: string; c: string }>;
    const by = new Map<string, Set<string>>();
    for (const r of cols) (by.get(r.t) ?? by.set(r.t, new Set()).get(r.t)!).add(r.c);
    const missing: string[] = [], stale: string[] = [], phantom: string[] = [];
    const tables = new Map<string, { fields: Set<string>; ids: string[] }>();
    for (const e of ENTITIES) { const x = tables.get(e.table) ?? { fields: new Set<string>(), ids: [] }; e.fields.forEach((f) => x.fields.add(f.name)); x.ids.push(e.id); tables.set(e.table, x); }
    for (const [table, { fields, ids }] of tables) {
      const real = by.get(table);
      if (!real) { phantom.push(table); continue; }
      const allowed = NOT_IN_FILE[table] ?? {};
      for (const c of real) if (!fields.has(c) && !BOOKKEEPING.has(c) && !(c in allowed)) missing.push(`${table}.${c} (${ids.join(', ')})`);
      for (const c of Object.keys(allowed)) if (fields.has(c) || !real.has(c)) stale.push(`${table}.${c}`);
      for (const f of fields) if (!real.has(f) && !(VIRTUAL[table] ?? []).includes(f)) phantom.push(`${table}.${f}`);
    }
    expect(missing, 'Columns that no data set carries: add the column to the data set, or name it in NOT_IN_FILE with the reason').toEqual([]);
    expect(stale, 'NOT_IN_FILE names a column that is in a data set or no longer exists').toEqual([]);
    expect(phantom, 'A data set names a column its table does not have').toEqual([]);
  });

  it('data sets are consistent: unique ids, known domains and phases, references that point at a data set, and dependencies that load first', () => {
    const ids = ENTITIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const domains = new Set<string>(DOMAINS.map((d) => d.id));
    const phases = new Set<number>(PHASES.map((p) => p.phase));
    for (const e of ENTITIES) {
      expect(domains.has(e.domain), `${e.id} domain`).toBe(true);
      expect(phases.has(e.phase), `${e.id} phase`).toBe(true);
      expect(e.fields.length, e.id).toBeGreaterThan(0);
      expect(new Set(e.fields.map((f) => f.name)).size, `${e.id} has duplicate fields`).toBe(e.fields.length);
      for (const d of e.dependsOn) { const dep = entityById(d); expect(dep, `${e.id} depends on ${d}`).toBeTruthy(); expect(dep!.phase, `${e.id} (phase ${e.phase}) depends on ${d} (phase ${dep!.phase})`).toBeLessThanOrEqual(e.phase); }
      for (const f of e.fields) if (f.ref) expect(entityById(f.ref), `${e.id}.${f.name} points at ${f.ref}`).toBeTruthy();
      for (const n of e.nest ?? []) { const child = entityById(n.entity); expect(child?.byParent, `${e.id} nests ${n.entity}`).toBeTruthy(); }
      if (e.importable) expect(importFields(e).some((f) => f.required), `${e.id} needs a required field`).toBe(true);
    }
    for (const d of domains) expect(ENTITIES.some((e) => e.domain === d), `domain ${d} has data sets`).toBe(true);
  });

  it('exports every data set to CSV and JSON, nests children, and never writes a secret', async () => {
    for (const format of ['CSV', 'JSON'] as const) {
      const job = await createExportJob(db, 'root', { domains: DOMAINS.map((d) => d.id), format }, { canUnmask: false });
      const { stream } = await startExport(db, job.id, 'root');
      const chunks: Buffer[] = [];
      const rd = stream.getReader();
      for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(Buffer.from(value)); }
      // The ZIP is deflated, so look for secrets the way a reader would: read it back with an independent unzip.
      const { execFileSync } = await import('node:child_process');
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'mod-'));
      writeFileSync(join(dir, 'x.zip'), Buffer.concat(chunks));
      const text = execFileSync('python3', ['-c', 'import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None\nprint("\\n".join(z.read(n).decode("utf-8") for n in z.namelist()))', join(dir, 'x.zip')], { maxBuffer: 400 * 1024 * 1024 }).toString();
      for (const secret of ['ENC-SECRET-WEBHOOK', 'ENC-SECRET-ENDPOINT', 'CONFIG-API-KEY', 'SETTINGS-SECRET']) expect(text, `${format} export leaks ${secret}`).not.toContain(secret);
      const hashes = (await db.query(`SELECT password_hash AS h FROM users WHERE password_hash IS NOT NULL LIMIT 3`)).rows.map((r) => r.h as string);
      for (const h of hashes) expect(text, 'a password hash is in the export').not.toContain(h);
      expect(text).toContain('(not exported)'); // the secret-looking keys inside settings and endpoint config are replaced, the rest stays
      expect(text).toMatch(/mode"{1,2}:"{1,2}live/);
    }
  });

  it('JSON nests order lines under orders and invoice lines under invoices', async () => {
    const orders = entityById('orders')!;
    const page = await orders.read(db, null, 5);
    expect(page.rows.length).toBeGreaterThan(0);
    expect(orders.nest!.map((n) => n.entity).sort()).toEqual(['order_groups', 'order_lines']);
    const lines = await entityById('order_lines')!.byParent!(db, 'order_id', page.rows.map((r) => String(r.id)));
    expect(lines.length).toBeGreaterThan(0);
  });

  it('templates exist for every data set and the header matches what an export writes', async () => {
    for (const e of ENTITIES) {
      const t = await templateCsv(db, e);
      if (e.id === 'offers') continue;
      expect(t, e.id).toContain('# Meridian import template');
      expect(t.split(/\r?\n/).find((l) => !l.startsWith('#') && l.trim())!, e.id).toBe(importFields(e).filter((f) => !f.jsonOnly).map((f) => f.name).join(','));
    }
  });
});
