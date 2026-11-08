import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeasonalCatalogue } from '../src/catalogue/seasonal-catalogue.mjs';

const row = (title, ...anidbIds) => ({
  title, type: 'TV', status: 'RELEASING',
  animeSeason: { season: 'FALL', year: 2026 },
  sources: anidbIds.map((id) => `https://anidb.net/anime/${id}`),
});
const reply = (body) => new Response(JSON.stringify(body), { status: 200,
  headers: { 'content-type': 'application/json' } });

test('season pages keep exact unique AniDB IDs and label adult titles', async () => {
  const calls = [];
  const map = { lastUpdate: '2026-11-05', data: [
    row('Gamma', 3), row('Alpha', 1), row('Beta', 2),
    row('Uncertain join', 4, 5), row('Other year', 6),
  ] };
  map.data[4].animeSeason.year = 2025;
  const reader = createSeasonalCatalogue({ fetchImpl: async (url) => {
    calls.push(url);
    if (url.endsWith('/api/v1/map')) return reply(map);
    const id = Number(url.split('/').at(-1));
    return reply({ anidb_id: id, title: `AniDB ${id}`,
      type: 'TV Series', restricted: id === 2 });
  }, now: () => 1000 });
  const first = await reader.read({ year: 2026, season: 'FALL', limit: 2 });
  assert.deepEqual(first, { state: 'ready', year: 2026, season: 'FALL',
    sourceDate: '2026-11-05', availableTags: [],
    items: [{ anidbId: 1, title: 'AniDB 1',
      type: 'TV Series', releaseStatus: 'RELEASING', adult: false },
    { anidbId: 2, title: 'AniDB 2', type: 'TV Series',
      releaseStatus: 'RELEASING', adult: true }], nextAfter: 2 });
  const second = await reader.read({ year: 2026, season: 'FALL',
    after: first.nextAfter, limit: 2 });
  assert.deepEqual(second.items.map((item) => item.anidbId), [3]);
  assert.equal(second.nextAfter, null);
  assert.equal(calls.filter((url) => url.endsWith('/api/v1/map')).length, 1);
  assert.equal(calls.some((url) => url.endsWith('/4') || url.endsWith('/5')), false);
  const archive = await reader.read({ year: 0, season: 'ALL', limit: 4 });
  assert.deepEqual(archive.items.map((item) => item.anidbId), [1, 2, 3, 6]);
  assert.equal(archive.nextAfter, null);
});

test('unknown restriction never displays a seasonal card and visibly marks partial data', async () => {
  const reader = createSeasonalCatalogue({ fetchImpl: async (url) =>
    url.endsWith('/api/v1/map')
      ? reply({ lastUpdate: '2026-11-05', data: [row('Unknown', 7)] })
      : new Response('', { status: 503 }), now: () => 1000 });
  const result = await reader.read({ year: 2026, season: 'FALL' });
  assert.equal(result.state, 'partial');
  assert.deepEqual(result.items, []);
});

test('season type and tag filters apply before pagination using exact AniDB map entries', async () => {
  const entries = [
    { ...row('Action show', 1), status: 'ONGOING', tags: ['Action', 'Adventure'] },
    { ...row('Drama film', 2), type: 'MOVIE', tags: ['Drama'] },
    { ...row('Action film', 3), type: 'MOVIE', tags: ['Action'] },
    { ...row('Comedy OVA', 4), type: 'OVA', tags: ['Comedy'] },
  ];
  const reader = createSeasonalCatalogue({ fetchImpl: async (url) =>
    url.endsWith('/api/v1/map')
      ? reply({ lastUpdate: '2026-11-05', data: entries })
      : reply({ anidb_id: Number(url.split('/').at(-1)),
        title: 'Verified title', type: 'Anime', restricted: false }),
  now: () => 1000 });
  const films = await reader.read({ year: 2026, season: 'FALL',
    kind: 'movies', limit: 1 });
  assert.deepEqual(films.items.map((item) => item.anidbId), [3]);
  assert.equal(films.nextAfter, 1);
  const second = await reader.read({ year: 2026, season: 'FALL',
    kind: 'movies', after: films.nextAfter, limit: 1 });
  assert.deepEqual(second.items.map((item) => item.anidbId), [2]);
  assert.equal(second.nextAfter, null);
  const actionShows = await reader.read({ year: 2026, season: 'FALL',
    kind: 'series', tag: 'action' });
  assert.deepEqual(actionShows.items.map((item) => item.anidbId), [1]);
  assert.equal(actionShows.nextAfter, null);
  assert.deepEqual(actionShows.availableTags,
    ['action', 'adventure', 'comedy', 'drama']);
  const both = await reader.read({ year: 2026, season: 'FALL',
    tag: 'action,adventure' });
  assert.deepEqual(both.items.map((item) => item.anidbId), [1]);
  const ongoing = await reader.read({ year: 2026, season: 'FALL',
    status: 'ongoing' });
  assert.deepEqual(ongoing.items.map((item) => item.anidbId), [1]);
  assert.deepEqual(ongoing.availableTags, ['action', 'adventure']);
  await assert.rejects(reader.read({ year: 2026, season: 'FALL',
    kind: 'unsafe' }), TypeError);
  await assert.rejects(reader.read({ year: 2026, season: 'FALL',
    tag: '\nunsafe' }), TypeError);
});

