import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNode, getNode, updateNode } from './catalog.js';
import {
  addReleaseComment, approveRelease, approverBlocker, cancelRelease, createRelease, getRelease, listReleaseComments, previewRelease, publishRelease, rejectRelease, releaseNodeIds, reopenRelease,
  releaseReviewers, scheduleRelease, stageChange, submitRelease,
} from './catalog-release.js';
import type { Db } from './db.js';
import { createUser } from './auth.js';
import { fanOutEvents, resetEventGate } from './events.js';
import { saveHubWebhook } from './integration-hub.js';
import { permissionKey } from './permission-catalog.js';
import { ROLES } from './rbac.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); }, 60_000);
afterAll(async () => { await db.close(); });

const offer = (id: string) => createNode(db, {
  level: 'OFFER', id, code: id, name: `Appr ${id}`, path: '', parentId: 'grp-vas', status: 'ACTIVE', markets: [], kind: 'VAS', prices: [{ type: 'RECURRING', amount: { amountMinor: 1000, currency: 'SGD' }, periodMonths: 1, taxInclusive: true }],
  contract: { termMonths: 0 }, fulfilment: { requiresShipping: false, requiresInstallation: false, requiresSimActivation: false, inventorySkus: [] }, requires: [], excludes: [], salesChannels: [], variants: [], deals: [],
} as never, 'seed');
/** A release by `maker` with one staged description change on a fresh offer. */
async function draft(id: string, name = `Release for ${id}`, by = 'maker') {
  await offer(id);
  const r = await createRelease(db, by, { name });
  await stageChange(db, by, r.id, { op: 'UPDATE', nodeId: id, payload: { patch: { description: `staged on ${id}` } } });
  return r;
}
const comments = async (id: string) => (await listReleaseComments(db, id)).map((c) => [c.kind, c.author, c.body]);
const audited = async (id: string) => (await db.query(`SELECT action FROM audit_log WHERE entity = 'catalog_release' AND entity_id = $1 ORDER BY id`, [id])).rows.map((r) => r.action as string);

describe('release approval: the states', () => {
  it('goes draft, in review, approved, published; each step is by the right person, in the comments and in the audit log', async () => {
    const r = await draft('ap-flow');
    expect(r.status).toBe('DRAFT');
    await expect(approveRelease(db, 'checker', r.id)).rejects.toThrow(/only a release in review can be approved/);
    await expect(publishRelease(db, r.id, 'publisher')).rejects.toThrow(/is draft and cannot be published/);
    const inReview = await submitRelease(db, 'maker', r.id, 'please check the description');
    expect([inReview.status, inReview.submittedBy]).toEqual(['IN_REVIEW', 'maker']);
    expect(inReview.submittedAt).toBeTruthy();
    await expect(submitRelease(db, 'maker', r.id)).rejects.toThrow(/only a draft can be sent for review/);
    await expect(stageChange(db, 'maker', r.id, { op: 'UPDATE', nodeId: 'ap-flow', payload: { patch: { name: 'x' } } })).rejects.toThrow(/only be added to a draft/);   // frozen while reviewed
    await expect(publishRelease(db, r.id, 'publisher')).rejects.toThrow(/is in review and cannot be published/);
    const approved = await approveRelease(db, 'checker', r.id, 'looks right');
    expect([approved.status, approved.decidedBy]).toEqual(['APPROVED', 'checker']);
    expect((await getNode(db, 'ap-flow') as any).description).toBeUndefined();                            // approval is not publishing
    const published = await publishRelease(db, r.id, 'publisher');
    expect([published.status, published.publishedBy]).toEqual(['PUBLISHED', 'publisher']);
    expect(((await getNode(db, 'ap-flow')) as any).description).toBe('staged on ap-flow');
    expect(await comments(r.id)).toEqual([['SUBMIT', 'maker', 'please check the description'], ['APPROVE', 'checker', 'looks right'], ['PUBLISH', 'publisher', '']]);
    expect(await audited(r.id)).toEqual(['RELEASE_CREATED', 'RELEASE_SUBMITTED', 'RELEASE_APPROVED', 'RELEASE_PUBLISHED']);
    await expect(reopenRelease(db, 'maker', r.id)).rejects.toThrow(/is published and cannot be reopened/);
  });

  it('refuses to send a release for review that would not apply, or that has nothing in it', async () => {
    const empty = await createRelease(db, 'maker', { name: 'Empty' });
    await expect(submitRelease(db, 'maker', empty.id)).rejects.toThrow(/no changes/);
    await offer('ap-bad');
    const bad = await createRelease(db, 'maker', { name: 'Bad' });
    await stageChange(db, 'maker', bad.id, { op: 'UPDATE', nodeId: 'ap-bad', payload: { patch: { prices: [{ type: 'RECURRING', amount: { amountMinor: 5, currency: 'USD' }, periodMonths: 1, taxInclusive: true }] } } });
    await expect(submitRelease(db, 'maker', bad.id)).rejects.toThrow(/cannot be sent for review yet: 1 change would be refused/);
    expect((await previewRelease(db, bad.id)).ready).toBe(false);
    await cancelRelease(db, 'maker', empty.id); await cancelRelease(db, 'maker', bad.id);
  });
});

