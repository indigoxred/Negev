import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAniDbDetail } from '../src/catalogue/shoko-detail.mjs';

const config = { baseUrl: 'http://shoko.internal:8111', apiKey: 'synthetic-key', anidbId: 1234 };
const anime = { ID: 1234, Title: 'Example Anime', Type: 'TV', EndDate: null };
const episode = { ID: 1001, AnimeID: 1234, Type: 'Episode', EpisodeNumber: 1, Title: 'First' };

test('loads exact AniDB episode IDs including missing and unaired entries', async () => {
  const calls = [];
  const result = await loadAniDbDetail({ ...config, fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (String(url).endsWith('/AniDB/1234')) return { status: 200, text: async () => JSON.stringify(anime) };
    return { status: 200, text: async () => JSON.stringify({ Total: 2, List: [episode, { ...episode, ID: 1002, EpisodeNumber: 2, Title: '' }] }) };
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.pathname, '/api/v3/Series/AniDB/1234/Episode');
  assert.equal(calls[1].url.searchParams.get('includeMissing'), 'true');
  assert.equal(calls[1].url.searchParams.get('includeUnaired'), 'true');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer synthetic-key');
  assert.deepEqual(result, {
    state: 'details', anidbId: 1234, title: 'Example Anime', kind: 'series',
    total: 2, page: 1, complete: true, nextPage: null,
    episodes: [
      { id: 1001, number: 1, type: 'Episode', title: 'First' },
      { id: 1002, number: 2, type: 'Episode', title: '' },
    ],
    requestable: false,
  });
});

test('unowned title detail remains pending without refreshing Shoko', async () => {
  let count = 0;
  const result = await loadAniDbDetail({ ...config, fetchImpl: async () => { count++; return { status: 404 }; } });
  assert.equal(count, 1);
  assert.deepEqual(result, { state: 'detail_pending', anidbId: 1234 });
});

test('a partial movie episode page remains unrequestable', async () => {
  const result = await loadAniDbDetail({ ...config, pageSize: 1, fetchImpl: async (url) =>
    String(url).endsWith('/AniDB/1234')
      ? { status: 200, text: async () => JSON.stringify({ ...anime, Type: 'Movie' }) }
      : { status: 200, text: async () => JSON.stringify({ Total: 2, List: [episode] }) },
  });
  assert.equal(result.kind, 'movie');
  assert.equal(result.complete, false);
  assert.equal(result.nextPage, 2);
  assert.equal(result.requestable, false);
});

test('keeps a trailer distinct from a regular OVA episode with the same number', async () => {
  const result = await loadAniDbDetail({ ...config, fetchImpl: async (url) =>
    String(url).endsWith('/AniDB/1234')
      ? { status: 200, text: async () => JSON.stringify({ ...anime, Type: 'OVA' }) }
      : { status: 200, text: async () => JSON.stringify({ Total: 2, List: [
        episode, { ...episode, ID: 1002, EpisodeNumber: 1, Type: 'Trailer', Title: 'Trailer' },
      ] }) },
  });
  assert.equal(result.kind, 'series');
  assert.deepEqual(result.episodes.map(({ id, number, type }) => ({ id, number, type })), [
    { id: 1001, number: 1, type: 'Episode' },
    { id: 1002, number: 1, type: 'Trailer' },
  ]);
  assert.equal(result.requestable, false);
});

test('wrong anime episode or malformed response fails closed', async () => {
  const result = await loadAniDbDetail({ ...config, fetchImpl: async (url) =>
    String(url).endsWith('/AniDB/1234')
      ? { status: 200, text: async () => JSON.stringify(anime) }
      : { status: 200, text: async () => JSON.stringify({ Total: 1, List: [{ ...episode, AnimeID: 9999 }] }) },
  });
  assert.deepEqual(result, { state: 'unavailable' });
});

