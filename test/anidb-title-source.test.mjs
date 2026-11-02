import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createAniDbTitleSource } from '../src/catalogue/anidb-title-source.mjs';

const dump = gzipSync('# aid|type|language|title\n17|1|x-jat|Main Name\n17|4|en|English Name\n');
const response = (bytes, status = 200) => new Response(bytes, { status });
const cleanup = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((dir) => rm(dir,
  { recursive: true, force: true }))));

test('a validated title dump survives restart and an AniDB outage', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-title-cache-'));
  cleanup.push(dir);
  const cachePath = path.join(dir, 'titles.dat.gz');
  const first = createAniDbTitleSource({ cachePath, now: () => 1000,
    fetchImpl: async () => response(dump) });
  assert.deepEqual(await first.refresh(), { state: 'ready', titles: 1 });
  const restarted = createAniDbTitleSource({ cachePath, now: () => 2000,
    fetchImpl: async () => response(null, 503) });
  assert.deepEqual(await restarted.refresh(), { state: 'stale', titles: 1 });
  assert.equal(restarted.search({ query: 'English Name' }).items[0].anidbId, 17);
});

test('a failed refresh preserves the saved catalogue until a newer valid dump replaces it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-title-cache-'));
  cleanup.push(dir);
  const cachePath = path.join(dir, 'titles.dat.gz');
  let time = 0;
  let bytes = dump;
  const source = createAniDbTitleSource({ cachePath, now: () => time,
    fetchImpl: async () => response(bytes) });
  assert.equal((await source.refresh()).state, 'ready');
  time = 86_400_000;
  bytes = Buffer.from('invalid gzip');
  assert.deepEqual(await source.refresh(), { state: 'stale', titles: 1 });
  const old = createAniDbTitleSource({ cachePath,
    fetchImpl: async () => response(null, 503) });
  assert.equal((await old.refresh()).state, 'stale');
  assert.equal(old.search({ query: 'English Name' }).total, 1);
  time += 86_400_000;
  bytes = gzipSync('# aid|type|language|title\n18|1|x-jat|Replacement Name\n');
  assert.equal((await source.refresh()).state, 'ready');
  const newer = createAniDbTitleSource({ cachePath,
    fetchImpl: async () => response(null, 503) });
  assert.equal((await newer.refresh()).state, 'stale');
  assert.equal(newer.search({ query: 'Replacement Name' }).items[0].anidbId, 18);
  assert.equal(newer.search({ query: 'English Name' }).total, 0);
});

test('a cached catalogue limits the first AniDB outage delay', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-title-cache-'));
  cleanup.push(dir);
  const cachePath = path.join(dir, 'titles.dat.gz');
  const seeded = createAniDbTitleSource({ cachePath,
    fetchImpl: async () => response(dump) });
  assert.equal((await seeded.refresh()).state, 'ready');
  const restarted = createAniDbTitleSource({ cachePath,
    timeoutMs: 1_000, cachedTimeoutMs: 20,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason),
        { once: true });
    }) });
  const result = await Promise.race([restarted.refresh(),
    new Promise((resolve) => setTimeout(() => resolve({ state: 'too_slow' }), 200))]);
  assert.deepEqual(result, { state: 'stale', titles: 1 });
});

test('a failed cache write is visible despite a valid live catalogue', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-title-cache-'));
  cleanup.push(dir);
  const source = createAniDbTitleSource({
    cachePath: path.join(dir, 'missing-parent', 'titles.dat.gz'),
    fetchImpl: async () => response(dump) });
  assert.deepEqual(await source.refresh(),
    { state: 'ready', titles: 1, cacheWriteFailed: true });
});

test('corrupt and oversized saved title dumps do not become search results', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-title-cache-'));
  cleanup.push(dir);
  const cachePath = path.join(dir, 'titles.dat.gz');
  for (const bytes of [Buffer.from('bad gzip'), Buffer.alloc(101)]) {
    await writeFile(cachePath, bytes);
    const source = createAniDbTitleSource({ cachePath, maxCompressedBytes: 100,
      fetchImpl: async () => response(null, 503) });
    assert.deepEqual(await source.refresh(), { state: 'unavailable' });
    assert.deepEqual(source.search({ query: 'English Name' }),
      { state: 'unavailable' });
  }
});

test('a symlinked saved title dump is rejected', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-title-cache-'));
  cleanup.push(dir);
  const target = path.join(dir, 'target.dat.gz');
  const cachePath = path.join(dir, 'titles.dat.gz');
  await writeFile(target, dump);
  try { await symlink(target, cachePath); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error?.code)) return t.skip('Symlink unavailable');
    throw error;
  }
  const source = createAniDbTitleSource({ cachePath,
    fetchImpl: async () => response(null, 503) });
  assert.deepEqual(await source.refresh(), { state: 'unavailable' });
});

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

test('a late malformed title row cannot publish a partially refreshed catalogue', async () => {
  let bytes = dump;
  let time = 0;
  const source = createAniDbTitleSource({ now: () => time,
    fetchImpl: async () => response(bytes) });
  assert.equal((await source.refresh()).state, 'ready');
  bytes = gzipSync(`${Array.from({ length: 4_100 }, (_, index) =>
    `${index + 20}|1|x-jat|New ${index}`).join('\n')}\ninvalid row`);
  time = 86_400_000;
  assert.deepEqual(await source.refresh(), { state: 'stale', titles: 1 });
  assert.equal(source.search({ query: 'English Name' }).items[0].anidbId, 17);
  assert.equal(source.search({ query: 'New 1' }).total, 0);
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
