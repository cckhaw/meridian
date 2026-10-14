import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from './migrations.generated.js';

describe('migration 0026 on a ledger that already has entries', () => {
  it('moves every existing line into the partitioned, immutable sub-ledger with its batch link and sequence intact', async () => {
    const lite = new PGlite({ extensions: { ltree } });
    const idx = MIGRATIONS.findIndex((m) => m.name.startsWith('0026_'));
    expect(idx).toBeGreaterThan(0);
    for (const m of MIGRATIONS.slice(0, idx)) await lite.exec(m.sql);
    const b = (await lite.query<{ id: string }>(`INSERT INTO gl_batches (entry_count, debit_minor, credit_minor) VALUES (2,500,500) RETURNING id`)).rows[0]!;
    const j = '11111111-1111-1111-1111-111111111111';
    await lite.query(`INSERT INTO gl_entries (journal_id, entry_date, source_type, source_id, account_code, description, debit_minor, credit_minor, currency, exported_batch_id)
      VALUES ($1,'2024-06-15','INVOICE','INV-1','1200','AR',500,0,'SGD',$2), ($1,'2024-06-15','INVOICE','INV-1','4000','Rev',0,500,'SGD',$2), ($1,'2031-01-02','PAYMENT','P-1','1100','Cash',7,0,'SGD',NULL)`, [j, b.id]);
    for (const m of MIGRATIONS.slice(idx)) await lite.exec(m.sql);
    const rows = (await lite.query<{ account_code: string; event_type: string; exported_batch_id: string | null }>(`SELECT account_code, event_type, exported_batch_id FROM gl_entries ORDER BY id`)).rows;
    expect(rows.map((r) => r.account_code)).toEqual(['1200', '4000', '1100']);
    expect(rows.map((r) => r.event_type)).toEqual(['INVOICE_GENERATED', 'INVOICE_GENERATED', 'PAYMENT_SUCCESS']);
    expect(rows[0]!.exported_batch_id).toBe(b.id);
    expect(rows[2]!.exported_batch_id).toBeNull();
    const next = (await lite.query<{ id: string }>(`INSERT INTO gl_entries (journal_id, entry_date, source_type, source_id, account_code, description, debit_minor, currency) VALUES ($1,'2026-03-03','X','x','1','d',1,'SGD') RETURNING id`, [j])).rows[0]!;
    expect(Number(next.id)).toBeGreaterThan(3); // the sequence carried on
    await expect(lite.query('DELETE FROM gl_entries')).rejects.toThrow();
    expect((await lite.query<{ n: string }>(`SELECT count(*) AS n FROM pg_inherits WHERE inhparent='gl_entries'::regclass`)).rows[0]!.n).not.toBe('0');
    await lite.close();
  }, 60_000);
});
