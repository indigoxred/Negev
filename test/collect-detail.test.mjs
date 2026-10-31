import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAniDbDetail } from '../src/catalogue/collect-detail.mjs';

const episode = (id) => ({ id, number: id, type: 'Episode', title: `Episode ${id}` });
const page = (number, episodes, total = 3, nextPage = null) => ({
  state: 'details', anidbId: 1234, title: 'Example', kind: 'series',
  total, page: number, complete: number === 1 && episodes.length === total,
  nextPage, episodes, requestable: false,
});

test('collects every exact page before returning complete detail', async () => {
  const calls = [];
  const pages = [page(1, [episode(1), episode(2)], 3, 2), page(2, [episode(3)])];
  const result = await collectAniDbDetail({ anidbId: 1234, loadPage: async ({ page: n }) => {
    calls.push(n);
    return pages[n - 1];
  } });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.state, 'details');
  assert.equal(result.complete, true);
  assert.deepEqual(result.episodes.map((entry) => entry.id), [1, 2, 3]);
  assert.equal(result.requestable, false);
});

test('inconsistent identity, total or repeated episode ID fails closed', async () => {
  for (const second of [
    { ...page(2, [episode(3)]), anidbId: 9999 },
    { ...page(2, [episode(3)]), total: 4 },
    page(2, [episode(2)]),
  ]) {
    const result = await collectAniDbDetail({ anidbId: 1234,
      loadPage: async ({ page: n }) => n === 1 ? page(1, [episode(1), episode(2)], 3, 2) : second });
    assert.deepEqual(result, { state: 'invalid_detail_evidence' });
  }
});

test('a bounded pagination stop remains incomplete and never refreshes metadata', async () => {
  const result = await collectAniDbDetail({ anidbId: 1234, maxPages: 1,
    loadPage: async () => page(1, [episode(1)], 3, 2) });
  assert.deepEqual(result, { state: 'partial_detail', anidbId: 1234, reason: 'page_limit' });
});
