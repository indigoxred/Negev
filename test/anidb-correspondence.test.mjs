import assert from 'node:assert/strict';
import test from 'node:test';
import { createAniDbCorrespondence } from '../src/identity/anidb-correspondence.mjs';

const file = { name: '[Group] Example - 01 [AABBCCDD].mkv', size: 1000,
  episodeIds: [1001] };
const row = { anidb_file_id: 99, anidb_id: 42, anidb_episode_id: 1001,
  size: 1000, crc32: 'aabbccdd', ed2k: 'e'.repeat(32) };
const input = { anidbId: 42, torrentHash: 'a'.repeat(40), files: [file] };

test('advertised CRC and exact metainfo size establish likely correspondence only', async () => {
  let calls = 0;
  const inspect = createAniDbCorrespondence({ fetchImpl: async (url) => {
    calls++;
    assert.equal(url.origin, 'https://animap.id');
    assert.equal(url.searchParams.get('crc32'), 'AABBCCDD');
    assert.equal(url.searchParams.get('size'), '1000');
    return Response.json([row]);
  } });
  const result = await inspect(input);
  assert.equal(result.files[0].state, 'likely');
  assert.equal(result.files[0].basis, 'advertised_crc32_and_size');
  assert.equal(result.files[0].anidbFileId, 99);
  assert.equal(result.state, 'likely');
  assert.equal(calls, 1);
  assert.deepEqual(await inspect(input), result);
  assert.equal(calls, 1);
  // Cache raw evidence, never a verdict scoped to somebody else's title.
  assert.equal((await inspect({ ...input, anidbId: 43 })).state, 'unknown');
  assert.equal(calls, 1);
});

test('every selected pack file has its own evidence and partial evidence cannot label the pack', async () => {
  const inspect = createAniDbCorrespondence({ fetchImpl: async () => Response.json([row]) });
  const result = await inspect({ ...input, files: [file,
    { name: 'Example - 02.mkv', size: 2000, episodeIds: [1002] }] });
  assert.equal(result.state, 'partial');
  assert.deepEqual(result.files.map((item) => item.state), ['likely', 'unknown']);
});

test('filename prediction is distinct from AniDB correspondence', async () => {
  const inspect = createAniDbCorrespondence({ fetchImpl: async () => {
    throw Error('no request without CRC');
  } });
  const result = await inspect({ ...input,
    files: [{ ...file, name: 'Example - 01.mkv' }], filenamePrediction: true });
  assert.equal(result.state, 'filename_prediction');
  assert.equal(result.files[0].state, 'filename_prediction');
});

for (const [name, rows] of Object.entries({ wrong_size: [{ ...row, size: 999 }],
  wrong_episode: [{ ...row, anidb_episode_id: 9999 }],
  wrong_anime: [{ ...row, anidb_id: 43 }], wrong_hash: [{ ...row, crc32: '11111111' }],
  ambiguous_file: [row, { ...row, anidb_file_id: 100 }], empty: [],
  invalid: [{ ...row, anidb_file_id: -1 }] })) {
  test(`${name} remains unknown, never blocks acquisition`, async () => {
    const inspect = createAniDbCorrespondence({ fetchImpl: async () => Response.json(rows) });
    assert.equal((await inspect(input)).state, 'unknown');
  });
}

test('prior exact history requires a computed hash confirmed for the same AniDB target', async () => {
  const inspect = createAniDbCorrespondence({
    readPreviouslyVerified: async () => ({ ed2k: 'e'.repeat(32), size: 1000 }),
    fetchImpl: async (url) => {
      assert.equal(url.searchParams.get('ed2k'), 'e'.repeat(32));
      return Response.json([row]);
    },
  });
  const result = await inspect(input);
  assert.equal(result.state, 'previously_verified');
  assert.equal(result.files[0].basis, 'previously_downloaded_ed2k_and_size');
});

test('provider failure, missing registration and prediction are not negative identity findings', async () => {
  for (const status of [404, 429, 500]) {
    let calls = 0;
    const inspect = createAniDbCorrespondence({ fetchImpl: async () => {
      calls++; return new Response(null, { status });
    } });
    assert.equal((await inspect(input)).state, 'unknown');
    assert.equal((await inspect(input)).state, 'unknown');
    assert.equal(calls, 1);
  }
});

test('lookups and their body reads have a total deadline even if a provider never settles', async () => {
  const inspect = createAniDbCorrespondence({ maxElapsedMs: 40, timeoutMs: 20,
    fetchImpl: async () => new Promise(() => {}) });
  const start = performance.now();
  assert.equal((await inspect(input)).state, 'unknown');
  assert.ok(performance.now() - start < 500);
});

test('a stalled response body cannot exceed the lookup deadline', async () => {
  const inspect = createAniDbCorrespondence({ maxElapsedMs: 40, timeoutMs: 20,
    fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
  const start = performance.now();
  assert.equal((await inspect(input)).state, 'unknown');
  assert.ok(performance.now() - start < 500);
});

test('concurrent identical lookups share one request and excessive concurrency stays unknown', async () => {
  let calls = 0, release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const inspect = createAniDbCorrespondence({ fetchImpl: async () => {
    calls++; await blocked; return Response.json([row]);
  } });
  const first = inspect(input), second = inspect(input);
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});

test('network budget leaves individual remaining files unknown, cache hits need no budget', async () => {
  let calls = 0;
  const inspect = createAniDbCorrespondence({ maxLookups: 1,
    fetchImpl: async () => { calls++; return Response.json([row]); } });
  const second = { ...file, name: 'Example - 02 [11223344].mkv', episodeIds: [1002] };
  const result = await inspect({ ...input, files: [file, second] });
  assert.equal(result.files[0].state, 'likely');
  assert.equal(result.files[1].state, 'unknown');
  assert.equal(calls, 1);
  await inspect(input);
  assert.equal(calls, 1);
});

test('bounded cache expires negatives and evicts old entries', async () => {
  let nowMs = 0, calls = 0;
  const inspect = createAniDbCorrespondence({ now: () => nowMs, maxCacheEntries: 1,
    fetchImpl: async () => { calls++; return new Response(null, { status: 404 }); } });
  await inspect(input); await inspect(input);
  assert.equal(calls, 1);
  nowMs += 5 * 60_000 + 1;
  await inspect(input);
  assert.equal(calls, 2);
  await inspect({ ...input, files: [{ ...file, name: 'Other [11223344].mkv' }] });
  await inspect(input);
  assert.equal(calls, 4);
});
