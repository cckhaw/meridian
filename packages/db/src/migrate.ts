import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const dir = join(import.meta.dirname, '..', 'migrations');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://meridian:meridian@localhost:5432/meridian' });
await client.connect();
await client.query('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  const done = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
  if (done.rowCount) continue;
  await client.query('BEGIN');
  try {
    await client.query(readFileSync(join(dir, file), 'utf8'));
    await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log('applied', file);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}
await client.end();
