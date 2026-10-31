import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createAniDbTitleSource } from '../src/catalogue/anidb-title-source.mjs';

const dump = gzipSync('# aid|type|language|title\n17|1|x-jat|Main Name\n17|4|en|English Name\n');
const response = (bytes, status = 200) => new Response(bytes, { status });

test('loads a bounded compressed AniDB title dump and searches its aliases', async () => {
  const calls = [];
  const source = createAniDbTitleSource({ now: () => 1000,
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init });
      return response(dump); } });
  assert.deepEqual(await source.refresh(), { state: 'ready', titles: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://anidb.net/api/anime-titles.dat.gz');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(source.search({ query: 'English Name' }).items[0].anidbId, 17);
  assert.deepEqual(source.releaseQueries(17), ['Main Name', 'English Name']);
  assert.equal(source.search({ query: 'English Name' }).items[0].requestable, false);
});

test('catalogue decompression lets the event loop run before refresh completes', async () => {
  const source = createAniDbTitleSource({
    fetchImpl: async () => response(dump),
  });
  const order = [];
  const refreshed = source.refresh().then((result) => {
    order.push('refreshed');
    return result;
  });
  await new Promise((resolve) => setImmediate(() => {
    order.push('tick');
    resolve();
  }));
  assert.deepEqual(await refreshed, { state: 'ready', titles: 1 });
  assert.deepEqual(order, ['tick', 'refreshed']);
});

test('rejects redirects, malformed gzip and oversized expanded data without replacing a good index', async () => {
  let bytes = dump;
  let status = 200;
  let time = 0;
  const source = createAniDbTitleSource({ now: () => time,
    maxExpandedBytes: 100, maxCompressedBytes: 100,
    fetchImpl: async () => response(bytes, status) });
  assert.equal((await source.refresh()).state, 'ready');
  for (const update of [
    () => { status = 302; },
    () => { status = 200; bytes = Buffer.from('not gzip'); },
    () => { bytes = gzipSync('x'.repeat(101)); },
  ]) {
    time += 86_400_000;
    update();
    assert.deepEqual(await source.refresh(), { state: 'stale', titles: 1 });
    assert.equal(source.search({ query: 'English Name' }).items[0].anidbId, 17);
  }
});

test('a failed first fetch leaves catalogue unavailable', async () => {
  const source = createAniDbTitleSource({ fetchImpl: async () => response(null, 503) });
  assert.deepEqual(await source.refresh(), { state: 'unavailable' });
  assert.deepEqual(source.search({ query: 'Title' }), { state: 'unavailable' });
});

test('coalesces refreshes and backs off after an unavailable AniDB response', async () => {
  let calls = 0;
  let time = 0;
  const source = createAniDbTitleSource({ now: () => time,
    fetchImpl: async () => { calls++; return response(null, 503); } });
  assert.deepEqual(await Promise.all([source.refresh(), source.refresh()]),
    [{ state: 'unavailable' }, { state: 'unavailable' }]);
  assert.equal(calls, 1);
  time = 60_000;
  assert.deepEqual(await source.refresh(), { state: 'unavailable' });
  assert.equal(calls, 1);
  time = 15 * 60_000;
  await source.refresh();
  assert.equal(calls, 2);
});
