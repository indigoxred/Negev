import assert from 'node:assert/strict';
import test from 'node:test';
import { createEpisodePager } from '../src/web/public/episode-pages.mjs';

const first = { state: 'details', anidbId: 42, title: 'Example',
  kind: 'series', total: 3, page: 1, nextPage: 2,
  episodes: [{ id: 1001, number: 1, type: 'Episode', title: 'One' },
    { id: 1002, number: 2, type: 'Episode', title: 'Two' }] };
const second = { ...first, page: 2, nextPage: null,
  episodes: [{ id: 1099, number: 1, type: 'Special', title: 'Extra' }] };

test('later episode pages expose a Special without losing installment identity', () => {
  const pager = createEpisodePager(first);
  assert.equal(pager.nextPage, 2);
  assert.deepEqual(pager.append(second), { state: 'appended',
    episodes: second.episodes });
  assert.equal(pager.nextPage, null);
  assert.deepEqual(pager.episodes.map((episode) => episode.id), [1001, 1002, 1099]);
});

test('changed identity or duplicate episodes hold a page without corrupting selection', () => {
  const pager = createEpisodePager(first);
  for (const changed of [
    { ...second, anidbId: 99 }, { ...second, title: 'Other' },
    { ...second, episodes: [{ ...second.episodes[0], id: 1001 }] },
    { ...second, page: 3 },
  ]) {
    assert.deepEqual(pager.append(changed), { state: 'held' });
    assert.equal(pager.nextPage, 2);
    assert.deepEqual(pager.episodes.map((episode) => episode.id), [1001, 1002]);
  }
});