describe('release approval: a second pair of eyes', () => {
  it('lets nobody who started a release or changed anything in it approve or reject it, and anyone else may', async () => {
    const r = await draft('ap-mc');
    await offer('ap-mc-2');
    await stageChange(db, 'helper', r.id, { op: 'UPDATE', nodeId: 'ap-mc-2', payload: { patch: { description: 'a colleague\'s change' } } });
    await submitRelease(db, 'maker', r.id);
    const blocked = (who: string) => approveRelease(db, who, r.id).then(() => 'approved', (e) => `${e.code}: ${e.message}`);
    expect(await blocked('maker')).toBe('FORBIDDEN: You started this release, so someone else has to review it.');
    expect(await blocked('helper')).toBe('FORBIDDEN: You made changes in this release, so someone else has to review it.');
    await expect(rejectRelease(db, 'maker', r.id, 'my own')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(rejectRelease(db, 'helper', r.id, 'my colleague\'s')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await getRelease(db, r.id)).status).toBe('IN_REVIEW');
    expect((await approveRelease(db, 'third.person', r.id)).status).toBe('APPROVED');
    // the rule on its own
    expect(approverBlocker({ createdBy: 'a' }, [{ createdBy: 'b' }], 'a')).toMatch(/started/);
    expect(approverBlocker({ createdBy: 'a' }, [{ createdBy: 'b' }], 'b')).toMatch(/made changes/);
    expect(approverBlocker({ createdBy: 'a' }, [{ createdBy: 'b' }], 'c')).toBeNull();
    await cancelRelease(db, 'maker', r.id);
  });

  it('sends a release back with a reason, lets its author reopen, change and resubmit it, and keeps the whole conversation', async () => {
    const r = await draft('ap-rej');
    await submitRelease(db, 'maker', r.id);
    await expect(rejectRelease(db, 'checker', r.id, '  ')).rejects.toThrow(/Say what needs to change/);
    const back = await rejectRelease(db, 'checker', r.id, 'The price is wrong: it should be 12, not 10.');
    expect([back.status, back.decidedBy]).toEqual(['REJECTED', 'checker']);
    await expect(approveRelease(db, 'checker', r.id)).rejects.toThrow(/only a release in review can be approved/);
    await addReleaseComment(db, 'maker', r.id, 'Will fix, thanks.');
    const again = await reopenRelease(db, 'maker', r.id, 'fixing it');
    expect([again.status, again.submittedBy, again.decidedBy]).toEqual(['DRAFT', null, null]);
    await stageChange(db, 'maker', r.id, { op: 'UPDATE', nodeId: 'ap-rej', payload: { patch: { prices: [{ type: 'RECURRING', amount: { amountMinor: 1200, currency: 'SGD' }, periodMonths: 1, taxInclusive: true }] } } });
    await submitRelease(db, 'maker', r.id, 'price fixed');
    await approveRelease(db, 'checker', r.id, 'good');
    await publishRelease(db, r.id, 'publisher');
    expect(((await getNode(db, 'ap-rej')) as any).prices[0].amount.amountMinor).toBe(1200);
    expect(await comments(r.id)).toEqual([
      ['SUBMIT', 'maker', ''], ['REJECT', 'checker', 'The price is wrong: it should be 12, not 10.'], ['COMMENT', 'maker', 'Will fix, thanks.'], ['REOPEN', 'maker', 'fixing it'],
      ['SUBMIT', 'maker', 'price fixed'], ['APPROVE', 'checker', 'good'], ['PUBLISH', 'publisher', ''],
    ]);
    expect(await audited(r.id)).toEqual(['RELEASE_CREATED', 'RELEASE_SUBMITTED', 'RELEASE_REJECTED', 'RELEASE_COMMENTED', 'RELEASE_REOPENED', 'RELEASE_SUBMITTED', 'RELEASE_APPROVED', 'RELEASE_PUBLISHED']);
  });

  it('will not approve a release that stopped applying cleanly while it waited, but it can be sent back', async () => {
    const r = await draft('ap-stale');
    await submitRelease(db, 'maker', r.id);
    await updateNode(db, 'ap-stale', { name: 'Edited live while in review' }, 'someone.else');
    await expect(approveRelease(db, 'checker', r.id)).rejects.toThrow(/cannot be approved as it stands: 1 node changed in the live catalog/);
    expect((await rejectRelease(db, 'checker', r.id, 'It changed underneath you: rebase it.')).status).toBe('REJECTED');
    await cancelRelease(db, 'maker', r.id);
  });

  it('takes approval back when a release is reopened: its schedule goes, and it has to be approved again', async () => {
    const r = await draft('ap-reopen');
    await submitRelease(db, 'maker', r.id); await approveRelease(db, 'checker', r.id);
    const when = new Date(Date.now() + 3_600_000).toISOString();
    expect((await scheduleRelease(db, 'publisher', r.id, when)).publishAt).toBe(when);
    const back = await reopenRelease(db, 'checker', r.id, 'taking approval back');
    expect([back.status, back.publishAt, back.decidedBy]).toEqual(['DRAFT', null, null]);
    await expect(scheduleRelease(db, 'publisher', r.id, when)).rejects.toThrow(/cannot be scheduled/);
    await expect(publishRelease(db, r.id, 'publisher')).rejects.toThrow(/cannot be published/);
    await cancelRelease(db, 'maker', r.id);
    expect(await releaseNodeIds(db, r.id)).toEqual([]);                                                   // a cancelled release frees its nodes
  });

  it('refuses to reopen a release that is already a draft or cancelled', async () => {
    const r = await draft('ap-draft');
    await expect(reopenRelease(db, 'maker', r.id)).rejects.toThrow(/is draft and cannot be reopened/);
    await cancelRelease(db, 'maker', r.id);
    await expect(reopenRelease(db, 'maker', r.id)).rejects.toThrow(/is cancelled and cannot be reopened/);
  });
});

