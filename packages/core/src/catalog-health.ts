import type { Queryable, Row } from './db.js';
import { allAncestorsLiveSql } from './catalog.js';
import { invalid } from './errors.js';
import { marketMode } from './settings.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';

/**
 * Catalogue health: things in the catalogue that are probably wrong, found by the database in one pass over the offers (never by loading the tree), so it costs the same
 * with tens of thousands of offers. Every check is a read-only query that returns one row per finding, ordered by a key, and is paged with a cursor like every other list
 * (docs/SCALE.md); the summary counts are capped, so a catalogue with a very large number of findings says "10,000+" instead of counting them all.
 *
 * A check that needs the whole `requires` / `excludes` graph does it in SQL (a recursive query with a depth limit), and the one that looks at promotions reads the
 * (few) bundle rules, which live in their own table.
 */
export type HealthSeverity = 'ERROR' | 'WARNING' | 'INFO';
export interface HealthCheck { id: string; title: string; severity: HealthSeverity; description: string }
export interface HealthRow { key: string; id: string; name: string; status: string; message: string; related: Array<{ id: string; name: string }>; entity: 'node' | 'bundle_rule' }

export const HEALTH_CAP = 10_000;
export interface HealthOptions { minAgeDays?: number; nearPriceBps?: number }
interface Resolved { minAgeDays: number; nearPriceBps: number }
interface Ctx { multiMarket: boolean }
type P = (v: unknown) => string;
type Check = HealthCheck & { when?: (c: Ctx) => boolean } & ({ sql: (p: P, o: Resolved) => string } | { rows: (q: Queryable) => Promise<HealthRow[]> });

const resolve = (o: HealthOptions = {}): Resolved => {
  const minAgeDays = o.minAgeDays ?? 30, nearPriceBps = o.nearPriceBps ?? 100;
  if (!Number.isInteger(minAgeDays) || minAgeDays < 0 || minAgeDays > 3650) throw invalid('minAgeDays is 0 to 3650.');
  if (!Number.isInteger(nearPriceBps) || nearPriceBps < 1 || nearPriceBps > 2000) throw invalid('nearPriceBps is 1 to 2000 (hundredths of a percent).');
  return { minAgeDays, nearPriceBps };
};

/** The ids a requires/excludes list names, as (kind, token) rows. */
const DEP_TOKENS = (alias: string) => `CROSS JOIN LATERAL (
    SELECT 'requires' AS kind, v AS token FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${alias}.data->'requires') = 'array' THEN ${alias}.data->'requires' ELSE '[]'::jsonb END) v
    UNION ALL
    SELECT 'excludes', v FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${alias}.data->'excludes') = 'array' THEN ${alias}.data->'excludes' ELSE '[]'::jsonb END) v) d`;
/** An offer's prices without the id each price may carry, so two offers with the same prices compare equal. */
const PRICE_SIG = (alias: string) => `(SELECT COALESCE(jsonb_agg(e.p - 'id' ORDER BY e.ord), '[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${alias}.data->'prices') = 'array' THEN ${alias}.data->'prices' ELSE '[]'::jsonb END) WITH ORDINALITY e(p, ord))`;
const MONTHLY = (alias: string) => `(SELECT (e.p->'amount'->>'amountMinor')::bigint FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${alias}.data->'prices') = 'array' THEN ${alias}.data->'prices' ELSE '[]'::jsonb END) e(p) WHERE e.p->>'type' = 'RECURRING' LIMIT 1)`;
const TERM = (alias: string) => `COALESCE(${alias}.data->'contract'->>'termMonths', '0')`;

