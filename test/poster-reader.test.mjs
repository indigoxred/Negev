import assert from 'node:assert/strict';
import test from 'node:test';
import { createPosterReader } from '../src/catalogue/poster-reader.mjs';

test('poster reader caps concurrent lookups and caches an exact AniDB image', async () => {
  let active = 0;
  let peak = 0;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const reader = createPosterReader({ concurrency: 2, now: () => 1_000,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/api/anidb/')) {
        active++;
        peak = Math.max(peak, active);
        await hold;
        active--;
        const id = Number(String(url).split('/').at(-1));
        return new Response(JSON.stringify({ anidb_id: id, picture: `${id}.jpg` }));
      }
      return new Response(Buffer.from([0xff, 0xd8, 0xff]),
        { headers: { 'content-type': 'image/jpeg' } });
    } });
  const results = [1, 2, 3].map((anidbId) => reader.read({ anidbId }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  release();
  assert.deepEqual((await Promise.all(results)).map((item) => item.state),
    ['image', 'image', 'image']);
  const before = calls.length;
  assert.equal((await reader.read({ anidbId: 1 })).state, 'image');
  assert.equal(calls.length, before);
});

test('simultaneous viewers share one exact poster lookup', async () => {
  let calls = 0;
  const reader = createPosterReader({ concurrency: 2, now: () => 1_000,
    fetchImpl: async (url) => {
      calls++;
      if (String(url).includes('/api/anidb/')) {
        return new Response(JSON.stringify({ anidb_id: 4158,
          picture: '160916.jpg' }));
      }
      return new Response(Buffer.from([0xff, 0xd8, 0xff]),
        { headers: { 'content-type': 'image/jpeg' } });
    } });
  const copies = await Promise.all(Array.from({ length: 10 }, () =>
    reader.read({ anidbId: 4158 })));
  assert.ok(copies.every((item) => item.state === 'image'));
  assert.equal(calls, 2, 'one metadata and one image request');
});

test('poster cache stays within its byte budget and evicts older images', async () => {
  let calls = 0;
  const reader = createPosterReader({ now: () => 1_000, maxCacheBytes: 5,
    fetchImpl: async (url) => {
      calls++;
      if (String(url).includes('/api/anidb/')) {
        const id = Number(String(url).split('/').at(-1));
        return new Response(JSON.stringify({ anidb_id: id, picture: `${id}.jpg` }));
      }
      return new Response(Buffer.from([0xff, 0xd8, 0xff]),
        { headers: { 'content-type': 'image/jpeg' } });
    } });
  await reader.read({ anidbId: 1 });
  await reader.read({ anidbId: 2 });
  await reader.read({ anidbId: 2 });
  assert.equal(calls, 4, 'newest image remains cached');
  await reader.read({ anidbId: 1 });
  assert.equal(calls, 6, 'older image was evicted');
});