describe('release approval: comments and events', () => {
  it('keeps reviewers\' comments in order, at any stage, and refuses an empty or overlong one', async () => {
    const r = await draft('ap-cm');
    await addReleaseComment(db, 'maker', r.id, 'First thought');
    await submitRelease(db, 'maker', r.id);
    await addReleaseComment(db, 'checker', r.id, 'Is the old plan retired too?');
    await expect(addReleaseComment(db, 'checker', r.id, '   ')).rejects.toThrow(/Write the comment/);
    await expect(addReleaseComment(db, 'checker', r.id, 'x'.repeat(2001))).rejects.toThrow(/2000 characters/);
    expect((await comments(r.id)).map((c) => c[0])).toEqual(['COMMENT', 'SUBMIT', 'COMMENT']);
    await cancelRelease(db, 'maker', r.id);
  });

  it('raises events when a release is submitted, approved, sent back and published, only while somebody listens', async () => {
    const quiet = await draft('ap-ev-quiet');
    resetEventGate();
    await submitRelease(db, 'maker', quiet.id);
    const eventsFor = async (like: string) => Number((await db.query(`SELECT count(*)::int AS n FROM lifecycle_outbox WHERE kind = 'EVENT' AND instruction LIKE $1`, [like])).rows[0]!.n);
    expect(await eventsFor('RELEASE_%')).toBe(0);
    await cancelRelease(db, 'maker', quiet.id);
    await saveHubWebhook(db, 'root', { kind: 'OUTBOUND', name: 'Release listener', targetUrl: 'https://listener.example.com/hook', authKind: 'HMAC', secret: 'a-signing-key-12345', events: [] });
    resetEventGate();
    const r = await draft('ap-ev', 'Events release');
    await submitRelease(db, 'maker', r.id);
    await rejectRelease(db, 'checker', r.id, 'not yet');
    await reopenRelease(db, 'maker', r.id);
    await submitRelease(db, 'maker', r.id);
    await approveRelease(db, 'checker', r.id);
    await publishRelease(db, r.id, 'publisher');
    expect((await db.query(`SELECT instruction FROM lifecycle_outbox WHERE kind = 'EVENT' AND instruction LIKE 'RELEASE_%' ORDER BY id`)).rows.map((x) => x.instruction)).toEqual(
      ['RELEASE_SUBMITTED', 'RELEASE_REJECTED', 'RELEASE_SUBMITTED', 'RELEASE_APPROVED', 'RELEASE_PUBLISHED']);
    await fanOutEvents(db);
    const rows = (await db.query(`SELECT tmf_type, payload FROM event_deliveries WHERE event_type LIKE 'RELEASE_%' ORDER BY id`)).rows;
    expect(rows.map((x) => x.tmfType)).toEqual(['CatalogReleaseSubmittedEvent', 'CatalogReleaseRejectedEvent', 'CatalogReleaseSubmittedEvent', 'CatalogReleaseApprovedEvent', 'CatalogReleasePublishedEvent']);
    const body = (typeof rows[4]!.payload === 'string' ? JSON.parse(rows[4]!.payload) : rows[4]!.payload) as any;
    expect(body).toMatchObject({ eventType: 'CatalogReleasePublishedEvent', domain: 'productCatalogManagement', event: { catalogRelease: { id: r.id, '@type': 'CatalogRelease', number: r.number, name: 'Events release', by: 'publisher', lifecycleStatus: 'PUBLISHED' } } });
    expect(body.event.catalogRelease).not.toHaveProperty('serviceId');
    const rejected = (typeof rows[1]!.payload === 'string' ? JSON.parse(rows[1]!.payload) : rows[1]!.payload) as any;
    expect(rejected.event.catalogRelease.reason).toBe('not yet');
  });
});