export const HEALTH_CHECKS: Check[] = [
  {
    id: 'NEVER_SOLD', title: 'Offers never sold', severity: 'WARNING',
    description: 'Active or retired offers older than the chosen age (default 30 days) that no service and no order line has ever used: candidates to retire or delete.',
    sql: (p, o) => `SELECT n.id AS k, n.id, n.name, n.status, 'Created ' || to_char(n.created_at, 'YYYY-MM-DD') || ' and never sold.' AS message, '[]'::jsonb AS related, 'node' AS entity
      FROM catalog_nodes n WHERE n.level = 'OFFER' AND n.status IN ('ACTIVE', 'RETIRED') AND n.created_at < now() - make_interval(days => ${p(o.minAgeDays)}::int)
        AND NOT EXISTS (SELECT 1 FROM services s WHERE s.offer_id = n.id) AND NOT EXISTS (SELECT 1 FROM order_lines l WHERE l.offer_id = n.id)`,
  },
  {
    id: 'UNREACHABLE', title: 'Active offers that cannot be sold', severity: 'ERROR',
    description: 'The offer is Active but a group, category or network type above it is not live, so it is hidden from every sales channel (the same rule as isSellableNow).',
    sql: () => `SELECT n.id AS k, n.id, n.name, n.status,
        'Not on sale: its ' || lower(replace(b.level, '_', ' ')) || ' ' || b.name || ' is ' || CASE b.status WHEN 'RETIRED' THEN 'retired' WHEN 'DRAFT' THEN 'still a draft' ELSE 'scheduled and not live yet' END || '.' AS message,
        jsonb_build_array(jsonb_build_object('id', b.id, 'name', b.name)) AS related, 'node' AS entity
      FROM catalog_nodes n
      CROSS JOIN LATERAL (WITH RECURSIVE up(id, name, level, status, parent_id, depth) AS (
          SELECT a.id, a.name, a.level, a.status, a.parent_id, 1 FROM catalog_nodes a WHERE a.id = n.parent_id
          UNION ALL SELECT a.id, a.name, a.level, a.status, a.parent_id, up.depth + 1 FROM catalog_nodes a JOIN up ON a.id = up.parent_id)
        SELECT id, name, level, status FROM up WHERE status <> 'ACTIVE' ORDER BY depth DESC LIMIT 1) b
      WHERE n.level = 'OFFER' AND n.status = 'ACTIVE'`,
  },
  {
    id: 'DEP_MISSING', title: 'Prerequisites or exclusions that do not exist', severity: 'ERROR',
    description: 'An active or scheduled offer names a product or group in "customer must first have" or "cannot be bought together with" that is no longer in the catalogue.',
    sql: () => `SELECT n.id || '|' || d.kind || '|' || d.token AS k, n.id, n.name, n.status,
        CASE d.kind WHEN 'requires' THEN 'Requires ' ELSE 'Excludes ' END || d.token || ', which does not exist.' AS message, '[]'::jsonb AS related, 'node' AS entity
      FROM catalog_nodes n ${DEP_TOKENS('n')} LEFT JOIN catalog_nodes t ON t.id = d.token
      WHERE n.level = 'OFFER' AND n.status IN ('ACTIVE', 'SCHEDULED') AND t.id IS NULL`,
  },
  {
    id: 'DEP_REQUIRES_DEAD', title: 'Prerequisites that cannot be met', severity: 'ERROR',
    description: 'An offer requires a product or group that is retired, not live, hidden by a parent that is not live, or a group with nothing on sale in it: new customers can never buy the offer.',
    sql: () => `SELECT n.id || '|' || d.token AS k, n.id, n.name, n.status,
        'Requires ' || t.name || ', which ' || CASE WHEN t.status = 'RETIRED' THEN 'is retired' WHEN t.status <> 'ACTIVE' THEN 'is not live yet (' || lower(t.status) || ')'
          WHEN NOT (${allAncestorsLiveSql('t')}) THEN 'sits under something that is not live' ELSE 'has no offer on sale beneath it' END || '.' AS message,
        jsonb_build_array(jsonb_build_object('id', t.id, 'name', t.name)) AS related, 'node' AS entity
      FROM catalog_nodes n ${DEP_TOKENS('n')} JOIN catalog_nodes t ON t.id = d.token
      WHERE n.level = 'OFFER' AND n.status IN ('ACTIVE', 'SCHEDULED') AND d.kind = 'requires'
        AND (t.status <> 'ACTIVE' OR NOT (${allAncestorsLiveSql('t')})
             OR (t.level <> 'OFFER' AND NOT EXISTS (SELECT 1 FROM catalog_nodes o WHERE o.level = 'OFFER' AND o.status = 'ACTIVE' AND (o.path = t.path OR o.path LIKE t.path || '/%') AND ${allAncestorsLiveSql('o')})))`,
  },
  {
    id: 'DEP_EXCLUDES_DEAD', title: 'Exclusions on things no longer on sale', severity: 'INFO',
    description: 'An offer says it cannot be bought together with an offer that is retired or not live. Harmless, but the rule can be removed.',
    sql: () => `SELECT n.id || '|' || d.token AS k, n.id, n.name, n.status,
        'Excludes ' || t.name || ', which is ' || CASE WHEN t.status = 'RETIRED' THEN 'retired' WHEN t.status <> 'ACTIVE' THEN 'not live (' || lower(t.status) || ')' ELSE 'hidden by a parent that is not live' END || '.' AS message,
        jsonb_build_array(jsonb_build_object('id', t.id, 'name', t.name)) AS related, 'node' AS entity
      FROM catalog_nodes n ${DEP_TOKENS('n')} JOIN catalog_nodes t ON t.id = d.token
      WHERE n.level = 'OFFER' AND n.status IN ('ACTIVE', 'SCHEDULED') AND d.kind = 'excludes' AND (t.status <> 'ACTIVE' OR NOT (${allAncestorsLiveSql('t')}))`,
  },
  {
    id: 'DEP_CIRCULAR', title: 'Circular prerequisites', severity: 'ERROR',
    description: 'A needs B, B needs C and C needs A (a group counts as every offer in it). Nobody can buy any of them first. The catalogue refuses these when they are saved, but moving an offer into a group, or an import, can create one.',
    sql: () => `WITH RECURSIVE edges AS (
        SELECT n.id AS src, t.level AS tlevel, t.id AS tid, t.path AS tpath
        FROM catalog_nodes n JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(n.data->'requires') = 'array' THEN n.data->'requires' ELSE '[]'::jsonb END) v ON true
        JOIN catalog_nodes t ON t.id = v WHERE n.level = 'OFFER' AND n.status <> 'RETIRED'),
      dst AS (SELECT e.src, o.id AS dst FROM edges e JOIN catalog_nodes o ON o.level = 'OFFER' AND o.status <> 'RETIRED'
              AND ((e.tlevel = 'OFFER' AND o.id = e.tid) OR (e.tlevel <> 'OFFER' AND (o.path = e.tpath OR o.path LIKE e.tpath || '/%')))),
      walk(start, cur, depth, path) AS (
        SELECT src, dst, 1, ARRAY[src, dst] FROM dst
        UNION ALL SELECT w.start, d.dst, w.depth + 1, w.path || d.dst FROM walk w JOIN dst d ON d.src = w.cur
          WHERE w.depth < 6 AND w.cur <> w.start AND (d.dst = w.start OR d.dst <> ALL(w.path))),
      cycles AS (SELECT DISTINCT ON (start) start, path FROM walk WHERE cur = start AND start = (SELECT min(x) FROM unnest(path) x) ORDER BY start, depth)
      SELECT c.start AS k, c.start AS id, n.name, n.status,
        'Circular: ' || (SELECT string_agg(m.name, ' → ' ORDER BY u.ord) FROM unnest(c.path) WITH ORDINALITY u(id, ord) JOIN catalog_nodes m ON m.id = u.id) || '.' AS message,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name)), '[]'::jsonb) FROM catalog_nodes m WHERE m.id = ANY(c.path) AND m.id <> c.start) AS related, 'node' AS entity
      FROM cycles c JOIN catalog_nodes n ON n.id = c.start`,
  },
  {
    id: 'DEP_SELF_CONFLICT', title: 'Rules that contradict themselves', severity: 'ERROR',
    description: 'An offer that requires itself or the group it sits in, excludes itself, or excludes the very product it requires (or something inside a required group). Saving refuses these; moving an offer between groups can create one.',
    sql: () => `SELECT n.id || '|self|' || d.token AS k, n.id, n.name, n.status,
          'Requires ' || t.name || ', which ' || CASE WHEN t.id = n.id THEN 'is this offer itself' ELSE 'contains this offer' END || '.' AS message,
          jsonb_build_array(jsonb_build_object('id', t.id, 'name', t.name)) AS related, 'node' AS entity
        FROM catalog_nodes n ${DEP_TOKENS('n')} JOIN catalog_nodes t ON t.id = d.token
        WHERE n.level = 'OFFER' AND n.status <> 'RETIRED' AND d.kind = 'requires' AND (t.id = n.id OR (t.level <> 'OFFER' AND n.path LIKE t.path || '/%'))
      UNION ALL
      SELECT n.id || '|exself', n.id, n.name, n.status, 'Excludes itself.', '[]'::jsonb, 'node'
        FROM catalog_nodes n ${DEP_TOKENS('n')} WHERE n.level = 'OFFER' AND n.status <> 'RETIRED' AND d.kind = 'excludes' AND d.token = n.id
      UNION ALL
      SELECT n.id || '|clash|' || rq.token || '|' || ex.token, n.id, n.name, n.status,
          'Requires ' || t.name || ' but excludes ' || e.name || (CASE WHEN e.id = t.id THEN ' (the same product).' ELSE ', which is inside it.' END),
          jsonb_build_array(jsonb_build_object('id', t.id, 'name', t.name), jsonb_build_object('id', e.id, 'name', e.name)), 'node'
        FROM catalog_nodes n
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(n.data->'requires') = 'array' THEN n.data->'requires' ELSE '[]'::jsonb END) rq(token)
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(n.data->'excludes') = 'array' THEN n.data->'excludes' ELSE '[]'::jsonb END) ex(token)
        JOIN catalog_nodes t ON t.id = rq.token JOIN catalog_nodes e ON e.id = ex.token
        WHERE n.level = 'OFFER' AND n.status <> 'RETIRED' AND (e.id = t.id OR (t.level <> 'OFFER' AND e.path LIKE t.path || '/%'))`,
  },
  {
    id: 'PRICE_DUPLICATE', title: 'Offers with identical prices in one group', severity: 'WARNING',
    description: 'Two or more active or scheduled offers in the same group, of the same type and contract term, with exactly the same prices: usually a copy that was never retired, or a price point sold twice.',
    sql: () => `SELECT g.parent_id || '|' || g.first_id AS k, g.first_id AS id, g.first_name AS name, g.first_status AS status,
        'Same type, term and prices as ' || (g.cnt - 1) || ' other offer' || CASE WHEN g.cnt = 2 THEN '' ELSE 's' END || ' in this group.' AS message, g.related, 'node' AS entity
      FROM (SELECT s.parent_id, count(*) AS cnt, (array_agg(s.id ORDER BY s.id))[1] AS first_id, (array_agg(s.name ORDER BY s.id))[1] AS first_name, (array_agg(s.status ORDER BY s.id))[1] AS first_status,
              jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) ORDER BY s.id) AS related
            FROM (SELECT n.id, n.name, n.status, n.parent_id, n.kind, ${TERM('n')} AS term, ${PRICE_SIG('n')} AS sig
                  FROM catalog_nodes n WHERE n.level = 'OFFER' AND n.status IN ('ACTIVE', 'SCHEDULED')) s
            WHERE jsonb_array_length(s.sig) > 0
            GROUP BY s.parent_id, s.kind, s.term, s.sig HAVING count(*) > 1) g`,
  },
  {
    id: 'PRICE_NEAR', title: 'Offers with nearly identical prices in one group', severity: 'INFO',
    description: 'Offers in the same group, of the same type and term, whose monthly fee is within the chosen tolerance (default 1%) of the next one but whose prices are not identical: a price point that may be sold twice by mistake.',
    sql: (p, o) => `SELECT r.parent_id || '|' || r.id AS k, r.id, r.name, r.status,
        'Monthly fee ' || r.monthly || ' is within ' || (${p(o.nearPriceBps)}::int / 100.0) || '% of ' || r.prev_name || ' (' || r.prev_monthly || ').' AS message,
        jsonb_build_array(jsonb_build_object('id', r.prev_id, 'name', r.prev_name)) AS related, 'node' AS entity
      FROM (SELECT s.*, lag(s.id) OVER w AS prev_id, lag(s.name) OVER w AS prev_name, lag(s.monthly) OVER w AS prev_monthly, lag(s.sig) OVER w AS prev_sig
            FROM (SELECT n.id, n.name, n.status, n.parent_id, n.kind, ${TERM('n')} AS term, ${PRICE_SIG('n')} AS sig, ${MONTHLY('n')} AS monthly
                  FROM catalog_nodes n WHERE n.level = 'OFFER' AND n.status IN ('ACTIVE', 'SCHEDULED')) s WHERE s.monthly > 0
            WINDOW w AS (PARTITION BY s.parent_id, s.kind, s.term ORDER BY s.monthly, s.id)) r
      WHERE r.prev_id IS NOT NULL AND r.sig <> r.prev_sig AND r.monthly - r.prev_monthly <= (r.monthly * ${p(o.nearPriceBps)}::int) / 10000.0`,
  },
  {
    id: 'PROMO_OVERLAP', title: 'Overlapping promotions', severity: 'WARNING',
    description: 'Two active bundle discounts that discount the same thing and can apply to the same basket (they stack), and device deals on one offer with the same contract length.',
    rows: async (q) => {
      const out: HealthRow[] = [];
      const rules = (await q.query(`SELECT id, name, data FROM bundle_rules WHERE status = 'ACTIVE' ORDER BY id LIMIT 500`)).rows;
      for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
        const a = rules[i]!, b = rules[j]!;
        if (!a.data?.target || a.data.target !== b.data?.target) continue;
        const wa = (a.data.when ?? []) as string[], wb = (b.data.when ?? []) as string[];
        const shared = wa.filter((t) => wb.includes(t));
        if (!shared.length) continue;
        out.push({ key: `rule|${a.id}|${b.id}`, id: a.id as string, name: a.name as string, status: 'ACTIVE', entity: 'bundle_rule', related: [{ id: b.id as string, name: b.name as string }],
          message: `Both discount ${a.data.target} when ${shared.join(', ')} is in the basket, so they stack.` });
      }
      const deals = (await q.query(
        `SELECT n.id, n.name, n.status, d.term, count(*) AS n FROM catalog_nodes n CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(n.data->'deals') = 'array' THEN n.data->'deals' ELSE '[]'::jsonb END) e(deal)
         CROSS JOIN LATERAL (SELECT e.deal->>'termMonths' AS term) d WHERE n.level = 'OFFER' AND n.status <> 'RETIRED' GROUP BY n.id, n.name, n.status, d.term HAVING count(*) > 1 ORDER BY n.id LIMIT 1000`)).rows;
      for (const r of deals) out.push({ key: `deal|${r.id}|${r.term}`, id: r.id as string, name: r.name as string, status: r.status as string, entity: 'node', related: [], message: `${r.n} device deals for a ${r.term}-month contract.` });
      return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    },
  },
  {
    id: 'NO_LINE_ITEMS', title: 'Active offers with nothing listed in them', severity: 'INFO',
    description: 'Active offers with no active line item, so the store-front card shows no allowance or device. Line items do not change the price.',
    sql: () => `SELECT n.id AS k, n.id, n.name, n.status, 'No line items.' AS message, '[]'::jsonb AS related, 'node' AS entity FROM catalog_nodes n
      WHERE n.level = 'OFFER' AND n.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM catalog_nodes li WHERE li.parent_id = n.id AND li.level = 'LINE_ITEM' AND li.status = 'ACTIVE')`,
  },
  {
    id: 'NO_CHANNELS', title: 'Active offers with no sales channel chosen', severity: 'INFO',
    description: 'No channel is ticked, which means the offer is sold on every channel (store, dealer, call centre, telesales, online). Check that is intended.',
    sql: () => `SELECT n.id AS k, n.id, n.name, n.status, 'Sold on every channel.' AS message, '[]'::jsonb AS related, 'node' AS entity FROM catalog_nodes n
      WHERE n.level = 'OFFER' AND n.status = 'ACTIVE' AND jsonb_array_length(CASE WHEN jsonb_typeof(n.data->'salesChannels') = 'array' THEN n.data->'salesChannels' ELSE '[]'::jsonb END) = 0`,
  },
  {
    id: 'NO_MARKETS', title: 'Active offers with no market chosen', severity: 'INFO', when: (c) => c.multiMarket,
    description: 'Several markets are switched on and the offer names none, so it is sold in every market. Check that is intended.',
    sql: () => `SELECT n.id AS k, n.id, n.name, n.status, 'Sold in every market.' AS message, '[]'::jsonb AS related, 'node' AS entity FROM catalog_nodes n
      WHERE n.level = 'OFFER' AND n.status = 'ACTIVE' AND cardinality(n.markets) = 0`,
  },
  {
    id: 'SCHEDULE_OVERDUE', title: 'Scheduled go-lives that did not happen', severity: 'ERROR',
    description: 'A node is still Scheduled although its go-live time passed more than five minutes ago. The server activates due nodes within seconds, so this means the sweep is not running.',
    sql: () => `SELECT n.id AS k, n.id, n.name, n.status, 'Was due ' || to_char(n.active_from, 'YYYY-MM-DD HH24:MI') || ' UTC.' AS message, '[]'::jsonb AS related, 'node' AS entity FROM catalog_nodes n
      WHERE n.status = 'SCHEDULED' AND n.level <> 'LINE_ITEM' AND n.active_from <= now() - interval '5 minutes'`,
  },
  {
    id: 'SCHEDULE_PARENT_NOT_LIVE', title: 'Scheduled offers whose parent will not be live by then', severity: 'ERROR',
    description: 'A scheduled offer goes live on its date but something above it is not Active and is not scheduled to be live by then, so the offer stays hidden.',
    sql: () => `SELECT n.id AS k, n.id, n.name, n.status,
        'Goes live ' || to_char(n.active_from, 'YYYY-MM-DD') || ' but its ' || lower(replace(b.level, '_', ' ')) || ' ' || b.name || ' is ' || CASE b.status WHEN 'RETIRED' THEN 'retired' WHEN 'DRAFT' THEN 'still a draft' ELSE 'scheduled for ' || to_char(b.active_from, 'YYYY-MM-DD') END || '.' AS message,
        jsonb_build_array(jsonb_build_object('id', b.id, 'name', b.name)) AS related, 'node' AS entity
      FROM catalog_nodes n
      CROSS JOIN LATERAL (WITH RECURSIVE up(id, name, level, status, active_from, parent_id, depth) AS (
          SELECT a.id, a.name, a.level, a.status, a.active_from, a.parent_id, 1 FROM catalog_nodes a WHERE a.id = n.parent_id
          UNION ALL SELECT a.id, a.name, a.level, a.status, a.active_from, a.parent_id, up.depth + 1 FROM catalog_nodes a JOIN up ON a.id = up.parent_id)
        SELECT id, name, level, status, active_from FROM up WHERE status <> 'ACTIVE' AND NOT (status = 'SCHEDULED' AND active_from <= n.active_from) ORDER BY depth DESC LIMIT 1) b
      WHERE n.status = 'SCHEDULED' AND n.level = 'OFFER'`,
  },
];

