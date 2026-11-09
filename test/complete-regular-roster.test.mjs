import assert from 'node:assert/strict';
import test from 'node:test';
import { completeRegularRoster } from '../src/catalogue/complete-regular-roster.mjs';

const page = (number, episodes, overrides = {}) => ({ state: 'details',
  anidbId: 144, title: 'Inuyasha', kind: 'series', page: number,
  total: 4, episodeCount: 3, nextPage: number === 1 ? 2 : null,
  episodes, ...overrides });
const ep = (id, type = 'Episode') => ({ id, number: id,
  type, title: `Entry ${id}` });

test('collects exact regular IDs across pages without counting Specials', async () => {
  const calls = [];
  const result = await completeRegularRoster({ first: page(1, [ep(1), ep(2)]),
    loadPage: async (number) => {
      calls.push(number);
      return page(2, [ep(3), ep(4, 'Special')]);
    } });
  assert.deepEqual(result, [1, 2, 3]);
  assert.deepEqual(calls, [2]);
});

test('a changed catalogue or incomplete roster never claims a season', async () => {
  assert.equal(await completeRegularRoster({ first: page(1, [ep(1), ep(2)]),
    loadPage: async () => page(2, [ep(3), ep(4, 'Special')], { total: 5 }) }), null);
  assert.equal(await completeRegularRoster({ first: page(1, [ep(1), ep(2)]),
    loadPage: async () => page(2, [ep(3), ep(4, 'Special')],
      { episodeCount: 4 }) }), null);
  assert.equal(await completeRegularRoster({ first: page(1, [ep(1), ep(2)]),
    loadPage: async () => ({ state: 'busy' }) }), null);
});

test('caps metadata pages before asking for another page', async () => {
  let reads = 0;
  const result = await completeRegularRoster({ first: page(1, [ep(1)],
    { total: 3, episodeCount: 3, nextPage: 2 }), maxPages: 2,
  loadPage: async () => {
    reads++;
    return page(2, [ep(2)], { total: 3, nextPage: 3 });
  } });
  assert.equal(result, null);
  assert.equal(reads, 1);
});
