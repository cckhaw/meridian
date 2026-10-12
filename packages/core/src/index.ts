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
export * from './billing.js';
export * from './cases.js';
export * from './catalog.js';
export * from './config.js';
export * from './customers.js';
export * from './dates.js';
export * from './db.js';
export * from './errors.js';
export * from './etc.js';
export * from './hierarchy.js';
export * from './inventory.js';
export * from './ledger.js';
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