const byId = new Map(HEALTH_CHECKS.map((c) => [c.id, c]));
const publicCheck = ({ id, title, severity, description }: Check): HealthCheck => ({ id, title, severity, description });
const toRow = (r: Row): HealthRow => ({ key: r.k as string, id: r.id as string, name: r.name as string, status: r.status as string, message: r.message as string, related: (r.related ?? []) as HealthRow['related'], entity: (r.entity ?? 'node') as HealthRow['entity'] });

async function context(q: Queryable): Promise<Ctx> { return { multiMarket: (await marketMode(q)).multiple }; }
const applies = (c: Check, ctx: Ctx) => !c.when || c.when(ctx);

/** Every check with how many findings it has, counted up to HEALTH_CAP (`capped` says there are more). Checks that do not apply to this deployment are left out. */
export async function catalogHealthSummary(q: Queryable, o: HealthOptions = {}): Promise<Array<HealthCheck & { count: number; capped: boolean }>> {
  const ro = resolve(o), ctx = await context(q);
  const out: Array<HealthCheck & { count: number; capped: boolean }> = [];
  for (const c of HEALTH_CHECKS.filter((x) => applies(x, ctx))) {
    let n: number;
    if ('rows' in c) n = (await c.rows(q)).length;
    else { const { params, p } = sqlBuilder(); n = Number((await q.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM (${c.sql(p, ro)}) x LIMIT ${HEALTH_CAP + 1}) c`, params)).rows[0]!.n); }
    out.push({ ...publicCheck(c), count: Math.min(n, HEALTH_CAP), capped: n > HEALTH_CAP });
  }
  return out;
}

/** One page of one check's findings, in key order, continued with the cursor of the previous page. */
export async function catalogHealthPage(q: Queryable, checkId: string, f: HealthOptions & { limit?: number; cursor?: string } = {}): Promise<Page<HealthRow> & { check: HealthCheck }> {
  const c = byId.get(checkId);
  if (!c || !applies(c, await context(q))) throw invalid(`unknown check ${checkId}. Known: ${HEALTH_CHECKS.map((x) => x.id).join(', ')}`);
  const ro = resolve(f), limit = pageSize(f.limit, 50, 200);
  const cur = decodeCursor(f.cursor, 1);
  if ('rows' in c) {
    const all = (await c.rows(q)).filter((r) => !cur || r.key > (cur[0] as string));
    const page = toPage(all.slice(0, limit + 1), limit, (r) => [r.key]);
    return { ...page, check: publicCheck(c) };
  }
  const { params, p } = sqlBuilder();
  const sql = c.sql(p, ro);
  const rows = (await q.query(`SELECT * FROM (${sql}) x ${cur ? `WHERE x.k > ${p(cur[0])}` : ''} ORDER BY x.k LIMIT ${p(limit + 1)}`, params)).rows.map(toRow);
  return { ...toPage(rows, limit, (r) => [r.key]), check: publicCheck(c) };
}
