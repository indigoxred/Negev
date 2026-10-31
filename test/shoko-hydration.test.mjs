import assert from 'node:assert/strict';
import test from 'node:test';
import { requestAniDbHydration } from '../src/catalogue/shoko-hydration.mjs';

const config = { baseUrl: 'http://shoko.internal:8111', apiKey: 'synthetic-key', anidbId: 1234 };

test('requests only one metadata refresh without creating a Shoko series', async () => {
  const calls = [];
  const result = await requestAniDbHydration({ ...config, fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return { status: 200, text: async () => 'false' };
  } });
  assert.deepEqual(result, { state: 'queued' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/api/v3/Series/AniDB/1234/Refresh');
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
    createSeriesEntry: 'false', downloadRelations: 'false', skipTmdbUpdate: 'true',
    force: 'false', immediate: 'false', cacheOnly: 'false',
  });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer synthetic-key');
});

test('immediate completion is still only a refresh, not requestable evidence', async () => {
  const result = await requestAniDbHydration({ ...config, fetchImpl: async () => ({ status: 200, text: async () => 'true' }) });
  assert.deepEqual(result, { state: 'refresh_accepted' });
});

test('transport and provider failures hold without an empty catalogue claim', async () => {
  const result = await requestAniDbHydration({ ...config, fetchImpl: async () => ({ status: 401 }) });
  assert.deepEqual(result, { state: 'unavailable' });
});

test('rejects invalid IDs before contacting Shoko', async () => {
  let calls = 0;
  await assert.rejects(() => requestAniDbHydration({ ...config, anidbId: 0, fetchImpl: async () => { calls++; } }), TypeError);
  assert.equal(calls, 0);
});
