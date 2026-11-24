import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNode, getNode, updateNode } from './catalog.js';
import {
  applyChange, cancelRelease, createRelease, createReverseRelease, getRelease, listChanges, listReleases, nodeInRelease, previewRelease, publishDueReleases, publishRelease, rebaseNode, releaseConflicts,
  releaseNodeIds, removeChange, RELEASE_MAX_CHANGES, scheduleRelease, stageChange, stageReprice, updateRelease,
} from './catalog-release.js';
import type { Db } from './db.js';
import { resetEventGate } from './events.js';
import { saveHubWebhook } from './integration-hub.js';
import { placeOrder } from './orders.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); }, 60_000);
afterAll(async () => { await db.close(); });

const who = 'maker';
const price = (minor: number, extra: Record<string, unknown> = {}) => ({ type: 'RECURRING', amount: { amountMinor: minor, currency: 'SGD' }, periodMonths: 1, taxInclusive: true, ...extra });
const offerInput = (id: string, over: Record<string, unknown> = {}) => ({
  level: 'OFFER', id, code: id, name: `Rel ${id}`, path: '', parentId: 'grp-vas', status: 'DRAFT', markets: [], kind: 'VAS', prices: [price(1000)], contract: { termMonths: 0 },
  fulfilment: { requiresShipping: false, requiresInstallation: false, requiresSimActivation: false, inventorySkus: [] }, requires: [], excludes: [], salesChannels: [], variants: [], deals: [], ...over,
});
const live = (id: string, over: Record<string, unknown> = {}) => createNode(db, offerInput(id, { status: 'ACTIVE', ...over }) as never, 'seed');
const newRelease = (name = 'Test release') => createRelease(db, who, { name });
const stage = (rel: string, op: any, nodeId: string, payload?: Record<string, unknown>, extra: Record<string, unknown> = {}) => stageChange(db, who, rel, { op, nodeId, payload, ...extra } as never);
const count = async (sql: string, args: unknown[] = []) => Number((await db.query(sql, args)).rows[0]!.n);
const nodes = () => count('SELECT count(*)::int AS n FROM catalog_nodes');
const outbox = () => count(`SELECT count(*)::int AS n FROM lifecycle_outbox WHERE kind = 'EVENT'`);
const audits = () => count(`SELECT count(*)::int AS n FROM audit_log WHERE entity = 'catalog'`);
const exists = async (id: string) => (await db.query('SELECT 1 FROM catalog_nodes WHERE id = $1', [id])).rows.length > 0;

