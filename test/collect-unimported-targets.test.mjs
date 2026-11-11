import assert from 'node:assert/strict';
import test from 'node:test';
import { collectUnimportedTargets } from
  '../src/acquisition/collect-unimported-targets.mjs';

test('two catalogue-verified missing episodes become one exact first-time observation', async () => {
  const calls = [];
  const result = await collectUnimportedTargets({ anidbId: 42,
    episodeIds: [1001, 1002], readEpisode: async (target) => {
      calls.push(target);
      return { state: 'not_imported', ...target };
    } });
  assert.deepEqual(calls, [{ anidbId: 42, episodeId: 1001 },
    { anidbId: 42, episodeId: 1002 }]);
  assert.deepEqual(result, { state: 'unimported_targets', anidbId: 42,
    episodeIds: [1001, 1002] });
});

test('a metadata-confirmed empty local episode is also unimported', async () => {
  const result = await collectUnimportedTargets({ anidbId: 42,
    episodeIds: [1001, 1002], readEpisode: async ({ episodeId }) =>
      episodeId === 1001
        ? { state: 'not_imported', anidbId: 42, episodeId }
        : { state: 'empty_episode', anidbId: 42, episodeId } });
  assert.deepEqual(result, { state: 'unimported_targets', anidbId: 42,
    episodeIds: [1001, 1002] });
});

test('one imported, unverified, wrong-title or unavailable episode prevents the aggregate', async () => {
  for (const changed of [
    { state: 'ok', complete: true, files: [] },
    { state: 'not_imported' },
    { state: 'not_imported', anidbId: 99, episodeId: 1002 },
    { state: 'empty_episode', anidbId: 99, episodeId: 1002 },
    { state: 'unavailable' },
  ]) {
    const result = await collectUnimportedTargets({ anidbId: 42,
      episodeIds: [1001, 1002], readEpisode: async ({ episodeId }) =>
        episodeId === 1001
          ? { state: 'not_imported', anidbId: 42, episodeId }
          : changed });
    assert.deepEqual(result, { state: 'held',
      reason: 'target_not_proven_unimported', episodeId: 1002 });
  }
});

test('reader failure and invalid target lists cannot claim unimported status', async () => {
  assert.deepEqual(await collectUnimportedTargets({ anidbId: 42,
    episodeIds: [1001], readEpisode: async () => {
      throw new Error('Shoko unavailable');
    } }), { state: 'held', reason: 'target_not_proven_unimported',
    episodeId: 1001 });
  await assert.rejects(collectUnimportedTargets({ anidbId: 42,
    episodeIds: [1001, 1001], readEpisode: async () => null }), TypeError);
});

test('a busy shared metadata reader has a distinct retryable hold reason', async () => {
  const result = await collectUnimportedTargets({ anidbId: 42,
    episodeIds: [1001], readEpisode: async () => ({ state: 'busy' }) });
  assert.deepEqual(result, { state: 'held', reason: 'metadata_reader_busy',
    episodeId: 1001 });
});

test('only an exact missing metadata row requests a bounded Shoko refresh', async () => {
  assert.deepEqual(await collectUnimportedTargets({ anidbId: 42,
    episodeIds: [1001], readEpisode: async () => ({ state: 'metadata_missing',
      anidbId: 42, episodeId: 1001 }) }), { state: 'held',
    reason: 'shoko_metadata_missing', episodeId: 1001 });
  assert.deepEqual(await collectUnimportedTargets({ anidbId: 42,
    episodeIds: [1001], readEpisode: async () => ({ state: 'metadata_missing',
      anidbId: 99, episodeId: 1001 }) }), { state: 'held',
    reason: 'target_not_proven_unimported', episodeId: 1001 });
});
