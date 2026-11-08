import assert from 'node:assert/strict';
import test from 'node:test';
import { createAniMapRawDetailReader } from '../src/catalogue/animap-raw-detail.mjs';

const record = { anime: {
  '@id': '19586', '@restricted': 'false', type: 'TV Series',
  title: 'unused', startdate: '2026-10-03', episodecount: '2',
  titles: { title: [{ '@type': 'main', '#text': '#Zombie Sagashitemasu' }] },
  episodes: { episode: [
    { '@id': '316607', epno: { '@type': '1', '#text': '1' },
      title: { '@lang': 'en', '#text': 'First' }, airdate: '2026-10-03' },
    { '@id': '316608', epno: { '@type': '1', '#text': '2' },
      title: [{ '@lang': 'ja', '#text': '二' }, { '@lang': 'en', '#text': 'Second' }],
      airdate: '2026-10-10' },
    { '@id': '316609', epno: { '@type': '2', '#text': 'S1' },
      title: { '#text': 'Special' } },
  ] },
} };

test('public raw AniDB record gives exact bounded episode pages', async () => {
  let calls = 0;
  const reader = createAniMapRawDetailReader({ pageSize: 2,
    fetchImpl: async (url) => { calls++; assert.equal(String(url),
      'https://animap.id/api/anidb/19586/raw');
      return { status: 200, text: async () => JSON.stringify(record) };
    } });
  const first = await reader.read({ anidbId: 19586, page: 1 });
  const second = await reader.read({ anidbId: 19586, page: 2 });
  assert.equal(calls, 1);
  assert.deepEqual(first.episodes, [
    { id: 316607, number: 1, type: 'Episode', title: 'First', airDate: '2026-10-03' },
    { id: 316608, number: 2, type: 'Episode', title: 'Second', airDate: '2026-10-10' },
  ]);
  assert.deepEqual(second.episodes, [{ id: 316609, number: 1,
    type: 'Special', title: 'Special', airDate: null }]);
  assert.equal(first.title, '#Zombie Sagashitemasu');
  assert.equal(first.kind, 'series');
  assert.equal(first.total, 3);
  assert.equal(first.nextPage, 2);
  assert.equal(first.complete, false);
  assert.equal(second.nextPage, null);
  assert.equal(second.restricted, false);
});

test('wrong ID, duplicate episodes and missing adult status fail closed', async () => {
  for (const malformed of [
    { ...record, anime: { ...record.anime, '@id': '1' } },
    { ...record, anime: { ...record.anime, episodes: { episode: [
      record.anime.episodes.episode[0], record.anime.episodes.episode[0] ] } } },
    { ...record, anime: { ...record.anime, '@restricted': undefined } },
  ]) {
    const reader = createAniMapRawDetailReader({ fetchImpl: async () =>
      ({ status: 200, text: async () => JSON.stringify(malformed) }) });
    assert.deepEqual(await reader.read({ anidbId: 19586, page: 1 }),
      { state: 'unavailable' });
  }
});

test('public archive reads cap simultaneous distinct-title requests', async () => {
  const releases = [];
  let active = 0;
  let peak = 0;
  const reader = createAniMapRawDetailReader({ fetchImpl: async (url) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => releases.push(resolve));
    active--;
    const id = Number(String(url).match(/\/anidb\/(\d+)\/raw$/)[1]);
    return { status: 200, text: async () => JSON.stringify({ anime: {
      ...record.anime, '@id': String(id),
    } }) };
  } });
  const results = [19586, 19587, 19588].map((anidbId) =>
    reader.read({ anidbId, page: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(peak, 2);
  releases.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(peak, 2);
  for (const release of releases) release();
  await Promise.all(results);
});

test('a temporary archive failure retries before declaring a cold title pending', async () => {
  let calls = 0;
  const reader = createAniMapRawDetailReader({ fetchImpl: async () => {
    calls++;
    return calls === 1 ? { status: 503 } :
      { status: 200, text: async () => JSON.stringify(record) };
  } });
  const result = await reader.read({ anidbId: 19586, page: 1 });
  assert.equal(result.state, 'details');
  assert.equal(calls, 2);
});

test('a missing archive payload does not cause a redundant retry', async () => {
  let calls = 0;
  const reader = createAniMapRawDetailReader({ fetchImpl: async () => {
    calls++;
    return { status: 404 };
  } });
  assert.deepEqual(await reader.read({ anidbId: 19586, page: 1 }),
    { state: 'unavailable' });
  assert.equal(calls, 1);
});

test('a temporary archive failure is not cached for thirty seconds', async () => {
  let calls = 0;
  let time = 0;
  const reader = createAniMapRawDetailReader({ now: () => time,
    fetchImpl: async () => {
      calls++;
      return calls <= 2 ? { status: 503 } :
        { status: 200, text: async () => JSON.stringify(record) };
    } });
  assert.deepEqual(await reader.read({ anidbId: 19586, page: 1 }),
    { state: 'unavailable' });
  time = 500;
  await reader.read({ anidbId: 19586, page: 1 });
  assert.equal(calls, 2);
  time = 1_000;
  assert.equal((await reader.read({ anidbId: 19586, page: 1 })).state,
    'details');
  assert.equal(calls, 3);
});
