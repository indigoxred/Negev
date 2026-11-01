import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFirstTimeUncertain } from
  '../src/acquisition/collect-first-time-uncertain.mjs';
import { confirmMissingTargets } from
  '../src/acquisition/confirm-missing-targets.mjs';
import { observeImportQuietWindow } from
  '../src/acquisition/import-quiet-window.mjs';

const scope = { anidbId: 42, episodeIds: [1001] };
const quiet = { state: 'quiet_window_observed', ...scope,
  beforeObservedAtMs: 100, afterObservedAtMs: 120_100,
  feedGeneration: 5 };
const publicState = { state: 'healthy_unconfirmed',
  libraryIds: [102], parts: [], complete: false,
  probeCoverage: 'health_only', sourceVerified: true };
const providers = (overrides = {}) => ({ ...scope, kind: 'series',
  publicLibraryIds: [102],
  readEpisode: async (target) => ({ state: 'not_imported', ...target }),
  probePublic: async () => publicState,
  observeImport: async () => quiet,
  readFeedState: async () => ({ state: 'connected', generation: 5,
    pendingPaths: 0, pendingEvents: 0, inFlight: false,
    reconciliationNeeded: false }),
  now: () => 120_101, ...overrides });

test('brackets the quiet window with fresh Shoko and scoped Plex checks', async () => {
  const order = [];
  const input = providers({
    readEpisode: async (target) => { order.push('shoko');
      return { state: 'not_imported', ...target }; },
    probePublic: async () => { order.push('plex'); return publicState; },
    observeImport: async () => { order.push('quiet'); return quiet; },
  });
  const snapshot = await collectFirstTimeUncertain(input);
  assert.deepEqual(order, ['shoko', 'plex', 'quiet', 'shoko', 'plex']);
  assert.deepEqual(snapshot, { ...scope, observedAtMs: 120_101,
    shoko: { state: 'unimported_targets', ...scope },
    plex: publicState, importFence: quiet });
  const request = { id: 1, status: 'held', ...scope };
  assert.deepEqual(await confirmMissingTargets({ request,
    episodeIds: scope.episodeIds, publicLibraryIds: [102],
    readEvidence: async () => snapshot, now: () => 120_102,
    firstTimePolicy: 'single_uncertain_attempt' }),
  { state: 'missing_confirmed', checkedAtMs: 120_102,
    evidencePolicy: 'first_time_permissive' });
  const withoutSource = await confirmMissingTargets({ request,
    episodeIds: scope.episodeIds, publicLibraryIds: [102],
    readEvidence: async () => ({ ...snapshot,
      plex: { ...snapshot.plex, sourceVerified: false } }),
    now: () => 120_102,
    firstTimePolicy: 'single_uncertain_attempt' });
  assert.equal(withoutSource.state, 'held');
});

test('a file or public card arriving during the quiet window stops acquisition', async () => {
  let shokoReads = 0;
  assert.deepEqual(await collectFirstTimeUncertain(providers({
    readEpisode: async (target) => ++shokoReads === 1
      ? { state: 'not_imported', ...target }
      : { state: 'ok', complete: true, files: [{}] },
  })), { state: 'held', reason: 'target_not_proven_unimported',
    episodeId: 1001 });
  let plexReads = 0;
  assert.deepEqual(await collectFirstTimeUncertain(providers({
    probePublic: async () => ++plexReads === 1 ? publicState
      : { state: 'held', reason: 'public_card_observed' },
  })), { state: 'held', reason: 'public_probe_unverified' });
});

