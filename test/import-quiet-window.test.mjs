import assert from 'node:assert/strict';
import test from 'node:test';
import { observeImportQuietWindow, importFeedState,
  scopedImportFeedState } from
  '../src/acquisition/import-quiet-window.mjs';

test('scoped feed accepts only exact pending-only paths and preserves earlier debt', () => {
  const pending = { state: 'snapshot', generation: 7, pending: 0,
    inFlight: null, reconciliationNeeded: true,
    fullReconciliationNeeded: false, pendingOnlyDebt: true,
    pendingKeys: ['1:negev-7-0123456789abcdef/01.mkv'] };
  const connection = { state: 'connected' };
  const key = pending.pendingKeys[0];
  assert.deepEqual(scopedImportFeedState({ connection, snapshot: pending }),
    { state: 'pending_unverified', generation: 7, pendingPaths: 1 });
  assert.deepEqual(scopedImportFeedState({ connection, snapshot: pending,
    allowedPendingKeys: [key] }),
  { state: 'connected_scoped', generation: 7, pendingPaths: 1,
    pendingEvents: 0, inFlight: false, reconciliationNeeded: true,
    pendingOnlyDebt: true });
  for (const changed of [
    { snapshot: { ...pending, pendingOnlyDebt: false } },
    { snapshot: { ...pending, fullReconciliationNeeded: true } },
    { snapshot: { ...pending, pending: 1 } },
    { snapshot: { ...pending, pendingKeys: [...pending.pendingKeys, '1:manual.mkv'] } },
    { allowedPendingKeys: ['1:another.mkv'] },
    { connection: { state: 'disconnected' } },
  ]) assert.notEqual(scopedImportFeedState({ connection, snapshot: pending,
    allowedPendingKeys: [key], ...changed }).state, 'connected_scoped');
});

test('an explicitly uncertain first attempt can observe stable full debt without clearing it', async () => {
  const connection = { state: 'connected' };
  const snapshot = { state: 'snapshot', generation: 9, pending: 0,
    inFlight: null, reconciliationNeeded: true,
    fullReconciliationNeeded: true, pendingOnlyDebt: false,
    pendingKeys: [] };
  const read = () => scopedImportFeedState({ connection, snapshot,
    allowedPendingKeys: [], allowUnreconciledFirstAttempt: true });
  let clock = 1_000_000;
  const result = await observeImportQuietWindow({ anidbId: 42,
    episodeIds: [1001], readActivity: async () => ({ state: 'quiet_observed',
      fingerprint: 'a'.repeat(64), unrelatedPendingKeys: [] }),
    readFeedState: read, readScopedFeedState: read,
    wait: async () => { clock += 120_000; }, now: () => clock,
    requireFingerprint: true });
  assert.equal(result.state, 'quiet_window_observed');
  assert.equal(snapshot.fullReconciliationNeeded, true);
  assert.notEqual(scopedImportFeedState({ connection, snapshot,
    allowedPendingKeys: [] }).state, 'connected_uncertain');
  snapshot.generation++;
  assert.notEqual((await observeImportQuietWindow({ anidbId: 42,
    episodeIds: [1001], readActivity: async () => ({ state: 'quiet_observed',
      fingerprint: 'a'.repeat(64), unrelatedPendingKeys: [] }),
    readFeedState: read, readScopedFeedState: read,
    wait: async () => { snapshot.generation++; clock += 120_000; },
    now: () => clock, requireFingerprint: true })).state,
  'quiet_window_observed');
});

test('live feed state is healthy only for a connected, reconciled event consumer', () => {
  const event = { generation: 7, pending: 0, inFlight: null,
    reconciliationNeeded: false, fullReconciliationNeeded: false };
  const arrival = { state: 'unverified', pendingPaths: 0 };
  assert.deepEqual(importFeedState({ connection: { state: 'connected' },
    event, arrival }), { state: 'connected', generation: 7,
    pendingPaths: 0, pendingEvents: 0, inFlight: false,
    reconciliationNeeded: false });
  for (const changed of [
    { connection: { state: 'disconnected' } },
    { event: { ...event, fullReconciliationNeeded: true } },
    { event: { ...event, inFlight: 20 } },
    { arrival: { state: 'busy', pendingPaths: 1 } },
  ]) {
    const result = importFeedState({ connection: { state: 'connected' },
      event, arrival, ...changed });
    assert.notEqual(result.state, 'connected');
  }
});

function observers({ before = { state: 'connected', generation: 7, pendingPaths: 0,
  pendingEvents: 0, inFlight: false, reconciliationNeeded: false },
  after = before, activities = [{ state: 'quiet_observed' },
    { state: 'quiet_observed' }], elapsedMs = 120_000 } = {}) {
  let clock = 1_000_000;
  let activityIndex = 0;
  let feedIndex = 0;
  return { anidbId: 42, episodeIds: [1001], minQuietMs: 120_000,
    readActivity: async () => activities[activityIndex++],
    readFeedState: async () => [before, after][feedIndex++],
    wait: async () => { clock += elapsedMs; }, now: () => clock };
}

test('reports only an observed quiet window after two empty roots, idle queues and an uninterrupted feed', async () => {
  const result = await observeImportQuietWindow(observers());
  assert.deepEqual(result, { state: 'quiet_window_observed', anidbId: 42,
    episodeIds: [1001], beforeObservedAtMs: 1_000_000,
    afterObservedAtMs: 1_120_000, feedGeneration: 7 });
});

