import type { Db, Queryable } from './db.js';
import { reencryptBytes, reencryptText } from './field-crypto.js';

/**
 * Re-encrypts what is stored under the current data key (see field-crypto.ts): everything written before key versions existed, and everything written under a retired key. It is the
 * second step of rotating the key and is safe to run any time, more than once, and while the system is in use: a value is replaced only if it is still what was read (a concurrent
 * change wins), a value already on the current key is left alone, and each batch is its own transaction. A value that cannot be read (its key is not configured, or it is damaged) is
 * reported and left as it is.
 */
export interface RekeyTarget {
  name: string; table: string; pk: string[];
  /** SQL for the stored value, as text (base64) or bytea */
  read: string; kind: 'text' | 'bytea'; where?: string;
  /** SQL assignment for the new value (the argument is its placeholder) and the condition that the stored value is still the old one */
  set: (p: string) => string; same: (p: string) => string;
}

const plain = (column: string) => ({ read: column, where: `${column} IS NOT NULL`, set: (p: string) => `${column} = ${p}`, same: (p: string) => `${column} = ${p}` });

export const REKEY_TARGETS: RekeyTarget[] = [
  { name: 'KYC ID numbers', table: 'kyc_cases', pk: ['id'], kind: 'text', ...plain('id_number_enc') },
  { name: 'Integration secrets', table: 'integration_endpoints', pk: ['id'], kind: 'text', ...plain('secret_enc') },
  { name: 'Webhook and listener secrets', table: 'webhook_subscriptions', pk: ['id'], kind: 'text', ...plain('secret_enc') },
  { name: 'API key signing secrets', table: 'api_clients', pk: ['id'], kind: 'text', ...plain('hmac_secret_enc') },
  { name: 'Authenticator (TOTP) secrets', table: 'mfa_methods', pk: ['user_id', 'kind'], kind: 'text', ...plain('secret_enc') },
  { name: 'Fibre partner secrets', table: 'fiber_providers', pk: ['id'], kind: 'text', ...plain('adapter_secret_enc') },
  { name: 'Document images', table: 'documents', pk: ['id'], kind: 'bytea', read: 'data', where: 'encrypted AND data IS NOT NULL', set: (p) => `data = ${p}`, same: (p) => `data = ${p}` },
  {
    name: 'Signatures on applications', table: 'applications', pk: ['id'], kind: 'text', read: `agreement->>'signatureEnc'`, where: `agreement->>'signatureEnc' IS NOT NULL`,
    set: (p) => `agreement = jsonb_set(agreement, '{signatureEnc}', to_jsonb(${p}::text))`, same: (p) => `agreement->>'signatureEnc' = ${p}::text`,
  },
];

export interface RekeyResult { target: string; scanned: number; rewritten: number; failed: number; errors: string[] }
export interface RekeyOptions { dryRun?: boolean; batch?: number; only?: string[]; onProgress?: (r: RekeyResult) => void }

async function rekeyTarget(db: Db, t: RekeyTarget, o: RekeyOptions): Promise<RekeyResult> {
  const res: RekeyResult = { target: t.name, scanned: 0, rewritten: 0, failed: 0, errors: [] };
  const batch = Math.min(Math.max(o.batch ?? 200, 1), 2000);
  const n = t.pk.length;
  const keyList = t.pk.join(', ');
  let after: string[] | null = null;
  for (;;) {
    // keyset paging over the primary key: the table is read once, in order, and a huge one costs no more per batch than a small one
    const cursor = after ? `(${keyList}) > (${t.pk.map((c, i) => `$${i + 1}::${c === 'kind' ? 'text' : c === 'user_id' || c === 'id' ? 'uuid' : 'text'}`).join(', ')})` : 'true';
    const cols = t.pk.map((c, i) => `${c}::text AS pk${i}`).join(', ');
    const rows = (await db.query(`SELECT ${cols}, ${t.read} AS value FROM ${t.table} WHERE ${t.where ?? 'true'} AND ${cursor} ORDER BY ${keyList} LIMIT ${batch}`, after ?? [])).rows as Array<Record<string, unknown>>;
    if (!rows.length) break;
    await db.tx(async (q: Queryable) => {
      for (const r of rows) {
        res.scanned++;
        const old = r.value as string | Buffer | null;
        const id = t.pk.map((_, i) => String(r[`pk${i}`]));
        if (old === null || old === undefined) continue;
        try {
          const fresh = t.kind === 'text' ? reencryptText(old as string) : reencryptBytes(Buffer.from(old as Buffer));
          if (fresh === null) continue;
          if (o.dryRun) { res.rewritten++; continue; }
          const where = t.pk.map((c, i) => `${c}::text = $${i + 1}`).join(' AND ');
          const updated = await q.query(`UPDATE ${t.table} SET ${t.set(`$${n + 1}`)} WHERE ${where} AND ${t.same(`$${n + 2}`)}`, [...id, fresh, old]);
          if (updated.rowCount) res.rewritten++;       // 0 rows: it changed since it was read, and the newer value was written with the current key
        } catch (e) {
          res.failed++;
          if (res.errors.length < 5) res.errors.push(`${t.table} ${id.join('/')}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    });
    const last = rows[rows.length - 1]!;
    after = t.pk.map((_, i) => String(last[`pk${i}`]));
    if (rows.length < batch) break;
  }
  o.onProgress?.(res);
  return res;
}

/** Re-encrypts every stored value under the current key. With `dryRun`, nothing is written and `rewritten` counts what would be. */
export async function rekeyAll(db: Db, o: RekeyOptions = {}): Promise<RekeyResult[]> {
  const out: RekeyResult[] = [];
  for (const t of REKEY_TARGETS) if (!o.only || o.only.includes(t.table)) out.push(await rekeyTarget(db, t, o));
  return out;
}
