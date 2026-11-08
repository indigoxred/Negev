import assert from 'node:assert/strict';
import test from 'node:test';
import { createFastDetailReader } from '../src/catalogue/fast-detail-reader.mjs';

test('exact archive detail serves a new title without waiting for Shoko', async () => {
  let shokoReads = 0;
  const reader = createFastDetailReader({
    archive: async () => ({ state: 'details', anidbId: 19586,
      page: 1, total: 1, episodes: [{ id: 316607 }] }),
    shoko: async () => { shokoReads++; return { state: 'detail_pending' }; },
  });
  const result = await reader({ anidbId: 19586, page: 1 });
  assert.equal(result.state, 'details');
  assert.equal(result.episodes[0].id, 316607);
  assert.equal(shokoReads, 0);
});

test('unavailable archive falls back to Shoko and does not invent targets', async () => {
  const reader = createFastDetailReader({
    archive: async () => ({ state: 'unavailable' }),
    shoko: async () => ({ state: 'detail_pending', anidbId: 19586 }),
  });
  assert.deepEqual(await reader({ anidbId: 19586, page: 1 }),
    { state: 'detail_pending', anidbId: 19586 });
});
