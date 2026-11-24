import type { Db, Queryable } from './db.js';

class RolledBack extends Error { constructor(readonly value: unknown) { super('rolled back'); } }
/**
 * Runs `fn` in a transaction, hands back what it returned, and rolls everything back: nothing is stored, no event or audit line is left. Because it is the real code in a real
 * transaction, every rule answers exactly as it would for a real write. A refusal (an exception) is thrown as usual. This is the pattern of the CSV import's check, the TMF620
 * dry run and the release preview.
 */
export async function withRollback<T>(db: Db, fn: (q: Queryable) => Promise<T>): Promise<T> {
  try { await db.tx(async (q) => { throw new RolledBack(await fn(q)); }); }
  catch (e) { if (e instanceof RolledBack) return e.value as T; throw e; }
  throw new Error('unreachable');
}
