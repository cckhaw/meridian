// Re-encrypts stored secrets and identity data under the current data key: pnpm --filter @meridian/core rekey [--dry-run] [--table=<name>] [--batch=<n>]
// Needs DATABASE_URL and the same MERIDIAN_DATA_KEY / MERIDIAN_DATA_KEY_ID / MERIDIAN_DATA_KEYS_OLD the application runs with (see docs/OPERATIONS.md, "Rotating the data key").
import { dataKeyStatus, openDb, rekeyAll } from './src/index.ts';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dryRun = args.includes('--dry-run');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set: this runs against a real database.'); process.exit(2); }

const status = dataKeyStatus();
console.log(`Current data key: id ${status.currentId}. Retired keys that can still be read: ${status.retiredIds.length ? status.retiredIds.join(', ') : 'none'}.`);
const db = await openDb({ url: process.env.DATABASE_URL });
try {
  const only = flag('table') ? [flag('table')] : undefined;
  const results = await rekeyAll(db, { dryRun, only, batch: flag('batch') ? Number(flag('batch')) : undefined, onProgress: (r) => console.log(`${r.target}: ${r.scanned} read, ${r.rewritten} ${dryRun ? 'would be rewritten' : 'rewritten'}, ${r.failed} could not be read`) });
  const failed = results.reduce((n, r) => n + r.failed, 0);
  for (const r of results) for (const e of r.errors) console.error(`  ${e}`);
  console.log(dryRun ? 'Dry run: nothing was written.' : `Done: ${results.reduce((n, r) => n + r.rewritten, 0)} values re-encrypted.`);
  if (failed) { console.error(`${failed} value(s) could not be read with the configured keys: add the key they were written with to MERIDIAN_DATA_KEYS_OLD and run again. Do not remove any old key yet.`); process.exitCode = 1; }
} finally { await db.close(); }