describe('releases: creating, staging and claiming', () => {
  it('creates numbered releases, lists them newest first with a cursor, renames a draft and throws one away', async () => {
    const a = await newRelease('First'); const b = await newRelease('Second'); const c = await newRelease('Third');
    expect([a.number, b.number, c.number].every((n) => /^REL-\d{4,}$/.test(n))).toBe(true);
    expect(new Set([a.number, b.number, c.number]).size).toBe(3);
    expect(a.status).toBe('DRAFT');
    await expect(createRelease(db, who, { name: '  ' })).rejects.toThrow(/name/);
    const p1 = await listReleases(db, { limit: 2 });
    expect(p1.items.map((r) => r.name)).toEqual(['Third', 'Second']);
    const p2 = await listReleases(db, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.items[0]!.name).toBe('First');
    expect((await listReleases(db, { status: 'PUBLISHED' })).items).toHaveLength(0);
    expect((await updateRelease(db, who, a.id, { name: 'First renamed', description: 'about it' })).name).toBe('First renamed');
    await cancelRelease(db, who, b.id);
    expect((await getRelease(db, b.id)).status).toBe('CANCELLED');
    await expect(updateRelease(db, who, b.id, { name: 'x' })).rejects.toThrow(/only a draft/);
    await expect(stage(b.id, 'DELETE', 'rel-x')).rejects.toThrow(/only be added to a draft/);
    await expect(cancelRelease(db, who, b.id)).rejects.toThrow(/cannot be cancelled/);
  });

  it('stages changes in order, remembers the version a live node had, and claims nodes so only one open release holds a node', async () => {
    await live('rel-claim');
    const r1 = await newRelease('claims one'); const r2 = await newRelease('claims two');
    const v = (await getNode(db, 'rel-claim')).version;
    const c1 = await stage(r1.id, 'UPDATE', 'rel-claim', { patch: { description: 'first' } });
    const c2 = await stage(r1.id, 'STATUS', 'rel-claim', { status: 'RETIRED' });
    expect([c1.seq, c2.seq, c1.baseVersion, c2.baseVersion]).toEqual([1, 2, v, v]);          // the version when it was first staged, kept for later changes to the node
    expect(await releaseNodeIds(db, r1.id)).toEqual(['rel-claim']);
    await expect(stage(r2.id, 'UPDATE', 'rel-claim', { patch: { description: 'second' } })).rejects.toThrow(/already in REL-\d+\. A node can be in one open release/);
    await removeChange(db, who, r1.id, c1.id);
    expect(await releaseNodeIds(db, r1.id)).toEqual(['rel-claim']);                           // still has the status change
    await removeChange(db, who, r1.id, c2.id);
    expect(await releaseNodeIds(db, r1.id)).toEqual([]);                                      // free again
    await stage(r2.id, 'UPDATE', 'rel-claim', { patch: { description: 'second' } });
    expect(await releaseNodeIds(db, r2.id)).toEqual(['rel-claim']);
  });

  it('refuses malformed and impossible changes when they are staged', async () => {
    const r = await newRelease('bad changes');
    await live('rel-bad');
    await expect(stage(r.id, 'CREATE', 'rel-bad', { input: offerInput('rel-bad') })).rejects.toThrow(/already exists/);
    await expect(stage(r.id, 'UPDATE', 'no-such-node', { patch: { name: 'x' } })).rejects.toThrow(/not found/);
    await expect(stage(r.id, 'UPDATE', 'rel-bad', { patch: {} })).rejects.toThrow(/at least one field/);
    await expect(stage(r.id, 'STATUS', 'rel-bad', { status: 'WRONG' })).rejects.toThrow(/status change needs/);
    await expect(stage(r.id, 'STATUS', 'rel-bad', { status: 'SCHEDULED' })).rejects.toThrow(/go-live date/);
    await expect(stage(r.id, 'MOVE', 'rel-bad', {})).rejects.toThrow(/new parent/);
    await expect(stage(r.id, 'COPY_LINE_ITEMS', 'rel-bad', { fromId: 'nowhere' })).rejects.toThrow(/not found/);
    await expect(stage(r.id, 'CREATE', 'rel-new-id', { input: offerInput('another-id') })).rejects.toThrow(/with the id of the change/);
    await expect(stage(r.id, 'CREATE', 'Bad Id', { input: offerInput('Bad Id') })).rejects.toThrow(/lowercase letters/);
    await stage(r.id, 'CREATE', 'rel-twice', { input: offerInput('rel-twice') });
    await expect(stage(r.id, 'CREATE', 'rel-twice', { input: offerInput('rel-twice') })).rejects.toThrow(/already created in this release/);
    // a release holds a bounded number of changes
    await db.query(`INSERT INTO catalog_release_changes (release_id, seq, op, node_id, payload, created_by) SELECT $1, 100 + g, 'DELETE', 'bulk-' || g, '{}', 'x' FROM generate_series(1, $2) g`, [r.id, RELEASE_MAX_CHANGES]);
    await expect(stage(r.id, 'UPDATE', 'rel-bad', { patch: { description: 'x' } })).rejects.toThrow(/at most 500 changes/);
    await cancelRelease(db, who, r.id);
  });
});