test('optional fence trace reports only bounded state, never Import paths', async () => {
  const observations = [];
  const secretPath = '1:private-release/episode.mkv';
  const result = await observeImportQuietWindow({ ...observers(),
    readScopedFeedState: async () => ({ state: 'pending_unverified',
      generation: 9, pendingPaths: 1, pendingEvents: 0,
      pendingKeys: [secretPath] }),
    trace: (observation) => observations.push(observation),
  });
  assert.deepEqual(result, { state: 'held',
    reason: 'import_quiet_window_unverified' });
  assert.deepEqual(observations, [{ phase: 'initial_feed',
    state: 'pending_unverified', generation: 9, pendingPaths: 1,
    pendingEvents: 0 }, { phase: 'before_activity',
    state: 'quiet_observed' }]);
  assert.equal(JSON.stringify(observations).includes(secretPath), false);
  observations.length = 0;
  await observeImportQuietWindow({ ...observers(),
    readScopedFeedState: async () => ({ state: secretPath }),
    trace: (observation) => observations.push(observation),
  });
  assert.deepEqual(observations, [{ phase: 'initial_feed', state: 'invalid' }]);
});

test('both Import observations receive the exact requested target', async () => {
  const scopes = [];
  const result = await observeImportQuietWindow({ ...observers(),
    readActivity: async (scope) => { scopes.push(scope);
      return { state: 'quiet_observed' }; },
  });
  assert.equal(result.state, 'quiet_window_observed');
  assert.deepEqual(scopes, [
    { anidbId: 42, episodeIds: [1001] },
    { anidbId: 42, episodeIds: [1001] },
  ]);
});

test('a changed feed, unresolved file, queue activity or short interval cannot report quiet', async () => {
  for (const input of [
    { after: { state: 'connected', generation: 8, pendingPaths: 0,
      pendingEvents: 0, inFlight: false, reconciliationNeeded: false } },
    { after: { state: 'disconnected', generation: 7, pendingPaths: 0,
      pendingEvents: 0, inFlight: false, reconciliationNeeded: false } },
    { before: { state: 'connected', generation: 7, pendingPaths: 1,
      pendingEvents: 0, inFlight: false, reconciliationNeeded: false } },
    { after: { state: 'connected', generation: 7, pendingPaths: 0,
      pendingEvents: 1, inFlight: false, reconciliationNeeded: false } },
    { activities: [{ state: 'quiet_observed' }, { state: 'busy' }] },
    { activities: [{ state: 'queue_idle_unverified' }, { state: 'quiet_observed' }] },
    { elapsedMs: 119_999 },
  ]) {
    const result = await observeImportQuietWindow(observers(input));
    assert.deepEqual(result, { state: 'held', reason: 'import_quiet_window_unverified' });
  }
});

test('observer errors and bad clock observations hold', async () => {
  const input = observers();
  assert.deepEqual(await observeImportQuietWindow({ ...input,
    readFeedState: async () => { throw new Error('disconnected'); } }),
  { state: 'held', reason: 'import_quiet_window_unverified' });
  assert.deepEqual(await observeImportQuietWindow({ ...observers(),
    now: () => NaN }),
  { state: 'held', reason: 'import_quiet_window_unverified' });
});

test('required Import fingerprint catches a changed folder during the quiet window', async () => {
  const fingerprint = 'a'.repeat(64);
  const before = { state: 'quiet_observed', fingerprint };
  const after = { state: 'quiet_observed', fingerprint: 'b'.repeat(64) };
  const held = { state: 'held', reason: 'import_quiet_window_unverified' };
  assert.deepEqual(await observeImportQuietWindow({
    ...observers({ activities: [before, after] }), requireFingerprint: true,
  }), held);
  assert.deepEqual(await observeImportQuietWindow({
    ...observers(), requireFingerprint: true,
  }), held);
  assert.deepEqual(await observeImportQuietWindow({
    ...observers({ activities: [before, before] }), requireFingerprint: true,
  }), { state: 'quiet_window_observed', anidbId: 42,
    episodeIds: [1001], beforeObservedAtMs: 1_000_000,
    afterObservedAtMs: 1_120_000, feedGeneration: 7 });
});

test('scoped window accepts only unchanged exact pending handoff paths', async () => {
  const key = '1:negev-7-0123456789abcdef/01.mkv';
  const fingerprint = 'a'.repeat(64);
  const activity = { state: 'quiet_observed', fingerprint,
    unrelatedPendingKeys: [key] };
  const connection = { state: 'connected' };
  const pending = { state: 'snapshot', generation: 7, pending: 0,
    inFlight: null, reconciliationNeeded: true,
    fullReconciliationNeeded: false, pendingOnlyDebt: true,
    pendingKeys: [key] };
  const run = (snapshots, activities = [activity, activity]) => {
    let index = 0;
    let activityIndex = 0;
    return observeImportQuietWindow({ ...observers(), requireFingerprint: true,
      readActivity: async () => activities[activityIndex++],
      readScopedFeedState: (keys) => scopedImportFeedState({ connection,
        snapshot: snapshots[index++], allowedPendingKeys: keys }),
    });
  };
  assert.deepEqual(await run([pending, pending, pending]), {
    state: 'quiet_window_observed', anidbId: 42, episodeIds: [1001],
    beforeObservedAtMs: 1_000_000, afterObservedAtMs: 1_120_000,
    feedGeneration: 7, unrelatedPendingKeys: [key] });
  const held = { state: 'held', reason: 'import_quiet_window_unverified' };
  assert.deepEqual(await run([pending, { ...pending, generation: 8 }]), held);
  assert.deepEqual(await run([pending, pending,
    { ...pending, pendingKeys: [key, '1:manual.mkv'] }]), held);
  assert.deepEqual(await run([pending, pending, pending], [activity,
    { ...activity, unrelatedPendingKeys: [] }]), held);
  assert.deepEqual(await run([{ ...pending, pendingOnlyDebt: false }]), held);
});
