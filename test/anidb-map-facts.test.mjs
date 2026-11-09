import assert from 'node:assert/strict';
import test from 'node:test';
import { createAniDbMapFactsReader } from '../src/catalogue/anidb-map-facts.mjs';

test('map facts give a title compact season, status, studio and runtime', async () => {
  let calls = 0;
  const reader = createAniDbMapFactsReader({ fetchImpl: async (url) => {
    calls++;
    assert.equal(url, 'https://animap.id/api/v1/map/anidb/19586');
    return new Response(JSON.stringify({ sources: ['https://anidb.net/anime/19586'],
      animeSeason: { season: 'FALL', year: 2026 }, status: 'ONGOING',
      studios: ['studio comet'], duration: { value: 1380, unit: 'SECONDS' } }));
  } });
  const first = await reader.read({ anidbId: 19586 });
  assert.deepEqual(first, { state: 'facts', anidbId: 19586,
    season: 'Fall 2026', year: 2026, status: 'Airing', studio: 'studio comet',
    durationMinutes: 23 });
  assert.deepEqual(await reader.read({ anidbId: 19586 }), first);
  assert.equal(calls, 1);
});

test('map facts reject a different AniDB identity and ignore malformed fields', async () => {
  const wrong = createAniDbMapFactsReader({ fetchImpl: async () =>
    new Response(JSON.stringify({ sources: ['https://anidb.net/anime/1'] })) });
  assert.deepEqual(await wrong.read({ anidbId: 19586 }), { state: 'unavailable' });
  const partial = createAniDbMapFactsReader({ fetchImpl: async () =>
    new Response(JSON.stringify({ sources: ['https://anidb.net/anime/19586'],
      animeSeason: { season: 'UNKNOWN', year: 99999 }, status: 'UNKNOWN',
      studios: ['x'.repeat(500)], duration: { value: -1, unit: 'SECONDS' } })) });
  assert.deepEqual(await partial.read({ anidbId: 19586 }),
    { state: 'facts', anidbId: 19586, season: null, year: null,
      status: null, studio: null, durationMinutes: null });
});
