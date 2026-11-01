import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFirstTimeAbsence } from
  '../src/acquisition/collect-first-time-absence.mjs';
import { confirmMissingTargets } from
  '../src/acquisition/confirm-missing-targets.mjs';

const targets = { anidbId: 42, episodeIds: [1001] };
const importState = (observedAtMs = 100, fingerprint = 'stable') => ({
  state: 'settled', ...targets, observedAtMs, fingerprint });
const providers = (overrides = {}) => ({ ...targets, publicLibraryIds: [102],
  readEpisode: async ({ anidbId, episodeId }) => ({
    state: 'not_imported', anidbId, episodeId }),
  readPublic: async () => ({ state: 'ok', complete: true,
    libraryIds: [102], parts: [] }),
  readImport: async () => importState(), now: () => 110,
  ...overrides });

test('collects one exact fresh first-time snapshot without any provider write', async () => {
  const order = [];
  const result = await collectFirstTimeAbsence(providers({
    readImport: async () => { order.push('import'); return importState(); },
    readEpisode: async (target) => {
      order.push('episode'); return { state: 'not_imported', ...target };
    },
    readPublic: async () => { order.push('plex');
      return { state: 'ok', complete: true, libraryIds: [102], parts: [] }; },
  }));
  assert.deepEqual(order, ['import', 'episode', 'plex', 'import']);
  assert.deepEqual(result, { anidbId: 42, episodeIds: [1001],
    observedAtMs: 110,
    shoko: { state: 'unimported_targets', ...targets },
    plex: { state: 'ok', complete: true, libraryIds: [102], parts: [] },
    importFence: { state: 'settled', ...targets,
      beforeObservedAtMs: 100, afterObservedAtMs: 100 } });
});

test('hashing, wrong title, and provider outage cannot claim absence', async () => {
  for (const observed of [
    { state: 'ok', complete: true, files: [] },
    { state: 'not_imported', anidbId: 99, episodeId: 1001 },
    { state: 'unavailable' },
  ]) {
    let publicReads = 0;
    const result = await collectFirstTimeAbsence(providers({
      readEpisode: async () => observed,
      readPublic: async () => { publicReads++; return {}; },
    }));
    assert.deepEqual(result, { state: 'held',
      reason: 'target_not_proven_unimported', episodeId: 1001 });
    assert.equal(publicReads, 0);
  }
});

test('Plex-only part, partial page, wrong section or failed read holds', async () => {
  for (const publicResult of [
    { state: 'ok', complete: true, libraryIds: [102],
      parts: [{ storageKey: 'other', libraryId: 102, readable: true }] },
    { state: 'ok', complete: false, libraryIds: [102], parts: [] },
    { state: 'ok', complete: true, libraryIds: [103], parts: [] },
    { state: 'unavailable' },
  ]) {
    const result = await collectFirstTimeAbsence(providers({
      readPublic: async () => publicResult }));
    assert.deepEqual(result, { state: 'held',
      reason: 'public_absence_unverified' });
  }
  assert.deepEqual(await collectFirstTimeAbsence(providers({
    readPublic: async () => { throw Error('Plex down'); },
  })), { state: 'held', reason: 'public_absence_unverified' });
});

test('quiet-only import, changed fingerprint and stale evidence hold', async () => {
  for (const [first, second, currentMs] of [
    [{ state: 'quiet_observed' }, { state: 'quiet_observed' }, 110],
    [importState(100, 'one'), importState(101, 'two'), 110],
    [importState(1), importState(1), 40_000],
    [importState(200), importState(200), 110],
  ]) {
    let reads = 0;
    const result = await collectFirstTimeAbsence(providers({
      readImport: async () => ++reads === 1 ? first : second,
      now: () => currentMs }));
    assert.deepEqual(result, { state: 'held',
      reason: 'import_activity_unverified' });
  }
});

test('invalid target scope never calls a provider', async () => {
  let reads = 0;
  await assert.rejects(collectFirstTimeAbsence(providers({
    episodeIds: [1001, 1001], readImport: async () => { reads++; return {}; },
  })), TypeError);
  assert.equal(reads, 0);
});

test('a wrong first Import scope stops before reading Shoko or Plex', async () => {
  let episodeReads = 0;
  let publicReads = 0;
  const result = await collectFirstTimeAbsence(providers({
    readImport: async () => ({ ...importState(), anidbId: 99 }),
    readEpisode: async () => { episodeReads++; return {}; },
    readPublic: async () => { publicReads++; return {}; },
  }));
  assert.deepEqual(result, { state: 'held',
    reason: 'import_activity_unverified' });
  assert.equal(episodeReads, 0);
  assert.equal(publicReads, 0);
});

test('the complete synthetic snapshot satisfies the existing strict decision gate', async () => {
  const snapshot = await collectFirstTimeAbsence(providers());
  const result = await confirmMissingTargets({ request: {
    id: 1, anidbId: 42, episodeIds: [1001], status: 'held' },
  episodeIds: [1001], publicLibraryIds: [102], now: () => 111,
  readEvidence: async () => snapshot });
  assert.deepEqual(result, { state: 'missing_confirmed', checkedAtMs: 111 });
});
