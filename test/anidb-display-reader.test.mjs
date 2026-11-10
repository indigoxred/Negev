import assert from 'node:assert/strict';
import test from 'node:test';
import { createAniDbDisplayReader } from '../src/catalogue/anidb-display-reader.mjs';

test('display reader accepts only the exact non-restricted AniDB record and coalesces viewers', async () => {
  let calls = 0;
  const reader = createAniDbDisplayReader({ now: () => 1_000,
    fetchImpl: async (url) => {
      calls++;
      assert.equal(url, 'https://animap.id/api/anidb/4158');
      return new Response(JSON.stringify({ anidb_id: 4158,
        title: 'Pale Cocoon', title_english: null,
        type: 'OVA', restricted: false, startyear: 2005,
        startdate: '2005-12-10', enddate: '2005-12-10', episodecount: 1,
        description: '<p>A quiet archive &amp; a lost world.</p>',
        tags: [{ name: 'science fiction', weight: 600 }] }));
    } });
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    reader.read({ anidbId: 4158 })));
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.state === 'display'));
  assert.deepEqual(results[0], { state: 'display', anidbId: 4158,
    title: 'Pale Cocoon', restricted: false, englishTitle: null, type: 'OVA', startYear: 2005,
    startDate: '2005-12-10', endDate: '2005-12-10', episodeCount: 1,
    description: 'A quiet archive & a lost world.', tags: ['science fiction'] });
  await reader.read({ anidbId: 4158 });
  assert.equal(calls, 1);
});

test('display reader rejects mismatched, unknown-age and oversized records', async () => {
  for (const data of [
    { anidb_id: 2, restricted: false },
    { anidb_id: 1, restricted: null },
    { anidb_id: 1, restricted: false, title: 'x'.repeat(501) },
  ]) {
    const reader = createAniDbDisplayReader({ fetchImpl: async () =>
      new Response(JSON.stringify(data)) });
    assert.equal((await reader.read({ anidbId: 1 })).state, 'unavailable');
  }
});

test('display descriptions show character names instead of raw AniDB character links', async () => {
  const reader = createAniDbDisplayReader({ fetchImpl: async () =>
    new Response(JSON.stringify({ anidb_id: 42, title: 'Example',
      restricted: false, tags: [],
      description: '<p>http://anidb.net/ch147564 [Fia] meets https://anidb.net/cr68397 [Yashu].</p>' })) });
  const display = await reader.read({ anidbId: 42 });
  assert.equal(display.description, 'Fia meets Yashu.');
});

test('unreleased empty title does not display AniMap epoch placeholder as an air date', async () => {
  const reader = createAniDbDisplayReader({ fetchImpl: async () =>
    new Response(JSON.stringify({ anidb_id: 20426, title: 'Liar Game 2',
      restricted: false, tags: [], startyear: 1970,
      startdate: '1970-01-01', enddate: null, episodecount: 0 })) });
  const display = await reader.read({ anidbId: 20426 });
  assert.equal(display.state, 'display');
  assert.equal(display.startYear, null);
  assert.equal(display.startDate, null);
});

test('display reader keeps a valid title with more than 100 catalogue tags', async () => {
  const reader = createAniDbDisplayReader({ fetchImpl: async () =>
    new Response(JSON.stringify({ anidb_id: 69, title: 'One Piece',
      restricted: false, description: 'Pirates seek the great treasure.',
      tags: Array.from({ length: 122 }, (_, index) => ({ name: `tag ${index + 1}` })) })) });
  const display = await reader.read({ anidbId: 69 });
  assert.equal(display.state, 'display');
  assert.equal(display.description, 'Pirates seek the great treasure.');
  assert.deepEqual(display.tags, Array.from({ length: 8 }, (_, index) => `tag ${index + 1}`));
});

test('different display titles use a bounded queue without blocking one another', async () => {
  let active = 0;
  let peak = 0;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const reader = createAniDbDisplayReader({ concurrency: 2,
    fetchImpl: async (url) => {
      active++; peak = Math.max(peak, active);
      await hold;
      active--;
      const id = Number(String(url).split('/').at(-1));
      return new Response(JSON.stringify({ anidb_id: id, restricted: false,
        title: `Anime ${id}`, title_english: null, description: null,
        tags: [] }));
    } });
  const reads = [1, 2, 3].map((anidbId) => reader.read({ anidbId }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  release();
  assert.ok((await Promise.all(reads)).every((result) => result.state === 'display'));
});
