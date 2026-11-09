import test from 'node:test';
import assert from 'node:assert/strict';
import { createFranchiseExplorer, expandFranchiseBatch,
  groupFranchiseItems } from '../src/web/public/franchise-explorer.mjs';

test('direct relationships stay grouped while discovered hops have their own group', () => {
  const view = createFranchiseExplorer({ anidbId: 10, title: 'Original' });
  view.add({ anidbId: 10, state: 'related_titles', completeness: 'unproven',
    items: [{ anidbId: 20, title: 'Film', relation: 'SideStory' },
      { anidbId: 30, title: 'Second season', relation: 'Sequel' },
      { anidbId: 40, title: 'First season', relation: 'Prequel' }] });
  view.add({ anidbId: 20, state: 'related_titles', completeness: 'unproven',
    items: [{ anidbId: 50, title: 'Film sequel', relation: 'Sequel' }] });
  assert.deepEqual(groupFranchiseItems(view.items(), 10).map((group) =>
    [group.heading, group.items.map((item) => item.anidbId)]), [
    ['Prequels', [40]], ['Sequels', [30]], ['Side stories', [20]],
    ['More linked titles', [50]],
  ]);
});

test('one explicit expansion gathers several separate relation pages', async () => {
  const view = createFranchiseExplorer({ anidbId: 10, title: 'Original' });
  view.add({ anidbId: 10, state: 'related_titles', completeness: 'unproven',
    items: [{ anidbId: 20, title: 'Part 20', relation: 'Sequel' }] });
  const calls = [];
  const result = await expandFranchiseBatch({ explorer: view,
    read: async (anidbId) => {
      calls.push(anidbId);
      return { anidbId, state: 'related_titles', completeness: 'unproven',
        items: [{ anidbId: anidbId + 10,
          title: `Part ${anidbId + 10}`, relation: 'Sequel' }] };
    }, maxReads: 6, minNewItems: 8 });
  assert.deepEqual(calls, [20, 30, 40, 50, 60, 70]);
  assert.deepEqual(view.items().map((item) => item.anidbId),
    [10, 20, 30, 40, 50, 60, 70, 80]);
  assert.deepEqual(result, { state: 'expanded', reads: 6, added: 6,
    failures: 0, hasMore: true });
});

test('an unavailable branch is skipped and the next branch still expands', async () => {
  const view = createFranchiseExplorer({ anidbId: 10, title: 'Original' });
  view.add({ anidbId: 10, state: 'related_titles', completeness: 'unproven',
    items: [{ anidbId: 20, title: 'Part 20', relation: 'Prequel' },
      { anidbId: 30, title: 'Part 30', relation: 'Sequel' }] });
  const result = await expandFranchiseBatch({ explorer: view,
    read: async (anidbId) => {
      if (anidbId === 20) throw new Error('Source unavailable');
      return { anidbId, state: 'related_titles', completeness: 'unproven',
        items: [] };
    }, maxReads: 2, minNewItems: 8 });
  assert.equal(result.failures, 1);
  assert.equal(result.reads, 2);
  assert.equal(view.next(), null);
});

test('show more still expands when the first page already contains many cards', async () => {
  const view = createFranchiseExplorer({ anidbId: 10, title: 'Original' });
  view.add({ anidbId: 10, state: 'related_titles', completeness: 'unproven',
    items: Array.from({ length: 15 }, (_, index) => ({
      anidbId: 20 + index, title: `Part ${20 + index}`, relation: 'Sequel' })) });
  const result = await expandFranchiseBatch({ explorer: view,
    read: async (anidbId) => ({ anidbId, state: 'related_titles',
      completeness: 'unproven', items: [{ anidbId: 99,
        title: 'Another part', relation: 'Sequel' }] }),
    maxReads: 1 });
  assert.equal(result.reads, 1);
  assert.equal(result.added, 1);
  assert.equal(view.items().at(-1).anidbId, 99);
});

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
  assert.equal(view.items()[1].relatedFrom, 10);
  assert.equal(view.items()[2].relatedFrom, 20);
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
