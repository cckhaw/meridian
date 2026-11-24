import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickDeletions } from './vercel-prune.mjs';

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