describe('releases: preview and diff, rolled back', () => {
  it('shows what publishing would do, change by change, and leaves the live catalog, the outbox and the audit log untouched', async () => {
    await live('rel-pv-edit', { name: 'Preview edit' }); await live('rel-pv-move', { name: 'Preview move' });
    await createNode(db, { level: 'LINE_ITEM', id: 'rel-pv-edit-i1', code: 'rel-pv-edit-i1', name: 'Old data', path: '', parentId: 'rel-pv-edit', status: 'ACTIVE', markets: [], itemType: 'DATA', quantity: 5, unit: 'GB' } as never, 'seed');
    const r = await newRelease('Preview');
    await stage(r.id, 'CREATE', 'grp-rel-pv', { input: { level: 'GROUP', id: 'grp-rel-pv', code: 'grp-rel-pv', name: 'Preview group', path: '', parentId: 'mobile-postpaid', status: 'ACTIVE', markets: [] } });
    await stage(r.id, 'CREATE', 'rel-pv-new', { input: offerInput('rel-pv-new', { parentId: 'grp-rel-pv' }) });
    await stage(r.id, 'STATUS', 'rel-pv-new', { status: 'ACTIVE' });
    await stage(r.id, 'UPDATE', 'rel-pv-edit', { patch: { prices: [price(1500)], description: 'Better', salesChannels: ['RETAIL_ASSISTED'] } });
    await stage(r.id, 'UPDATE', 'rel-pv-edit-i1', { patch: { quantity: 20 } });
    await stage(r.id, 'CREATE', 'rel-pv-edit-i2', { input: { level: 'LINE_ITEM', id: 'rel-pv-edit-i2', code: 'rel-pv-edit-i2', name: 'SMS', path: '', parentId: 'rel-pv-edit', status: 'ACTIVE', markets: [], itemType: 'SMS', unlimited: true } });
    await stage(r.id, 'MOVE', 'rel-pv-move', { parentId: 'grp-sim-only' });
    await stage(r.id, 'STATUS', 'rel-pv-move', { status: 'RETIRED' });
    const [n0, o0, a0, vEdit] = [await nodes(), await outbox(), await audits(), (await getNode(db, 'rel-pv-edit')).version];
    const pv = await previewRelease(db, r.id);
    expect(pv.results.every((x) => x.ok)).toBe(true);
    expect(pv.canPublish).toBe(true);
    const by = (id: string) => pv.nodes.find((n) => n.id === id)!;
    expect(by('grp-rel-pv').kind).toBe('ADDED');
    expect(by('rel-pv-new')).toMatchObject({ kind: 'ADDED', madeLive: true });
    expect(by('rel-pv-edit').kind).toBe('CHANGED');
    expect(by('rel-pv-edit').repriced).toBe(true);
    expect(by('rel-pv-edit').fields.map((f) => f.field).sort()).toEqual(['description', 'prices', 'salesChannels']);
    expect(by('rel-pv-edit').fields.find((f) => f.field === 'prices')).toMatchObject({ before: [expect.objectContaining({ amount: { currency: 'SGD', amountMinor: 1000 } })], after: [expect.objectContaining({ amount: { currency: 'SGD', amountMinor: 1500 } })] });
    expect(by('rel-pv-edit').lineItems.added.map((i) => i.name)).toEqual(['SMS']);
    expect(by('rel-pv-edit').lineItems.changed.map((i) => [i.name, i.fields.map((f) => f.field)])).toEqual([['Old data', ['quantity']]]);
    expect(pv.nodes.some((n) => n.level === 'LINE_ITEM')).toBe(false);                    // line items are shown under their offer
    expect(by('rel-pv-move')).toMatchObject({ moved: true, retired: true });
    expect(pv.summary).toMatchObject({ changes: 8, added: 2, repriced: 1, moved: 1, retired: 1, deleted: 0, lineItems: 2, errors: 0 });
    // nothing happened for real
    expect([await nodes(), await outbox(), await audits(), (await getNode(db, 'rel-pv-edit')).version]).toEqual([n0, o0, a0, vEdit]);
    expect(await exists('rel-pv-new')).toBe(false);
    expect((await getNode(db, 'rel-pv-move')).parentId).toBe('grp-vas');
  });

  it('reports the catalog\'s own refusal on the change that caused it, and later changes that depend on it', async () => {
    const r = await newRelease('Refusals');
    await live('rel-rf');
    await stage(r.id, 'UPDATE', 'rel-rf', { patch: { prices: [price(500, { amount: { amountMinor: 500, currency: 'USD' } })] } });   // wrong currency
    await stage(r.id, 'CREATE', 'rel-rf-child', { input: offerInput('rel-rf-child', { parentId: 'no-such-group' }) });
    await stage(r.id, 'UPDATE', 'rel-rf-child', { patch: { description: 'x' } });                                                     // depends on the create that fails
    await stage(r.id, 'UPDATE', 'rel-rf', { patch: { description: 'this one is fine' } });
    const pv = await previewRelease(db, r.id);
    expect(pv.results.map((x) => x.ok)).toEqual([false, false, false, true]);
    expect(pv.results[0]!.error).toMatch(/prices are in SGD/);
    expect(pv.results[1]!.error).toMatch(/parent no-such-group not found/);
    expect(pv.summary.errors).toBe(3);
    expect(pv.canPublish).toBe(false);
    expect(pv.nodes.find((n) => n.id === 'rel-rf')!.fields.map((f) => f.field)).toEqual(['description']);   // only the change that works shows
    await cancelRelease(db, who, r.id);
  });

  it('shows a sold offer\'s price change as refused, the way the catalog refuses it', async () => {
    const { customer } = await newCustomer(db);
    await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-phone-12' }] });
    const r = await newRelease('Reprice in place');
    await stage(r.id, 'UPDATE', 'plan-phone-12', { patch: { prices: [price(100)] } });
    const pv = await previewRelease(db, r.id);
    expect(pv.results[0]).toMatchObject({ ok: false });
    expect(pv.results[0]!.error).toMatch(/already sold/);
    await cancelRelease(db, who, r.id);
  });
});

