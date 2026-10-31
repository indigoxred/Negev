import assert from 'node:assert/strict';
import test from 'node:test';
import { createSearchPager } from '../src/web/public/search-pages.mjs';

const item = (id) => ({ anidbId: id, title: `Anime ${id}` });

test('pages a stable catalogue search without duplicating titles', () => {
  const pager = createSearchPager({ state: 'results', page: 1,
    total: 3, items: [item(1), item(2)] });
  assert.equal(pager.nextPage, 2);
  assert.deepEqual(pager.append({ state: 'results', page: 2,
    total: 3, items: [item(3)] }), { state: 'appended', items: [item(3)] });
  assert.equal(pager.nextPage, null);
  assert.deepEqual(pager.items, [item(1), item(2), item(3)]);
});

test('holds changed totals, repeated IDs and empty continuation pages', () => {
  for (const changed of [
    { state: 'results', page: 2, total: 4, items: [item(3)] },
    { state: 'results', page: 2, total: 3, items: [item(1)] },
    { state: 'results', page: 2, total: 3, items: [] },
    { state: 'results', page: 3, total: 3, items: [item(3)] },
  ]) {
    const pager = createSearchPager({ state: 'results', page: 1,
      total: 3, items: [item(1), item(2)] });
    assert.deepEqual(pager.append(changed), { state: 'held' });
    assert.equal(pager.nextPage, 2);
  }
});

test('empty search has no further page', () => {
  const pager = createSearchPager({ state: 'results', page: 1,
    total: 0, items: [] });
  assert.equal(pager.nextPage, null);
});
