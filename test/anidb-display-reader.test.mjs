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
        description: '<p>A quiet archive &amp; a lost world.</p>',
        tags: [{ name: 'science fiction', weight: 600 }] }));
    } });
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    reader.read({ anidbId: 4158 })));
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.state === 'display'));
  assert.deepEqual(results[0], { state: 'display', anidbId: 4158,
    title: 'Pale Cocoon', englishTitle: null, type: 'OVA', startYear: 2005,
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