test('ongoing titles span seasons and sort before pagination', async () => {
  const older = { ...row('Zeta', 1), status: 'ONGOING',
    animeSeason: { season: 'SPRING', year: 2024 } };
  const newer = { ...row('Alpha', 2), status: 'ONGOING' };
  const finished = { ...row('Finished', 3), status: 'FINISHED' };
  const reader = createSeasonalCatalogue({ fetchImpl: async (url) =>
    url.endsWith('/api/v1/map')
      ? reply({ lastUpdate: '2026-11-05', data: [older, newer, finished] })
      : reply({ anidb_id: Number(url.split('/').at(-1)),
        title: url.endsWith('/1') ? 'Zeta' : 'Alpha',
        type: 'TV Series', restricted: false }), now: () => 1000 });
  const newest = await reader.read({ year: 0, season: 'ALL',
    status: 'ongoing', sort: 'newest', limit: 1 });
  assert.deepEqual(newest.items.map((item) => item.anidbId), [2]);
  const next = await reader.read({ year: 0, season: 'ALL',
    status: 'ongoing', sort: 'newest', after: newest.nextAfter, limit: 1 });
  assert.deepEqual(next.items.map((item) => item.anidbId), [1]);
  const oldest = await reader.read({ year: 0, season: 'ALL',
    status: 'ongoing', sort: 'oldest' });
  assert.deepEqual(oldest.items.map((item) => item.anidbId), [1, 2]);
  const title = await reader.read({ year: 0, season: 'ALL',
    status: 'ongoing', sort: 'title_desc' });
  assert.deepEqual(title.items.map((item) => item.anidbId), [1, 2]);
  await assert.rejects(reader.read({ year: 0, season: 'ALL',
    status: 'ongoing', sort: 'popularity' }), TypeError);
});

test('provider outage uses a visibly stale cached map and cold failure is unavailable', async () => {
  let time = 1000;
  let fail = false;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/v1/map')) {
      if (fail) return new Response('', { status: 503 });
      return reply({ lastUpdate: '2026-11-05', data: [row('One', 1)] });
    }
    return reply({ anidb_id: 1, title: 'One', type: 'TV Series',
      restricted: false });
  };
  const reader = createSeasonalCatalogue({ fetchImpl, now: () => time,
    cacheMs: 1000, staleMs: 10000 });
  assert.equal((await reader.read({ year: 2026, season: 'FALL' })).state, 'ready');
  fail = true;
  time = 3000;
  assert.equal((await reader.read({ year: 2026, season: 'FALL' })).state, 'stale');
  const cold = createSeasonalCatalogue({ fetchImpl, now: () => time });
  assert.deepEqual(await cold.read({ year: 2026, season: 'FALL' }),
    { state: 'unavailable' });
});

test('streamed map handles split Unicode and nested JSON without buffering the full map', async () => {
  const body = new TextEncoder().encode(JSON.stringify({ lastUpdate: '2026-11-05',
    data: [{ ...row('猫 { \\" show', 9), tags: [{ name: '猫' }] }] }));
  const stream = new ReadableStream({ start(controller) {
    for (let offset = 0; offset < body.length; offset += 7) {
      controller.enqueue(body.subarray(offset, offset + 7));
    }
    controller.close();
  } });
  const reader = createSeasonalCatalogue({ fetchImpl: async (url) =>
    url.endsWith('/api/v1/map')
      ? new Response(stream, { status: 200 })
      : reply({ anidb_id: 9, title: '猫 { show', type: 'OVA', restricted: true }),
  now: () => 1000 });
  const page = await reader.read({ year: 2026, season: 'FALL' });
  assert.equal(page.state, 'ready');
  assert.deepEqual(page.items, [{ anidbId: 9, title: '猫 { show',
    type: 'OVA', releaseStatus: 'RELEASING', adult: true }]);
});

test('invalid map ending and oversized decoded response never become an empty season', async () => {
  for (const response of [new Response('{"lastUpdate":"2026-11-05","data":[{}],}',
    { status: 200 }), new Response('{}', { status: 200,
    headers: { 'content-length': '60000001' } })]) {
    const reader = createSeasonalCatalogue({ fetchImpl: async () => response,
      now: () => 1000 });
    assert.deepEqual(await reader.read({ year: 2026, season: 'FALL' }),
      { state: 'unavailable' });
  }
});
