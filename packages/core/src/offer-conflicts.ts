import { audit } from './audit.js';
import type { Queryable } from './db.js';
import { invalid } from './errors.js';
import { getOfferType, listOfferTypes } from './offer-config.js';

/**
 * Which offer types cannot be sold in the same order (for example fibre broadband and a mobile plan). A pair is stored once and works both ways; two offers
 * of the same type are never compared here (that is "Only one per order" on the type itself). The order screen greys the second offer out, and the order
 * engine refuses the combination whichever channel it comes from.
 */
export type TypePair = [string, string];

const key = (a: string, b: string): TypePair => (a < b ? [a, b] : [b, a]);

export async function getTypeConflicts(q: Queryable): Promise<TypePair[]> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='offerTypeConflicts'`)).rows[0]?.value;
  const raw: unknown[] = Array.isArray(v?.pairs) ? v.pairs : [];
  return raw.filter((p): p is TypePair => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string').map(([a, b]) => key(a, b));
}

export async function setTypeConflicts(q: Queryable, actor: string, pairs: Array<[string, string]>): Promise<TypePair[]> {
  if (!Array.isArray(pairs) || pairs.length > 200) throw invalid('Give a list of up to 200 pairs of offer types.');
  const seen = new Map<string, TypePair>();
  for (const [a, b] of pairs) {
    if (a === b) throw invalid('Choose two different offer types: a type on its own is limited with “Only one per order” on the type.');
    for (const id of [a, b]) if (!(await getOfferType(q, id))) throw invalid(`There is no offer type ${id}.`);
    const k = key(a, b);
    seen.set(k.join('|'), k);
  }
  const next = [...seen.values()];
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('offerTypeConflicts', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify({ pairs: next }), actor]);
  await audit(q, actor, 'settings', 'offerTypeConflicts', 'update', { pairs: next });
  return next;
}

/** The first rule broken by a set of offers (each with its type and name), as a sentence for the person ordering, or null. */
export async function typeConflictIn(q: Queryable, offers: Array<{ kind?: string | null; name: string }>): Promise<string | null> {
  const pairs = await getTypeConflicts(q);
  if (!pairs.length) return null;
  const types = new Map((await listOfferTypes(q)).map((t) => [t.id, t.name]));
  for (const [a, b] of pairs) {
    const x = offers.find((o) => o.kind === a), y = offers.find((o) => o.kind === b);
    if (x && y) return `${x.name} (${types.get(a) ?? a}) cannot be ordered together with ${y.name} (${types.get(b) ?? b}). Place them as separate orders.`;
  }
  return null;
}
