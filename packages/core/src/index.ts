import { superuserProblem } from './auth.js';
import { configIssues } from './config.js';
import { openDb, type Db } from './db.js';
import { seedDemo, seedReference } from './seed.js';

export * from './audit.js';
export * from './auth.js';
export * from './passwords.js';
export * from './paging.js';
export * from './search.js';
export * from './rbac.js';
export * from './nrm.js';
export * from './nrm-pools.js';
export * from './port-in.js';
export * from './donor-operators.js';
export * from './group-orders.js';
export * from './number-reservation.js';
export * from './vip-pattern-matcher.js';
export * from './order-numbering.js';
export * from './deposits.js';
export * from './lifecycle-config.js';
export * from './lifecycle-state.js';
export * from './lifecycle-service.js';
export * from './warehouses.js';
export * from './roles-config.js';
export * from './billing.js';
export * from './bill-runs.js';
export * from './billing-simulation.js';
export * from './billing-templates.js';
export * from './print-house.js';
export * from './cases.js';
export * from './catalog.js';
export * from './config.js';
export * from './customers.js';
export * from './customer-config.js';
export * from './dates.js';
export * from './db.js';
export * from './errors.js';
export * from './etc.js';
export * from './hierarchy.js';
export * from './inventory.js';
export * from './inventory-import.js';
export * from './offer-import.js';
export * from './ledger.js';
export * from './coa.js';
export * from './sap-exporter.js';
export * from './sub-ledger.js';
export * from './journal-batches.js';
export * from './reconciliation.js';
export * from './commission.js';
export * from './commission-processor.js';
export * from './lifecycle.js';
export * from './orders.js';
export * from './order-pricing.js';
export * from './bundles.js';
export * from './reports.js';
export * from './seed.js';
export * from './shard.js';
export * from './tax.js';

const g = globalThis as unknown as { __meridianDb?: Promise<Db> };

/**
 * Process-wide database handle (survives Next.js dev reloads).
 * Seeding, MERIDIAN_SEED = none | starter | demo (`reference` is an alias of `starter`):
 *   none    empty database: the operator defines their own catalog (default in production)
 *   starter a sample catalog and stock to edit, no customers
 *   demo    starter + fake customers, orders and invoices (development only)
 * Default: `demo` on the embedded dev database, `none` everywhere else.
 */
export function getDb(): Promise<Db> {
  g.__meridianDb ??= (async () => {
    const issues = configIssues(process.env, superuserProblem());
    if (issues.length) throw new Error(`Refusing to start: ${issues.join('; ')}`);
    const db = await openDb();
    const raw = process.env.MERIDIAN_SEED ?? (db.kind === 'pglite' && process.env.NODE_ENV !== 'production' ? 'demo' : 'none');
    const mode = raw === 'reference' ? 'starter' : raw;
    if (mode === 'starter' || mode === 'demo') await seedReference(db);
    if (mode === 'demo') await seedDemo(db);
    return db;
  })();
  g.__meridianDb.catch(() => { g.__meridianDb = undefined; }); // a failed start must be retried, not cached
  return g.__meridianDb;
}
export * from './settings.js';
export * from './apikeys.js';
export * from './field-crypto.js';
export * from './gateways.js';
export * from './kyc.js';
export * from './store.js';
export * from './store-settings.js';
export * from './cancellation.js';
export * from './dealers.js';
export * from './segments.js';
export * from './groups.js';
export * from './stores.js';
export * from './offer-config.js';
export * from './service-kinds.js';
export * from './integrations.js';
export * from './ocs.js';
export { OCS_COMMAND_LABEL, OCS_VENDORS, GENERIC_REST_EXAMPLE, TEMPLATE_VARS } from './ocs-vendors/index.js';
export type { OcsConnector, OcsRequest, OcsResult, OcsCommandName } from './ocs-vendors/index.js';
export * from './bulk-import.js';
export * from './migration/index.js';
export { BLOCK_TYPES, defaultTemplate, PAGE_SIZES_MM, sampleInvoice, STREAMS as BILL_STREAMS, TOKENS as BILL_TOKENS, validateTemplate } from './billing-docs/schema.js';
export type { Block, InvoiceDoc, TemplateSchema } from './billing-docs/schema.js';
export { DEFAULT_PRINT_PROFILE, SCREEN_PROFILE, type PrintProfile } from './billing-docs/pdf.js';
export type { ConversionReport } from './billing-docs/legacy.js';
export * from './case-taxonomy.js';
export * from './interactions.js';
export * from './case-sla.js';
export * from './case-incidents.js';
export * from './case-refunds.js';
export * from './workforce.js';
export * from './wfm-webhook.js';
export { WFM_VENDORS, wfmVendor, type WfmVendor, type WfmSlot, type WfmConnector } from './wfm/index.js';
export * from './tmf.js';
export * from './dunning-rules.js';
export * from './dunning-engine.js';
export * from './dunning-templates.js';
export * from './seed-dunning-rules.js';
export * from './collections.js';
export * from './emv-qr.js';
export * from './integration-hub.js';
export * from './oauth.js';
export * from './gateway.js';
export * from './subscriber-ops.js';
export * from './events.js';
export * from './northbound-orders.js';
export * from './stock-transfers.js';
export * from './etc-formula.js';
export * from './etc-rules.js';
export * from './device-financing.js';
export * from './financing-check.js';
export * from './security-policy.js';
export * from './password-recovery.js';
export * from './mfa.js';
export * from './profile.js';
export * from './permission-catalog.js';
export * from './access-guards.js';