describe('releases: a new version instead of repricing a sold offer', () => {
  it('stages the new version, the retirement of the old one and the dependents as one repriced change', async () => {
    await live('rel-needs-phone', { name: 'Needs the phone plan', requires: ['plan-phone-12'] });
    const r = await newRelease('Reprice');
    await expect(stageReprice(db, who, r.id, { offerId: 'rel-needs-phone', prices: [price(900)] })).rejects.toThrow(/never been sold/);
    const old = await getNode(db, 'plan-phone-12') as any;
    const newPrices = old.prices.map((p: any) => ({ ...p, amount: { ...p.amount, amountMinor: p.amount.amountMinor + 500 } }));
    const res = await stageReprice(db, who, r.id, { offerId: 'plan-phone-12', prices: newPrices });
    expect(res.newId).toBe('plan-phone-12-v2');
    expect(res.dependents).toEqual(['rel-needs-phone']);
    const changes = await listChanges(db, r.id);
    expect(changes.map((c) => `${c.op}:${c.nodeId}`)).toEqual(['CREATE:plan-phone-12-v2', 'COPY_LINE_ITEMS:plan-phone-12-v2', 'STATUS:plan-phone-12-v2', 'STATUS:plan-phone-12', 'UPDATE:rel-needs-phone']);
    expect(changes.every((c) => c.groupKey === 'reprice:plan-phone-12')).toBe(true);
    const pv = await previewRelease(db, r.id);
    expect(pv.results.every((x) => x.ok)).toBe(true);
    expect(pv.groups).toEqual([{ key: 'reprice:plan-phone-12', oldId: 'plan-phone-12', newId: 'plan-phone-12-v2' }]);
    expect(pv.summary).toMatchObject({ repriced: 1, added: 0, retired: 0, errors: 0 });       // one idea: repriced, not "added" and "retired"
    expect(pv.nodes.find((n) => n.id === 'rel-needs-phone')!.fields.map((f) => f.field)).toEqual(['requires']);
    const published = await publishRelease(db, r.id, 'checker');
    expect(published.status).toBe('PUBLISHED');
    expect((await getNode(db, 'plan-phone-12')).status).toBe('RETIRED');
    expect((await getNode(db, 'plan-phone-12-v2') as any).status).toBe('ACTIVE');
    expect(((await getNode(db, 'rel-needs-phone')) as any).requires).toEqual(['plan-phone-12-v2']);
    expect((await db.query(`SELECT count(*)::int AS n FROM catalog_nodes WHERE parent_id = 'plan-phone-12-v2' AND level = 'LINE_ITEM'`)).rows[0]!.n).toBeGreaterThan(0);   // line items copied
    expect(await count(`SELECT count(*)::int AS n FROM services WHERE offer_id = 'plan-phone-12'`)).toBeGreaterThan(0);            // subscribers stay on the old offer
  });
});

