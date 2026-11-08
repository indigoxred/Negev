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

test('a title over the safety budget cannot partly enter the franchise', () => {
  const view = createFranchiseExplorer({ anidbId: 10, title: 'Original' }, 2);
  assert.throws(() => view.add({ anidbId: 10, state: 'related_titles',
    completeness: 'unproven', items: [
      { anidbId: 20, title: 'Film', relation: 'SideStory' },
      { anidbId: 30, title: 'Sequel', relation: 'Sequel' },
    ] }), RangeError);
  assert.deepEqual(view.items().map((item) => item.anidbId), [10]);
  assert.equal(view.next()?.anidbId, 10);
});

test('an empty cached relation response is not presented as a complete franchise', () => {
  const view = createFranchiseExplorer({ anidbId: 10, title: 'Original' });
  assert.deepEqual(view.status(), { state: 'not_checked',
    linkedInstallments: 0 });
  view.add({ anidbId: 10, state: 'related_titles',
    completeness: 'unproven', items: [] });
  assert.deepEqual(view.status(), { state: 'no_cached_links',
    linkedInstallments: 0 });
  assert.equal(view.next(), null);
});

test('a related installment carries only a bounded positive library count', () => {
  const view = createFranchiseExplorer({ anidbId: 10, title: 'Original' });
  view.add({ anidbId: 10, state: 'related_titles', completeness: 'unproven',
    items: [{ anidbId: 20, title: 'Sequel', relation: 'Sequel',
      libraryPresence: { state: 'in_library', verifiedEpisodeCount: 3 } }] });
  assert.deepEqual(view.items()[1].libraryPresence,
    { state: 'in_library', verifiedEpisodeCount: 3 });
  const invalid = createFranchiseExplorer({ anidbId: 10, title: 'Original' });
  assert.throws(() => invalid.add({ anidbId: 10, state: 'related_titles',
    completeness: 'unproven', items: [{ anidbId: 20, title: 'Sequel',
      relation: 'Sequel', libraryPresence: { state: 'in_library',
        verifiedEpisodeCount: -1 } }] }));
});

test('one unavailable related title does not block later franchise expansion', () => {
  const view = createFranchiseExplorer({ anidbId: 10, title: 'Original' });
  view.add({ anidbId: 10, state: 'related_titles', completeness: 'unproven',
    items: [{ anidbId: 20, title: 'First', relation: 'Prequel' },
      { anidbId: 30, title: 'Second', relation: 'Sequel' }] });
  assert.equal(view.next().anidbId, 20);
  view.skip(20);
  assert.equal(view.next().anidbId, 30);
  assert.deepEqual(view.items().map((item) => item.anidbId), [10, 20, 30]);
  assert.throws(() => view.skip(999));
});
