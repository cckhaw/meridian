import { openDb } from '../src/db.ts';
import { seedReference } from '../src/seed.ts';
const db = await openDb({ url: process.env.BENCH_URL });
await seedReference(db);
console.log('schema ready'); await db.close();