describe('releases: conflicts', () => {
  it('flags a node that changed live after it was staged, blocks publishing, and lets it be accepted', async () => {
    await live('rel-cf');
    const r = await newRelease('Conflicts');
    await stage(r.id, 'UPDATE', 'rel-cf', { patch: { description: 'from the release' } });
    expect(await releaseConflicts(db, r.id)).toEqual([]);
    await updateNode(db, 'rel-cf', { name: 'Edited live meanwhile' }, 'someone.else');
    const cf = await releaseConflicts(db, r.id);
    expect(cf).toHaveLength(1);
    expect(cf[0]).toMatchObject({ nodeId: 'rel-cf', kind: 'CHANGED_LIVE', lastBy: 'someone.else' });
    expect(cf[0]!.liveVersion).toBeGreaterThan(cf[0]!.baseVersion!);
    const pv = await previewRelease(db, r.id);
    expect([pv.canPublish, pv.conflicts.length]).toEqual([false, 1]);
    await expect(publishRelease(db, r.id, 'checker')).rejects.toThrow(/changed in the live catalog since being staged \(rel-cf\)/);
    expect((await getNode(db, 'rel-cf') as any).description).toBeUndefined();                     // nothing was applied
    await rebaseNode(db, 'checker', r.id, 'rel-cf');
    expect(await releaseConflicts(db, r.id)).toEqual([]);
    await publishRelease(db, r.id, 'checker');
    const n = await getNode(db, 'rel-cf') as any;
    expect([n.name, n.description]).toEqual(['Edited live meanwhile', 'from the release']);       // the live edit and the release's edit both stand
  });

  it('flags a node deleted live, and a node the release creates that now exists', async () => {
    await live('rel-gone');
    const r = await newRelease('More conflicts');
    await stage(r.id, 'UPDATE', 'rel-gone', { patch: { description: 'x' } });
    await stage(r.id, 'CREATE', 'rel-later', { input: offerInput('rel-later') });
    await db.query(`DELETE FROM catalog_nodes WHERE id = 'rel-gone'`);
    await live('rel-later');
    const cf = await releaseConflicts(db, r.id);
    expect(cf.map((c) => [c.nodeId, c.kind]).sort()).toEqual([['rel-gone', 'DELETED_LIVE'], ['rel-later', 'EXISTS_LIVE']]);
    await expect(rebaseNode(db, 'checker', r.id, 'rel-gone')).rejects.toThrow(/no longer exists/);
    await cancelRelease(db, who, r.id);
  });
});

