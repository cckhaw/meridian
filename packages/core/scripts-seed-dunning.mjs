// Installs the out-of-the-box collections ladders for a SEA market: pnpm --filter @meridian/core seed:dunning [MY|SG|TH|PH|ID]
import { openDb, seedDunningRules } from './src/index.ts';

const db = await openDb();
try {
  const r = await seedDunningRules(db, { market: process.argv[2], actor: 'cli' });
  console.log(`Market ${r.market}: created ${r.created.join(', ') || 'nothing'}${r.skipped.length ? `; kept ${r.skipped.join(', ')}` : ''}`);
} finally { await db.close(); }