test('wrong scope, stale quiet result and provider failures remain held', async () => {
  for (const bad of [
    { ...quiet, anidbId: 99 },
    { ...quiet, afterObservedAtMs: 70_000 },
    { ...quiet, beforeObservedAtMs: 100_000 },
    { state: 'quiet_observed' },
  ]) {
    assert.deepEqual(await collectFirstTimeUncertain(providers({
      observeImport: async () => bad })),
    { state: 'held', reason: 'import_quiet_window_unverified' });
  }
  assert.deepEqual(await collectFirstTimeUncertain(providers({
    probePublic: async () => { throw Error('Plex down'); },
  })), { state: 'held', reason: 'public_probe_unverified' });
  assert.deepEqual(await collectFirstTimeUncertain(providers({
    probePublic: async () => ({ ...publicState, libraryIds: [103] }),
  })), { state: 'held', reason: 'public_probe_unverified' });
  assert.deepEqual(await collectFirstTimeUncertain(providers({
    probePublic: async () => ({ ...publicState, probeCoverage: undefined }),
  })), { state: 'held', reason: 'public_probe_unverified' });
  assert.deepEqual(await collectFirstTimeUncertain(providers({
    probePublic: async () => ({ ...publicState, sourceVerified: false }),
  })), { state: 'held', reason: 'public_probe_unverified' });
});

test('an Import event during the actual quiet-window helper prevents a first-time snapshot', async () => {
  let clock = 100;
  let generation = 5;
  const observeImport = (target) => observeImportQuietWindow({ ...target,
    readActivity: async () => ({ state: 'quiet_observed',
      fingerprint: 'a'.repeat(64) }),
    readFeedState: async () => ({ state: 'connected', generation,
      pendingPaths: 0, pendingEvents: 0, inFlight: false,
      reconciliationNeeded: false }),
    wait: async (ms) => { clock += ms; generation++; },
    now: () => clock, requireFingerprint: true,
  });
  assert.deepEqual(await collectFirstTimeUncertain(providers({
    observeImport, now: () => clock + 1,
  })), { state: 'held', reason: 'import_quiet_window_unverified' });
});

test('a failed Import window does not make another Shoko or Plex request', async () => {
  let shokoReads = 0;
  let plexReads = 0;
  const result = await collectFirstTimeUncertain(providers({
    readEpisode: async (target) => { shokoReads++;
      return { state: 'not_imported', ...target }; },
    probePublic: async () => { plexReads++; return publicState; },
    observeImport: async () => ({ state: 'held' }),
  }));
  assert.deepEqual(result, { state: 'held',
    reason: 'import_quiet_window_unverified' });
  assert.equal(shokoReads, 1);
  assert.equal(plexReads, 1);
});

test('a Shoko event during final Plex reads invalidates the quiet window', async () => {
  let generation = 5;
  let plexReads = 0;
  const result = await collectFirstTimeUncertain(providers({
    probePublic: async () => { if (++plexReads === 2) generation++;
      return publicState; },
    readFeedState: async () => ({ state: 'connected', generation,
      pendingPaths: 0, pendingEvents: 0, inFlight: false,
      reconciliationNeeded: false }),
  }));
  assert.deepEqual(result, { state: 'held',
    reason: 'import_quiet_window_unverified' });
});

test('final scoped feed permits the exact unrelated path without persisting it', async () => {
  const key = '1:negev-7-0123456789abcdef/01.mkv';
  const observed = await collectFirstTimeUncertain(providers({
    observeImport: async () => ({ ...quiet, unrelatedPendingKeys: [key] }),
    readFeedState: async (keys) => {
      assert.deepEqual(keys, [key]);
      return { state: 'connected_scoped', generation: 5,
        pendingPaths: 1, pendingEvents: 0, inFlight: false,
        reconciliationNeeded: true, pendingOnlyDebt: true };
    },
  }));
  assert.equal(observed.importFence.unrelatedPendingKeys, undefined);
  assert.deepEqual(await collectFirstTimeUncertain(providers({
    observeImport: async () => ({ ...quiet, unrelatedPendingKeys: [key] }),
    readFeedState: async () => ({ state: 'connected_scoped', generation: 5,
      pendingPaths: 2, pendingEvents: 0, inFlight: false,
      reconciliationNeeded: true, pendingOnlyDebt: true }),
  })), { state: 'held', reason: 'import_quiet_window_unverified' });
});
