import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNode, updateNode } from './catalog.js';
import type { Db } from './db.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); }, 60_000);
afterAll(async () => { await db.close(); });

const offer = (id: string, parentId: string, extra: Record<string, unknown> = {}) => ({
  level: 'OFFER', id, code: id, name: `Dep ${id}`, path: '', parentId, status: 'ACTIVE', markets: [], kind: 'VAS', prices: [{ type: 'RECURRING', amount: { amountMinor: 500, currency: 'SGD' }, periodMonths: 1, taxInclusive: true }],
  contract: { termMonths: 0 }, fulfilment: { requiresShipping: false, requiresInstallation: false, requiresSimActivation: false, inventorySkus: [] }, requires: [], excludes: [], salesChannels: [], variants: [], deals: [], ...extra,
}) as never;
const make = (id: string, parent = 'grp-vas', extra: Record<string, unknown> = {}) => createNode(db, offer(id, parent, extra), 'seed');

describe('the dependency check reads what it can reach, with the same answers as before', () => {
  it('refuses unknown nodes, an offer requiring itself or its own group, and a requirement that is also excluded', async () => {
    await expect(make('dep-x1', 'grp-vas', { requires: ['nope'] })).rejects.toThrow(/unknown product or hierarchy node: nope/);
    await make('dep-self');
    await expect(updateNode(db, 'dep-self', { requires: ['dep-self'] })).rejects.toThrow(/cannot require itself/);
    await expect(updateNode(db, 'dep-self', { requires: ['grp-vas'] })).rejects.toThrow(/cannot require itself \(or the group it belongs to\)/);
    await expect(make('dep-x2', 'grp-vas', { requires: ['grp-vas'] })).rejects.toThrow(/cannot require itself/);     // a new offer is already part of its group
    await make('dep-other');
    await expect(updateNode(db, 'dep-self', { requires: ['grp-vas'], excludes: ['dep-other'] })).rejects.toThrow(/cannot require itself|both required and excluded/);
    await expect(updateNode(db, 'dep-self', { requires: ['grp-sim-only'], excludes: ['plan-sim-5g'] })).rejects.toThrow(/both required and excluded/);
  });

  it('finds a cycle however long, including one that goes through a group', async () => {
    await make('cyc-a'); await make('cyc-b', 'grp-vas', { requires: ['cyc-a'] }); await make('cyc-c', 'grp-vas', { requires: ['cyc-b'] });
    await expect(updateNode(db, 'cyc-a', { requires: ['cyc-c'] })).rejects.toThrow(/circular dependency: Dep cyc-a → Dep cyc-c → Dep cyc-b → Dep cyc-a/);
    // through a group: g requires the group "grp-insurance"; a member of that group requires g
    await make('grp-g', 'grp-vas');
    await make('ins-member', 'grp-insurance', { requires: ['grp-g'] });
    await expect(updateNode(db, 'grp-g', { requires: ['grp-insurance'] })).rejects.toThrow(/circular dependency/);
  });

  it('accepts chains, shared prerequisites and requirements on another group', async () => {
    await make('ok-base'); await make('ok-left', 'grp-vas', { requires: ['ok-base'] }); await make('ok-right', 'grp-vas', { requires: ['ok-base'] });
    await expect(make('ok-top', 'grp-vas', { requires: ['ok-left', 'ok-right'] })).resolves.toBeTruthy();   // a diamond is not a cycle
    await expect(updateNode(db, 'ok-base', { requires: ['grp-sim-only'] })).resolves.toBeTruthy();
    await expect(updateNode(db, 'ok-top', { excludes: ['ok-other-missing'] })).rejects.toThrow(/unknown/);
  });

  it('costs nothing for an offer with no requirements or conflicts, and a number of queries that does not grow with the catalogue', async () => {
    const count = async (fn: (q: Db) => Promise<unknown>) => {
      let n = 0;
      const spy = new Proxy(db, { get: (t, k) => (k === 'query' ? (...a: unknown[]) => { n++; return (t.query as (...x: unknown[]) => unknown)(...a); } : (t as never)[k]) }) as Db;
      await fn(spy);
      return n;
    };
    const plain = await count((q) => updateNode(q, 'dep-other', { description: 'same' } as never));
    const withReq = await count((q) => updateNode(q, 'dep-other', { requires: ['ok-base'] } as never));
    expect(withReq - plain).toBeLessThanOrEqual(6);
    await db.query(`INSERT INTO catalog_nodes (id, level, code, name, path, parent_id, status, kind, markets, data, sort_order)
      SELECT 'many-' || g, 'OFFER', 'many-' || g, 'Many ' || g, 'grp/many-' || g, NULL, 'ACTIVE', 'VAS', '{}', '{}'::jsonb, 0 FROM generate_series(1, 3000) g`).catch(() => undefined);
    const withReqBig = await count((q) => updateNode(q, 'dep-other', { requires: ['ok-left'] } as never));
    expect(withReqBig - plain).toBeLessThanOrEqual(8);
  });
});
