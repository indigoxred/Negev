import assert from 'node:assert/strict';
import test from 'node:test';
import { probeTargetPresence } from '../src/acquisition/probe-target-presence.mjs';

test('mixed target states preserve local-missing uncertainty and continue later episodes', async () => {
  const reads = [];
  const result = await probeTargetPresence({ anidbId: 42,
    episodeIds: [1001, 1002, 1003], kind: 'series', now: () => 500,
    readImportActivity: async () => ({ state: 'quiet_observed' }),
    readShokoEpisode: async ({ episodeId }) => {
      reads.push(episodeId);
      return episodeId === 1001 ? { state: 'not_imported' } :
        { state: 'ok', complete: true, files: episodeId === 1002 ?
          [{ fileId: 7, episodeIds: [1002] }] : [] };
    },
    readPublicTarget: async ({ episodeId }) => episodeId === 1002 ?
      { state: 'available' } : { state: 'unknown' },
  });
  assert.deepEqual(reads, [1001, 1002, 1003]);
  assert.deepEqual(result, { state: 'probe', observedAtMs: 500,
    targets: [
      { episodeId: 1001, state: 'unknown', reason: 'locally_missing_unconfirmed' },
      { episodeId: 1002, state: 'available', reason: 'public_plex_verified' },
      { episodeId: 1003, state: 'unknown', reason: 'locally_missing_unconfirmed' },
    ] });
});

test('an import in progress or provider outage never becomes missing permission', async () => {
  let activityReads = 0;
  const result = await probeTargetPresence({ anidbId: 42,
    episodeIds: [1001, 1002, 1003], kind: 'series', now: () => 500,
    readImportActivity: async () => (++activityReads === 1
      ? { state: 'quiet_observed' } : { state: 'unsettled', count: 1 }),
    readShokoEpisode: async ({ episodeId }) => episodeId === 1003
      ? { state: 'unavailable' } : episodeId === 1002
        ? { state: 'ok', complete: true, files: [{ fileId: 8,
          episodeIds: [1002] }] } : { state: 'not_imported' },
    readPublicTarget: async () => { throw new Error('Plex unavailable'); },
  });
  assert.deepEqual(result.targets, [
    { episodeId: 1001, state: 'unknown', reason: 'import_in_progress' },
    { episodeId: 1002, state: 'present_in_shoko', reason: 'awaiting_public_plex' },
    { episodeId: 1003, state: 'unknown', reason: 'observer_unavailable' },
  ]);
  assert.equal(activityReads, 2);
});

test('contradictory public and Shoko observations stay unknown', async () => {
  const result = await probeTargetPresence({ anidbId: 42,
    episodeIds: [1001], kind: 'movie', now: () => 600,
    readImportActivity: async () => ({ state: 'quiet_observed' }),
    readShokoEpisode: async () => ({ state: 'not_imported' }),
    readPublicTarget: async () => ({ state: 'available' }),
  });
  assert.deepEqual(result.targets, [
    { episodeId: 1001, state: 'unknown', reason: 'conflicting_observers' },
  ]);
});

test('probe rejects duplicate or unbounded target lists before provider calls', async () => {
  let calls = 0;
  const provider = async () => { calls++; return { state: 'unavailable' }; };
  for (const episodeIds of [[1001, 1001], Array.from({ length: 11 },
    (_, index) => index + 1)]) {
    await assert.rejects(probeTargetPresence({ anidbId: 42,
      episodeIds, kind: 'series', readImportActivity: provider,
      readShokoEpisode: provider, readPublicTarget: provider }), TypeError);
  }
  assert.equal(calls, 0);
});