describe('releases: atomic and scheduled publishing', () => {
  it('applies every change or none: a refused change leaves nothing behind, and the release can be fixed and published', async () => {
    await live('rel-at-edit');
    const r = await newRelease('Atomic');
    await stage(r.id, 'CREATE', 'rel-at-new', { input: offerInput('rel-at-new', { status: 'ACTIVE' }) });
    await stage(r.id, 'UPDATE', 'rel-at-edit', { patch: { description: 'edited by the release' } });
    const bad = await stage(r.id, 'UPDATE', 'rel-at-edit', { patch: { prices: [{ ...price(1), amount: { amountMinor: 1, currency: 'USD' } }] } });
    const [n0, o0, a0, v0] = [await nodes(), await outbox(), await audits(), (await getNode(db, 'rel-at-edit')).version];
    await expect(publishRelease(db, r.id, 'checker')).rejects.toThrow(/Change 3 \(UPDATE rel-at-edit\) was refused, so nothing was published: .*prices are in SGD/);
    expect([await nodes(), await outbox(), await audits(), (await getNode(db, 'rel-at-edit')).version]).toEqual([n0, o0, a0, v0]);
    expect(await exists('rel-at-new')).toBe(false);
    expect((await getRelease(db, r.id)).status).toBe('DRAFT');
    expect(await releaseNodeIds(db, r.id)).toEqual(expect.arrayContaining(['rel-at-new', 'rel-at-edit']));    // still claimed
    await removeChange(db, who, r.id, bad.id);
    const sub = await saveHubWebhook(db, 'root', { kind: 'OUTBOUND', name: 'Release listener', targetUrl: 'https://listener.example.com/hook', authKind: 'HMAC', secret: 'a-signing-key-12345', events: [] });
    resetEventGate();
    const out0 = await outbox();
    const done = await publishRelease(db, r.id, 'checker');
    expect([done.status, done.publishedBy]).toEqual(['PUBLISHED', 'checker']);
    expect(done.result.summary).toMatchObject({ changes: 2, added: 1, changed: 1 });
    expect((await getNode(db, 'rel-at-new')).status).toBe('ACTIVE');
    expect(((await getNode(db, 'rel-at-edit')) as any).description).toBe('edited by the release');
    expect(await outbox()).toBeGreaterThan(out0);                                                            // the catalog's own events, raised in the same transaction
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE entity = 'catalog_release' AND entity_id = $1 AND action = 'RELEASE_PUBLISHED'`, [r.id])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE entity = 'catalog' AND entity_id = 'rel-at-new' AND action = 'NODE_CREATED'`)).toBe(1);   // the per-node entry
    expect(await releaseNodeIds(db, r.id)).toEqual([]);                                                      // claims freed
    expect(done.result.before['rel-at-new']).toBeNull();
    expect(done.result.before['rel-at-edit'].id).toBe('rel-at-edit');
    await expect(publishRelease(db, r.id, 'checker')).rejects.toThrow(/is published and cannot be published/);
    await expect(stage(r.id, 'DELETE', 'rel-at-new')).rejects.toThrow(/only be added to a draft/);
    void sub;
  });

  it('refuses to publish an empty release', async () => {
    const r = await newRelease('Empty');
    await expect(publishRelease(db, r.id, 'checker')).rejects.toThrow(/no changes/);
    await cancelRelease(db, who, r.id);
  });

  it('publishes at a chosen time through the sweep, once, and does not retry a scheduled publish that failed', async () => {
    await live('rel-sc-a'); await live('rel-sc-b');
    const ok = await newRelease('Scheduled ok'); const failing = await newRelease('Scheduled failing');
    await stage(ok.id, 'UPDATE', 'rel-sc-a', { patch: { description: 'on schedule' } });
    await stage(failing.id, 'UPDATE', 'rel-sc-b', { patch: { description: 'x' } });
    await expect(scheduleRelease(db, who, ok.id, new Date(Date.now() - 60_000).toISOString())).rejects.toThrow(/future/);
    await expect(scheduleRelease(db, who, ok.id, 'tomorrow-ish')).rejects.toThrow(/date and time/);
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const s = await scheduleRelease(db, who, ok.id, soon);
    expect(s.publishAt).toBe(soon);
    await scheduleRelease(db, who, failing.id, soon);
    expect(await publishDueReleases(db)).toEqual({ published: 0, failed: 0 });                               // not due yet
    // time passes; one release meanwhile became impossible (its node was edited live)
    await db.query(`UPDATE catalog_releases SET publish_at = now() - interval '1 minute' WHERE id = ANY($1::uuid[])`, [[ok.id, failing.id]]);
    await updateNode(db, 'rel-sc-b', { name: 'Edited live' }, 'someone.else');
    expect(await publishDueReleases(db)).toEqual({ published: 1, failed: 1 });
    expect(((await getNode(db, 'rel-sc-a')) as any).description).toBe('on schedule');
    expect((await getRelease(db, ok.id))).toMatchObject({ status: 'PUBLISHED', publishedBy: 'scheduler' });
    const f = await getRelease(db, failing.id);
    expect(f.status).toBe('DRAFT');
    expect(f.publishError).toMatch(/changed in the live catalog/);
    expect(await publishDueReleases(db)).toEqual({ published: 0, failed: 0 });                               // not retried every sweep
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'RELEASE_SCHEDULE_FAILED'`, [failing.id])).toBe(1);
    // accept the live edit and schedule again: the error is cleared and it publishes
    await rebaseNode(db, 'checker', failing.id, 'rel-sc-b');
    await scheduleRelease(db, who, failing.id, soon);
    expect((await getRelease(db, failing.id)).publishError).toBeNull();
    await db.query(`UPDATE catalog_releases SET publish_at = now() - interval '1 minute' WHERE id = $1`, [failing.id]);
    expect(await publishDueReleases(db)).toEqual({ published: 1, failed: 0 });
    expect(await scheduleRelease(db, who, (await newRelease('Cleared')).id, null).catch((e) => e.message)).toBeTruthy();
  });
});

describe('releases: the staged state of a node, and reversing a release', () => {
  it('shows a node as the release would leave it, and null when the release deletes it', async () => {
    await live('rel-st'); await live('rel-st-del');
    const r = await newRelease('Staged state');
    await stage(r.id, 'UPDATE', 'rel-st', { patch: { name: 'Renamed in the release' } });
    await stage(r.id, 'DELETE', 'rel-st-del');
    expect((await nodeInRelease(db, r.id, 'rel-st'))!.node.name).toBe('Renamed in the release');
    expect((await getNode(db, 'rel-st')).name).toBe('Rel rel-st');                                          // live is untouched
    expect(await nodeInRelease(db, r.id, 'rel-st-del')).toBeNull();
    expect(await nodeInRelease(db, r.id, 'rel-st-new')).toBeNull();
    await cancelRelease(db, who, r.id);
  });

  it('builds a reverse release that puts back what a published one changed, and that publishes like any other', async () => {
    await live('rel-rv-edit', { name: 'Original name' }); await live('rel-rv-move');
    const fwd = await newRelease('Forward');
    await stage(fwd.id, 'UPDATE', 'rel-rv-edit', { patch: { name: 'Changed name', description: 'added text', prices: [price(1800)] } });
    await stage(fwd.id, 'MOVE', 'rel-rv-move', { parentId: 'grp-sim-only' });
    await stage(fwd.id, 'STATUS', 'rel-rv-move', { status: 'RETIRED' });
    await stage(fwd.id, 'CREATE', 'grp-rel-rv', { input: { level: 'GROUP', id: 'grp-rel-rv', code: 'grp-rel-rv', name: 'Reverse group', path: '', parentId: 'mobile-postpaid', status: 'ACTIVE', markets: [] } });
    await stage(fwd.id, 'CREATE', 'rel-rv-new', { input: offerInput('rel-rv-new', { parentId: 'grp-rel-rv', status: 'ACTIVE' }) });
    await stage(fwd.id, 'CREATE', 'rel-rv-new-i1', { input: { level: 'LINE_ITEM', id: 'rel-rv-new-i1', code: 'rel-rv-new-i1', name: 'Item', path: '', parentId: 'rel-rv-new', status: 'ACTIVE', markets: [], itemType: 'DATA', quantity: 1, unit: 'GB' } });
    await expect(createReverseRelease(db, who, fwd.id)).rejects.toThrow(/not published/);
    await publishRelease(db, fwd.id, 'checker');
    expect(await exists('rel-rv-new')).toBe(true);
    const rev = await createReverseRelease(db, 'checker', fwd.id);
    expect(rev.reversesReleaseId).toBe(fwd.id);
    expect(rev.name).toMatch(/^Reverse of REL-\d+: Forward$/);
    const ops = (await listChanges(db, rev.id)).map((c) => `${c.op}:${c.nodeId}`);
    expect(ops).toEqual(expect.arrayContaining(['UPDATE:rel-rv-edit', 'MOVE:rel-rv-move', 'STATUS:rel-rv-move', 'DELETE:rel-rv-new', 'DELETE:grp-rel-rv']));
    expect(ops).not.toContain('DELETE:rel-rv-new-i1');                                                      // deleting an offer takes its line items with it
    expect(ops.indexOf('DELETE:rel-rv-new')).toBeLessThan(ops.indexOf('DELETE:grp-rel-rv'));             // children before parents
    const pv = await previewRelease(db, rev.id);
    expect(pv.results.filter((x) => !x.ok)).toEqual([]);
    await publishRelease(db, rev.id, 'checker');
    const e = await getNode(db, 'rel-rv-edit') as any;
    expect([e.name, e.description || undefined, e.prices[0].amount.amountMinor]).toEqual(['Original name', undefined, 1000]);
    const m = await getNode(db, 'rel-rv-move');
    expect([m.parentId, m.status]).toEqual(['grp-vas', 'ACTIVE']);
    expect(await exists('rel-rv-new')).toBe(false);
    expect(await exists('grp-rel-rv')).toBe(false);
  });

  it('retires, rather than deletes, a created offer that has been sold since', async () => {
    const fwd = await newRelease('Forward sold');
    await stage(fwd.id, 'CREATE', 'rel-rs-new', { input: offerInput('rel-rs-new', { status: 'ACTIVE', kind: 'SIM_ONLY', fulfilment: { requiresShipping: false, requiresInstallation: false, requiresSimActivation: true, inventorySkus: [] } }) });
    await publishRelease(db, fwd.id, 'checker');
    const { customer } = await newCustomer(db);
    await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH' }, lines: [{ offerId: 'rel-rs-new' }] });
    const rev = await createReverseRelease(db, 'checker', fwd.id);
    expect((await listChanges(db, rev.id)).map((c) => `${c.op}:${c.nodeId}`)).toEqual(['STATUS:rel-rs-new']);
    await publishRelease(db, rev.id, 'checker');
    expect((await getNode(db, 'rel-rs-new')).status).toBe('RETIRED');
  });

  it('applies a change through the same function the catalog screen uses, and nowhere else', async () => {
    await live('rel-ap');
    await applyChange(db, { op: 'UPDATE', nodeId: 'rel-ap', payload: { patch: { name: 'Applied' } } }, 'x');
    expect((await getNode(db, 'rel-ap')).name).toBe('Applied');
  });
});
