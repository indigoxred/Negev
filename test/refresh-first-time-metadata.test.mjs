import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshFirstTimeMetadata } from '../src/acquisition/refresh-first-time-metadata.mjs';

test('only an exact missing Shoko metadata hold asks the bounded hydrator', async () => {
  const calls = [];
  const hydrate = async (input) => { calls.push(input); return { state: 'pending',
    reason: 'refresh_queued' }; };
  const missing = { state: 'held', reason: 'shoko_metadata_missing', episodeId: 1001 };
  assert.deepEqual(await refreshFirstTimeMetadata({ anidbId: 42,
    episodeIds: [1001], observation: missing, hydrate }), missing);
  assert.deepEqual(calls, [{ anidbId: 42, missingEpisodeId: 1001 }]);
  for (const observation of [{ state: 'held', reason: 'metadata_reader_busy' },
    { state: 'held', reason: 'shoko_metadata_missing', episodeId: 9999 },
    { state: 'unimported_targets', anidbId: 42, episodeIds: [1001] }]) {
    assert.deepEqual(await refreshFirstTimeMetadata({ anidbId: 42,
      episodeIds: [1001], observation, hydrate }), observation);
  }
  assert.equal(calls.length, 1);
});

test('refresh failure leaves acquisition held', async () => {
  const missing = { state: 'held', reason: 'shoko_metadata_missing', episodeId: 1001 };
  assert.deepEqual(await refreshFirstTimeMetadata({ anidbId: 42,
    episodeIds: [1001], observation: missing,
    hydrate: async () => { throw new Error('Shoko offline'); } }), missing);
});

test('a later exact Shoko observation releases its completed refresh claim', async () => {
  const calls = [];
  const observation = { state: 'held', reason: 'public_probe_unverified' };
  assert.deepEqual(await refreshFirstTimeMetadata({ anidbId: 42,
    episodeIds: [1001], observation,
    pendingClaim: { anidbId: 42 },
    hydrate: async (input) => { calls.push(input); } }), observation);
  assert.deepEqual(calls, [{ anidbId: 42 }]);
});
