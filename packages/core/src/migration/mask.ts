import { createHmac } from 'node:crypto';
import type { EntityDef, FieldDef, Rec } from './types.js';

/**
 * Masking of sensitive fields in exports. A masked value is never the real one:
 *  MASK       keeps the last characters so a person can recognise it (****4567), for account numbers and the like;
 *  PSEUDONYM  is a keyed one-way code (h:3fa9…): the same value always gives the same code, so records can still be matched, but it cannot be turned back.
 * The key is the server's data key, so the codes cannot be recomputed from outside.
 */
const key = () => process.env.MERIDIAN_DATA_KEY ?? process.env.MERIDIAN_ID_PEPPER ?? 'dev-only-pepper';
export const PSEUDONYM_PREFIX = 'h:';
export const MASK_MARK = '****';

export function maskValue(kind: NonNullable<FieldDef['sensitive']>, v: unknown): unknown {
  if (v === null || v === undefined || v === '') return v;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (kind === 'PSEUDONYM') return PSEUDONYM_PREFIX + createHmac('sha256', key()).update(s).digest('hex').slice(0, 16);
  const tail = s.length > 8 ? s.slice(-4) : s.length > 4 ? s.slice(-2) : '';
  return MASK_MARK + tail;
}

/** True for a value that is the output of masking, which must never be loaded back as if it were data. */
export const looksMasked = (v: unknown) => typeof v === 'string' && (v.startsWith(MASK_MARK) || /^h:[0-9a-f]{16}$/.test(v));

/** The row with its sensitive fields masked, unless `unmasked`. */
export function maskRecord(def: EntityDef, r: Rec, unmasked: boolean): Rec {
  if (unmasked) return r;
  let out: Rec | null = null;
  for (const f of def.fields) {
    if (!f.sensitive) continue;
    // A row read from the database has camelCased keys; one built for a file is named as the column.
    const k = f.name in r ? f.name : f.name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    if (!(k in r)) continue;
    out ??= { ...r };
    out[k] = maskValue(f.sensitive, r[k]);
  }
  return out ?? r;
}
