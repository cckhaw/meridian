import { openDb, type Db } from './db.js';
import { seedDemo, seedReference } from './seed.js';

export * from './audit.js';
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
export * from './reports.js';
export * from './seed.js';
export * from './shard.js';
export * from './tax.js';

const g = globalThis as unknown as { __meridianDb?: Promise<Db> };

/**
 * Process-wide database handle (survives Next.js dev reloads). Seeding: MERIDIAN_SEED = none | reference | demo.
 * Default: `demo` on the embedded database, `reference` (catalog + stock only) on a real DATABASE_URL.
 */
export function getDb(): Promise<Db> {
  g.__meridianDb ??= (async () => {
    const db = await openDb();
    const mode = process.env.MERIDIAN_SEED ?? (db.kind === 'pglite' ? 'demo' : 'reference');
    if (mode !== 'none') await seedReference(db);
    if (mode === 'demo') await seedDemo(db);
    return db;
  })();
  return g.__meridianDb;
}
