import assert from 'node:assert/strict';
import test from 'node:test';
import { observeShokoUnrecognized } from
  '../src/acquisition/observe-shoko-unrecognized.mjs';

const file = { ID: 81, Size: 1000, SeriesIDs: [],
  Locations: [{ AbsolutePath: '/pure/Import/Negev/negev-7-aaaaaaaaaaaaaaaa/01.mkv',
    IsAccessible: true }] };
const sourcePath = file.Locations[0].AbsolutePath;
const run = (overrides = {}) => observeShokoUnrecognized({
  sourcePath, expectedSize: 1000, publishedMs: 0, nowMs: 600_000,
  readFile: async () => [file], readQueue: async () => ({ state: 'quiet_observed' }),
  readUnrecognized: async () => ({ state: 'unrecognized' }),
  ...overrides,
});

test('requires an exact Shoko unrecognized file on two separated quiet reads', async () => {
  assert.deepEqual(await run(), { state: 'unrecognized_pending',
    fileId: 81, firstSeenMs: 600_000 });
  assert.deepEqual(await run({ prior: { fileId: 81, firstSeenMs: 600_000 },
    nowMs: 660_000 }), { state: 'unrecognized_confirmed', fileId: 81 });
  assert.equal((await run({ prior: { fileId: 81, firstSeenMs: 600_000 },
    nowMs: 659_999 })).state, 'unrecognized_pending');
});

test('still processing, changed path or identity never authorizes recovery', async () => {
  assert.equal((await run({ prior: { fileId: 81, firstSeenMs: 600_000 },
    nowMs: 660_000, readUnrecognized: async () =>
      ({ state: 'not_unrecognized' }) })).state, 'awaiting_shoko');
  assert.equal((await run({ readQueue: async () => ({ state: 'busy' }) })).state,
    'awaiting_shoko');
  assert.equal((await run({ readFile: async () => [] })).state,
    'awaiting_shoko');
  assert.equal((await run({ readFile: async () => [{ ...file,
    SeriesIDs: [42] }] })).state, 'recognized');
  assert.equal((await run({ readFile: async () => [{ ...file,
    Locations: [{ AbsolutePath: '/other/01.mkv', IsAccessible: true }] }] }))
    .state, 'awaiting_shoko');
  assert.equal((await run({ readFile: async () => { throw Error('offline'); } }))
    .state, 'shoko_unavailable');
});
