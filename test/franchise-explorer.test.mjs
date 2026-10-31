import test from 'node:test';
import assert from 'node:assert/strict';
import { createFranchiseExplorer } from '../src/web/public/franchise-explorer.mjs';

test('expands verified installments one title at a time without merging request identities', () => {
  const view = createFranchiseExplorer({ anidbId: 10, title: 'Original' });
  assert.equal(view.next()?.anidbId, 10);
  view.add({ anidbId: 10, state: 'related_titles', completeness: 'unproven',
    items: [{ anidbId: 20, title: 'Film', relation: 'SideStory' }] });
  assert.equal(view.next()?.anidbId, 20);
  view.add({ anidbId: 20, state: 'related_titles', completeness: 'unproven',
    items: [{ anidbId: 30, title: 'Sequel', relation: 'Sequel' },
      { anidbId: 10, title: 'Original', relation: 'MainStory' }] });
  assert.deepEqual(view.items().map((item) => item.anidbId), [10, 20, 30]);
  assert.equal(view.next()?.anidbId, 30);
  assert.equal(view.items()[0].relation, null);
});

test('does not accept an unrelated, invalid, or oversized response', () => {
  const view = createFranchiseExplorer({ anidbId: 10, title: 'Original' }, 3);
  assert.throws(() => view.add({ anidbId: 11, state: 'related_titles',
    completeness: 'unproven', items: [] }));
  assert.throws(() => view.add({ anidbId: 10, state: 'related_titles',
    completeness: 'unproven', items: [{ anidbId: 20, title: 'Film', relation: 'Sequel' },
      { anidbId: 20, title: 'Film', relation: 'Sequel' }] }));
  assert.equal(view.items().length, 1);
});
