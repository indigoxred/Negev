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

test('background airing reads prefer current Shoko detail and fall back to the archive', async () => {
  let archived = 0;
  let local = { state: 'details', anidbId: 19586, page: 1,
    episodes: [{ id: 316609 }] };
  const reader = createFastDetailReader({ prefer: 'shoko',
    archive: async () => { archived++; return { state: 'details',
      anidbId: 19586, page: 1, episodes: [{ id: 316607 }] }; },
    shoko: async () => local,
  });
  assert.equal((await reader({ anidbId: 19586, page: 1 })).episodes[0].id, 316609);
  assert.equal(archived, 0);
  local = { state: 'detail_pending', anidbId: 19586 };
  assert.equal((await reader({ anidbId: 19586, page: 1 })).episodes[0].id, 316607);
  assert.equal(archived, 1);
});

test('first-load detail returns pending before a slow Shoko fallback blocks the page', async () => {
  let shokoReads = 0;
  const reader = createFastDetailReader({ deadlineMs: 20,
    archive: async () => ({ state: 'unavailable' }),
    shoko: async () => { shokoReads++; return new Promise(() => {}); },
  });
  const started = Date.now();
  assert.deepEqual(await reader({ anidbId: 16325, page: 1 }),
    { state: 'detail_pending', anidbId: 16325 });
  assert.ok(Date.now() - started < 1_000);
  assert.equal(shokoReads, 1);
});

test('first-load detail returns pending if the public archive itself stalls', async () => {
  let shokoReads = 0;
  const reader = createFastDetailReader({ deadlineMs: 20,
    archive: async () => new Promise(() => {}),
    shoko: async () => { shokoReads++; return { state: 'details' }; },
  });
  assert.deepEqual(await reader({ anidbId: 16325, page: 1 }),
    { state: 'detail_pending', anidbId: 16325 });
  assert.equal(shokoReads, 0);
});
