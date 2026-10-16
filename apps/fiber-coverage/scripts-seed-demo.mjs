// Loads sample Singapore coverage into the database named by DATABASE_URL (or the embedded database in MERIDIAN_DATA_DIR).
// Demo data only: refuses to run against a real database unless you say so.
import { openDb } from '@meridian/core';
import { seedFiberDemo } from '@meridian/fiber';

const db = await openDb();
if (db.kind === 'postgres' && process.argv[2] !== '--yes') { console.error('This would write demo data to the database in DATABASE_URL. Run again with --yes if that is what you want.'); process.exit(1); }
console.log((await seedFiberDemo(db)) ? 'Demo coverage loaded.' : 'Demo coverage is already there.');
await db.close();
