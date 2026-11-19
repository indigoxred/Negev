import assert from 'node:assert/strict';
import test from 'node:test';
import { collectTargetScopedUncertain } from
  '../src/acquisition/collect-target-scoped-uncertain.mjs';
import { confirmMissingTargets } from
  '../src/acquisition/confirm-missing-targets.mjs';

const scope = { anidbId: 42, episodeIds: [1001], kind: 'series',
  publicLibraryIds: [102] };
const publicState = { state: 'healthy_unconfirmed', libraryIds: [102],
  parts: [], complete: false, probeCoverage: 'health_only',
  sourceVerified: true };
const providers = (overrides = {}) => ({
  ...scope, readEpisode: async (target) => ({ state: 'not_imported', ...target }),
  probePublic: async () => publicState, now: () => 100, ...overrides,
});

test('checks exact targets twice and returns without a global import wait', async () => {
  const calls = [];
  const result = await collectTargetScopedUncertain(providers({
    readEpisode: async (target) => { calls.push('shoko');
      return { state: 'not_imported', ...target }; },
    probePublic: async () => { calls.push('plex'); return publicState; },
  }));
  assert.deepEqual(calls, ['shoko', 'plex', 'shoko', 'plex']);
  assert.deepEqual(result, { anidbId: 42, episodeIds: [1001],
    observedAtMs: 100,
    shoko: { state: 'unimported_targets', anidbId: 42, episodeIds: [1001] },
    plex: publicState, importFence: { state: 'target_rechecked',
      anidbId: 42, episodeIds: [1001],
      beforeObservedAtMs: 100, afterObservedAtMs: 100 } });
  assert.deepEqual(await confirmMissingTargets({
    request: { id: 1, status: 'held', ...scope },
    episodeIds: [1001], publicLibraryIds: [102],
    firstTimePolicy: 'single_uncertain_attempt',
    readEvidence: async () => result, now: () => 101,
  }), { state: 'missing_confirmed', checkedAtMs: 101,
    observedAtMs: 100, evidencePolicy: 'first_time_permissive' });
});

test('a target appearing between checks blocks the attempt', async () => {
  let reads = 0;
  const result = await collectTargetScopedUncertain(providers({
    readEpisode: async (target) => ++reads === 1
      ? { state: 'not_imported', ...target }
      : { state: 'ok', complete: true, files: [{}] },
  }));
  assert.deepEqual(result, { state: 'held',
    reason: 'target_not_proven_unimported', episodeId: 1001 });
});

test('a failed public probe blocks the attempt', async () => {
  const result = await collectTargetScopedUncertain(providers({
    probePublic: async () => { throw Error('Plex unavailable'); },
  }));
  assert.deepEqual(result, { state: 'held',
    reason: 'public_probe_unverified' });
});
