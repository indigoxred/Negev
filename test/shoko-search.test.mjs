import assert from 'node:assert/strict';
import test from 'node:test';
import { searchAniDbTitles } from '../src/catalogue/shoko-search.mjs';

const config = { baseUrl: 'http://shoko.internal:8111', apiKey: 'synthetic-key' };

test('searches unowned AniDB titles using the installed PascalCase response', async () => {
  let called;
  const result = await searchAniDbTitles({ ...config, query: 'Example Anime', fetchImpl: async (url, init) => {
    called = { url, init };
    return { status: 200, text: async () => JSON.stringify({
      Total: 1, List: [{ ID: 1234, Title: 'Example Anime', ShokoID: null, Type: 'Unknown' }],
    }) };
  } });
  const url = new URL(called.url);
  assert.equal(url.pathname, '/api/v3/Series/AniDB/Search');
  assert.equal(url.searchParams.get('query'), 'Example Anime');
  assert.equal(url.searchParams.get('pageSize'), '20');
  assert.equal(url.searchParams.has('apikey'), false);
  assert.equal(called.init.method, 'GET');
  assert.equal(called.init.redirect, 'manual');
  assert.equal(called.init.headers.Authorization, 'Bearer synthetic-key');
  assert.deepEqual(result, {
    state: 'results', total: 1, page: 1,
    items: [{ anidbId: 1234, title: 'Example Anime', detailState: 'pending', requestable: false }],
  });
});

test('rejects blank or oversized search before contacting Shoko', async () => {
  const fetchImpl = async () => { throw Error('must not call'); };
  for (const query of [' ', 'a', 'x'.repeat(121)]) {
    assert.deepEqual(await searchAniDbTitles({ ...config, query, fetchImpl }), { state: 'invalid_query' });
  }
});

test('holds on Shoko failure or malformed catalogue data', async () => {
  assert.deepEqual(await searchAniDbTitles({ ...config, query: 'Example', fetchImpl: async () => ({ status: 401 }) }), { state: 'unavailable' });
  assert.deepEqual(await searchAniDbTitles({ ...config, query: 'Example', fetchImpl: async () => ({ status: 200, text: async () => '{"Total":1,"List":[{"ID":0,"Title":""}]}' }) }), { state: 'unavailable' });
});

test('bounds pagination and does not claim a title is requestable', async () => {
  const result = await searchAniDbTitles({ ...config, query: 'Example', page: 2, pageSize: 2, fetchImpl: async () => ({
    status: 200, text: async () => JSON.stringify({ Total: 3, List: [
      { ID: 5, Title: 'Example Film', ShokoID: 8, Type: 'Movie', EpisodeCount: 1 },
    ] }),
  }) });
  assert.deepEqual(result, {
    state: 'results', total: 3, page: 2,
    items: [{ anidbId: 5, title: 'Example Film', detailState: 'pending', requestable: false }],
  });
});
