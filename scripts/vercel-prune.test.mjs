import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentRef, keepCount, pickDeletions } from './vercel-prune.mjs';

const d = (uid, created, state = 'READY', target = 'production') => ({ uid, created, state, target });

test('deletes older deployments of every kind and keeps the latest', () => {
  const all = [d('new', 300), d('prod-old', 200), d('prev', 150, 'READY', null), d('failed', 100, 'ERROR'), d('canceled', 50, 'CANCELED')];
  assert.deepEqual(pickDeletions(all, { id: 'new', createdAt: 300 }).map((x) => x.uid), ['prod-old', 'prev', 'failed', 'canceled']);
});

test('never touches a deployment that is still building or one created after the one kept', () => {
  const all = [d('keep', 300), d('building', 200, 'BUILDING'), d('queued', 100, 'QUEUED'), d('newer', 400), d('old', 10)];
  assert.deepEqual(pickDeletions(all, { id: 'keep', createdAt: 300 }).map((x) => x.uid), ['old']);
});

test('has nothing to delete when only the latest exists', () => {
  assert.deepEqual(pickDeletions([d('only', 1)], { id: 'only', createdAt: 1 }), []);
});

test('accepts what `vercel deploy` prints (a URL), a host name or an id', () => {
  assert.equal(deploymentRef('https://meridian-abc-team.vercel.app'), 'meridian-abc-team.vercel.app');
  assert.equal(deploymentRef('https://meridian-abc-team.vercel.app/\n'), 'meridian-abc-team.vercel.app');
  assert.equal(deploymentRef('meridian-abc-team.vercel.app'), 'meridian-abc-team.vercel.app');
  assert.equal(deploymentRef('dpl_123'), 'dpl_123');
});

test('keeps the newest earlier production deployments to roll back to, and deletes the rest', () => {
  const all = [d('new', 500), d('p3', 400), d('p2', 300), d('p1', 200), d('prev', 450, 'READY', null), d('failedProd', 420, 'ERROR'), d('p0', 100)];
  const gone = (n) => pickDeletions(all, { id: 'new', createdAt: 500 }, { keepProduction: n }).map((x) => x.uid).sort();
  assert.deepEqual(gone(1), ['failedProd', 'p0', 'p1', 'p2', 'p3', 'prev']);               // only the latest
  assert.deepEqual(gone(3), ['failedProd', 'p0', 'p1', 'prev']);                            // the latest and the two before it: p3, p2
  assert.deepEqual(gone(10), ['failedProd', 'prev']);                                       // previews and failed builds always go
});

test('reads how many to keep, and refuses nonsense', () => {
  assert.equal(keepCount(undefined), 3);
  assert.equal(keepCount('1'), 1);
  assert.throws(() => keepCount('0'));
  assert.throws(() => keepCount('abc'));
});