describe('release approval: who may do what', () => {
  it('gives the permissions to the roles the plan names: configurators submit, rating and charging approves, administrators do all three', () => {
    const has = (role: keyof typeof ROLES, p: string) => (ROLES[role].permissions as readonly string[]).includes(p);
    expect([has('product-configurator', 'release:submit'), has('product-configurator', 'release:approve'), has('product-configurator', 'release:publish')]).toEqual([true, false, false]);
    expect([has('rating-charging', 'release:submit'), has('rating-charging', 'release:approve'), has('rating-charging', 'release:publish')]).toEqual([false, true, false]);
    expect([has('admin', 'release:submit'), has('admin', 'release:approve'), has('admin', 'release:publish')]).toEqual([true, true, true]);
    expect(permissionKey('release:approve' as never)).toBe('catalog:release:approve');
    expect(permissionKey('release:submit' as never)).toBe('catalog:release:submit');
    expect(permissionKey('release:publish' as never)).toBe('catalog:release:publish');
  });
});

describe('release review with more than one administrator', () => {
  it('lists who could review a release: people with release:approve who did not start or change it; two administrators cover each other, a lone one has nobody', async () => {
    const mk = (username: string, role: string) => createUser(db, 'seed', { username, displayName: username, roles: [role], password: 'Str0ng!Passw0rd#1' });
    await mk('rv-alice', 'admin'); await mk('rv-bob', 'admin'); await mk('rv-carol', 'product-configurator'); await mk('rv-dave', 'rating-charging');
    await db.query(`UPDATE users SET status = 'DISABLED' WHERE username = 'rv-dave'`);
    await offer('rv-multi');
    const r = await createRelease(db, 'rv-alice', { name: 'Two admins' });
    const ch = await stageChange(db, 'rv-carol', r.id, { op: 'UPDATE', nodeId: 'rv-multi', payload: { patch: { description: 'x' } } });
    const changes = [{ createdBy: 'rv-carol' }];
    const who = await releaseReviewers(db, r, changes);
    expect(who.names).toContain('rv-bob');                                                // the other administrator
    for (const n of ['rv-alice', 'rv-carol', 'rv-dave']) expect(who.names).not.toContain(n);   // the author, the change author, a disabled user and a role without the permission
    expect(who.count).toBe(who.names.length);
    // the other administrator can really review it; the author cannot
    await submitRelease(db, 'rv-alice', r.id, '');
    await expect(approveRelease(db, 'rv-alice', r.id)).rejects.toThrow(/started this release/);
    expect((await approveRelease(db, 'rv-bob', r.id)).status).toBe('APPROVED');
    expect((await publishRelease(db, r.id, 'rv-alice')).status).toBe('PUBLISHED');       // either administrator may publish once someone else approved
    // with the second administrator gone, a release started and changed by the remaining administrator has nobody
    await db.query(`UPDATE users SET status = 'DISABLED' WHERE username IN ('rv-bob')`);
    const solo = await releaseReviewers(db, { createdBy: 'rv-alice' }, [{ createdBy: 'rv-alice' }]);
    expect(solo.names).not.toContain('rv-alice');
    expect(solo.names).not.toContain('rv-bob');
    void ch;
  });
});
