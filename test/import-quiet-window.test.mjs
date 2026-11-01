import assert from 'node:assert/strict';
import test from 'node:test';
import { observeImportQuietWindow, importFeedState } from
  '../src/acquisition/import-quiet-window.mjs';

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
    afterObservedAtMs: 1_120_000 });
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
    afterObservedAtMs: 1_120_000 });
});
