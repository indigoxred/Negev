import test from 'node:test';
import assert from 'node:assert/strict';
import { createShokoEventConsumer, forwardShokoEvent } from
  '../src/availability/shoko-event-consumer.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('a detected event has no file ID and asks for paced reconciliation', async () => {
  const calls = [];
  const consumer = createShokoEventConsumer({ refreshFile: async (id) => calls.push(id) });
  assert.deepEqual(consumer.accept('file:detected', [{ ManagedFolderID: 3, RelativePath: 'new.mkv' }]),
    { state: 'reconcile', reason: 'file_detected' });
  assert.equal(consumer.getState().reconciliationNeeded, true);
  assert.deepEqual(consumer.getPendingSnapshot(), {
    state: 'snapshot', generation: 1, pending: 0, inFlight: null,
    reconciliationNeeded: true, fullReconciliationNeeded: false,
    pendingOnlyDebt: true, pendingKeys: ['3:new.mkv'],
  });
  await consumer.close();
  assert.deepEqual(calls, []);
});

test('a resolved path or full reconciliation debt cannot be treated as pending-only', async () => {
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'recorded_file', recognition: 'provisional' }) });
  consumer.accept('file:detected', [{ ManagedFolderID: 3,
    RelativePath: 'one.mkv' }]);
  consumer.accept('file:detected', [{ ManagedFolderID: 3,
    RelativePath: 'two.mkv' }]);
  assert.equal(consumer.getPendingSnapshot().pendingOnlyDebt, true);
  consumer.accept('file:hashed', [{ ManagedFolderID: 3,
    RelativePath: 'one.mkv', FileID: 10 }]);
  await new Promise((resolve) => setImmediate(resolve));
  const token = consumer.snapshotPendingResolution(10);
  assert.deepEqual(consumer.acknowledgeLinkedObservation({ fileId: 10,
    token, result: { state: 'recorded_file', recognition: 'linked' } }),
  { state: 'resolved' });
  assert.equal(consumer.getPendingSnapshot().pendingOnlyDebt, false);
  consumer.flagReconciliation();
  assert.equal(consumer.getPendingSnapshot().fullReconciliationNeeded, true);
  await consumer.close();
});

test('a detected path stays busy until its hashed file refresh succeeds', async () => {
  const gate = deferred();
  const consumer = createShokoEventConsumer({
    refreshFile: async () => gate.promise,
  });
  const path = { ManagedFolderID: 3, RelativePath: 'new/01.mkv' };
  consumer.accept('file:detected', [path]);
  assert.deepEqual(consumer.getArrivalState(),
    { state: 'busy', pendingPaths: 1 });
  consumer.accept('file:hashed', [{ ...path, FileID: 10 }]);
  assert.deepEqual(consumer.getArrivalState(),
    { state: 'busy', pendingPaths: 1 });
  gate.resolve({ state: 'recorded_file', recognition: 'linked' });
  await consumer.close();
  assert.deepEqual(consumer.getArrivalState(),
    { state: 'unverified', pendingPaths: 0 });
});

test('a second detection during hash refresh remains pending', async () => {
  const gate = deferred();
  const consumer = createShokoEventConsumer({
    refreshFile: async () => gate.promise,
  });
  const path = { ManagedFolderID: 3, RelativePath: 'new/01.mkv' };
  consumer.accept('file:detected', [path]);
  consumer.accept('file:hashed', [{ ...path, FileID: 10 }]);
  consumer.accept('file:detected', [path]);
  gate.resolve({ state: 'recorded_file', recognition: 'linked' });
  await consumer.close();
  assert.deepEqual(consumer.getArrivalState(),
    { state: 'busy', pendingPaths: 1 });
});

test('failed hash refresh and malformed detection cannot declare imports quiet', async () => {
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'held', reason: 'file_unavailable' }) });
  const path = { ManagedFolderID: 3, RelativePath: 'new/01.mkv' };
  consumer.accept('file:detected', [path]);
  consumer.accept('file:hashed', [{ ...path, FileID: 10 }]);
  await consumer.close();
  assert.deepEqual(consumer.getArrivalState(),
    { state: 'busy', pendingPaths: 1 });
  const malformed = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'recorded_file' }) });
  malformed.accept('file:detected', [{ ManagedFolderID: 3,
    RelativePath: '../outside.mkv' }]);
  assert.deepEqual(malformed.getArrivalState(),
    { state: 'unverified', pendingPaths: 0 });
  await malformed.close();
});

test('a provisional hash stays busy until a synthetic later update links it', async () => {
  const observed = ['provisional', 'linked'];
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'recorded_file', recognition: observed.shift() }) });
  const path = { ManagedFolderID: 3, RelativePath: 'new/01.mkv' };
  consumer.accept('file:detected', [path]);
  consumer.accept('file:hashed', [{ ...path, FileID: 10 }]);
  // The installed Shoko file feed does not emit this update; its real path
  // uses a later exact file read, covered below.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(consumer.getArrivalState(),
    { state: 'busy', pendingPaths: 1 });
  consumer.accept('file:updated', [{ FileID: 10 }]);
  await consumer.close();
  assert.deepEqual(consumer.getArrivalState(),
    { state: 'unverified', pendingPaths: 0 });
});

test('a later exact file read resolves a provisional hash without a second event', async () => {
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'recorded_file', recognition: 'provisional' }) });
  const path = { ManagedFolderID: 3, RelativePath: 'new/01.mkv' };
  consumer.accept('file:detected', [path]);
  consumer.accept('file:hashed', [{ ...path, FileID: 10 }]);
  await new Promise((resolve) => setImmediate(resolve));
  const token = consumer.snapshotPendingResolution(10);
  assert.ok(token);
  assert.deepEqual(consumer.acknowledgeLinkedObservation({ fileId: 10, token,
    result: { state: 'recorded_file', recognition: 'linked' } }),
  { state: 'resolved' });
  assert.deepEqual(consumer.getArrivalState(),
    { state: 'unverified', pendingPaths: 0 });
  await consumer.close();
});

test('a stale file read cannot clear a newer detection or hash', async () => {
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'recorded_file', recognition: 'provisional' }) });
  const path = { ManagedFolderID: 3, RelativePath: 'new/01.mkv' };
  consumer.accept('file:detected', [path]);
  consumer.accept('file:hashed', [{ ...path, FileID: 10 }]);
  await new Promise((resolve) => setImmediate(resolve));
  const token = consumer.snapshotPendingResolution(10);
  consumer.accept('file:detected', [path]);
  assert.deepEqual(consumer.acknowledgeLinkedObservation({ fileId: 10, token,
    result: { state: 'recorded_file', recognition: 'linked' } }),
  { state: 'held' });
  consumer.accept('file:hashed', [{ ...path, FileID: 11 }]);
  assert.deepEqual(consumer.acknowledgeLinkedObservation({ fileId: 10, token,
    result: { state: 'recorded_file', recognition: 'linked' } }),
  { state: 'held' });
  assert.deepEqual(consumer.getArrivalState(),
    { state: 'busy', pendingPaths: 1 });
  await consumer.close();
});

test('an older file ID cannot clear a path now associated with a newer hash', async () => {
  const oldRead = deferred();
  const newRead = deferred();
  const consumer = createShokoEventConsumer({ refreshFile: (id) =>
    id === 10 ? oldRead.promise : newRead.promise });
  const path = { ManagedFolderID: 3, RelativePath: 'new/01.mkv' };
  consumer.accept('file:detected', [path]);
  consumer.accept('file:hashed', [{ ...path, FileID: 10 }]);
  consumer.accept('file:hashed', [{ ...path, FileID: 11 }]);
  oldRead.resolve({ state: 'recorded_file', recognition: 'linked' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(consumer.getArrivalState(),
    { state: 'busy', pendingPaths: 1 });
  newRead.resolve({ state: 'recorded_file', recognition: 'linked' });
  await consumer.close();
  assert.deepEqual(consumer.getArrivalState(),
    { state: 'unverified', pendingPaths: 0 });
});

test('hashed and relocated events coalesce by Shoko file ID and run serially', async () => {
  const gate = deferred();
  const calls = [];
  const consumer = createShokoEventConsumer({ refreshFile: async (id) => {
    calls.push(id);
    if (id === 10) await gate.promise;
    return { state: 'recorded_file' };
  } });
  assert.deepEqual(consumer.accept('file:hashed', [{ FileID: 10 }]),
    { state: 'queued', fileId: 10 });
  assert.deepEqual(consumer.accept('file:relocated', [{ FileID: 10 }]),
    { state: 'coalesced', fileId: 10 });
  assert.deepEqual(consumer.accept('file:hashed', [{ FileID: 11 }]),
    { state: 'queued', fileId: 11 });
  assert.deepEqual(calls, [10]);
  gate.resolve();
  await consumer.close();
  assert.deepEqual(calls, [10, 10, 11]);
  assert.equal(consumer.getState().reconciliationNeeded, false);
});

test('a deletion event cannot itself prove absence and a failed recheck stays held', async () => {
  const invalidated = [];
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'held', reason: 'file_unavailable' }),
  onDeleted: (fileId) => invalidated.push(fileId) });
  assert.deepEqual(consumer.accept('file:deleted', [{ FileID: 12 }]),
    { state: 'queued', fileId: 12 });
  assert.deepEqual(invalidated, [12]);
  await consumer.close();
  assert.equal(consumer.getState().reconciliationNeeded, true);
});

test('deletion invalidation failure requests reconciliation while later files proceed', async () => {
  const seen = [];
  const wakeups = [];
  const consumer = createShokoEventConsumer({
    refreshFile: async (id) => { seen.push(id); return { state: 'recorded_file' }; },
    onDeleted: () => { throw new Error('queue unavailable'); },
    onReconciliationNeeded: (fileId) => wakeups.push(fileId),
  });
  assert.deepEqual(consumer.accept('file:deleted', [{ FileID: 12 }]),
    { state: 'queued', fileId: 12 });
  consumer.accept('file:hashed', [{ FileID: 13 }]);
  await consumer.close();
  assert.deepEqual(seen, [12, 13]);
  assert.deepEqual(wakeups, [12]);
  assert.equal(consumer.getState().reconciliationNeeded, true);
});

test('an event burst is bounded and overflow requests reconciliation', async () => {
  const gate = deferred();
  const calls = [];
  const consumer = createShokoEventConsumer({ maxPending: 1,
    refreshFile: async (id) => { calls.push(id); if (id === 20) await gate.promise; } });
  consumer.accept('file:hashed', [{ FileID: 20 }]);
  consumer.accept('file:hashed', [{ FileID: 21 }]);
  assert.deepEqual(consumer.accept('file:hashed', [{ FileID: 22 }]),
    { state: 'reconcile', reason: 'event_overflow' });
  gate.resolve();
  await consumer.close();
  assert.deepEqual(calls, [20, 21]);
  assert.equal(consumer.getState().reconciliationNeeded, true);
});

test('malformed or unknown messages cannot trigger arbitrary Shoko reads', async () => {
  const calls = [];
  const consumer = createShokoEventConsumer({ refreshFile: async (id) => calls.push(id) });
  assert.deepEqual(consumer.accept('file:hashed', [{ FileID: '12' }]),
    { state: 'reconcile', reason: 'invalid_event' });
  assert.deepEqual(consumer.accept('other:hashed', [{ FileID: 12 }]),
    { state: 'ignored' });
  await consumer.close();
  assert.deepEqual(calls, []);
});

test('normal file events use targeted refresh without waking the full inventory scan', async () => {
  const refreshed = [];
  const wakeups = [];
  const consumer = createShokoEventConsumer({ refreshFile: async (id) => {
    refreshed.push(id);
    return { state: 'recorded_file' };
  } });
  const forward = (target, args) => forwardShokoEvent({
    consumer, requestReconciliation: () => wakeups.push(target), target, args,
  });
  assert.equal(forward('file:hashed', [{ FileID: 10 }]).state, 'queued');
  assert.equal(forward('file:relocated', [{ FileID: 11 }]).state, 'queued');
  assert.equal(forward('file:detected', [{ RelativePath: 'new.mkv' }]).state,
    'reconcile');
  assert.equal(forward('file:hashed', [{ FileID: 'bad' }]).state, 'reconcile');
  await consumer.close();
  assert.deepEqual(refreshed, [10, 11]);
  assert.deepEqual(wakeups, ['file:detected', 'file:hashed']);
});

test('only a new full-debt transition requests an event-driven inventory wake', async () => {
  const wakeups = [];
  const consumer = createShokoEventConsumer({ maxArrivals: 1,
    refreshFile: async () => ({ state: 'recorded_file' }) });
  const detected = (name) => forwardShokoEvent({ consumer,
    requestReconciliation: (result, fullDebtStarted) =>
      wakeups.push({ reason: result.reason, fullDebtStarted }),
    target: 'file:detected',
    args: [{ ManagedFolderID: 1, RelativePath: name }] });
  try {
    detected('first.mkv');
    detected('overflow.mkv');
    detected('another.mkv');
    assert.deepEqual(wakeups, [
      { reason: 'file_detected', fullDebtStarted: false },
      { reason: 'file_detected', fullDebtStarted: true },
      { reason: 'file_detected', fullDebtStarted: false },
    ]);
  } finally { await consumer.close(); }
});

test('failed targeted refresh reports whether it newly created full debt', async () => {
  const wakeups = [];
  const consumer = createShokoEventConsumer({
    refreshFile: async () => ({ state: 'held' }),
    onReconciliationNeeded: (fileId, fullDebtStarted) =>
      wakeups.push({ fileId, fullDebtStarted }),
  });
  try {
    consumer.accept('file:hashed', [{ FileID: 17 }]);
    await new Promise((resolve) => setImmediate(resolve));
    consumer.accept('file:hashed', [{ FileID: 18 }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(wakeups, [
      { fileId: 17, fullDebtStarted: true },
      { fileId: 18, fullDebtStarted: false },
    ]);
  } finally { await consumer.close(); }
});

test('failed targeted refresh wakes inventory after the asynchronous read finishes', async () => {
  const gate = deferred();
  const wakeups = [];
  const consumer = createShokoEventConsumer({
    refreshFile: () => gate.promise,
    onReconciliationNeeded: (fileId) => wakeups.push(fileId),
  });
  assert.equal(consumer.accept('file:hashed', [{ FileID: 17 }]).state, 'queued');
  assert.deepEqual(wakeups, []);
  gate.resolve({ state: 'held', reason: 'file_unavailable' });
  await consumer.close();
  assert.deepEqual(wakeups, [17]);
  assert.equal(consumer.getState().reconciliationNeeded, true);
});

test('a completed catch-up can clear only the same quiet event generation', async () => {
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'recorded_file', recognition: 'linked' }) });
  const path = { ManagedFolderID: 1, RelativePath: 'new.mkv' };
  consumer.accept('file:detected', [path]);
  const first = consumer.getState().generation;
  assert.equal(consumer.getState().reconciliationNeeded, true);
  consumer.accept('file:hashed', [{ ...path, FileID: 81 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(consumer.acknowledgeReconciliation(first),
    { state: 'held' });
  const current = consumer.getState().generation;
  assert.ok(current > first);
  assert.deepEqual(consumer.acknowledgeReconciliation(current),
    { state: 'acknowledged' });
  assert.equal(consumer.getState().reconciliationNeeded, false);
  await consumer.close();
});

test('a feed gap needs a full reconciliation at the same event generation', async () => {
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'recorded_file' }) });
  consumer.flagReconciliation('feed_disconnected');
  const generation = consumer.getState().generation;
  assert.deepEqual(consumer.acknowledgeReconciliation(generation),
    { state: 'held' });
  assert.deepEqual(consumer.acknowledgeFullReconciliation(generation),
    { state: 'acknowledged' });
  assert.equal(consumer.getState().reconciliationNeeded, false);
  consumer.accept('file:hashed', [{ FileID: 82 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(consumer.acknowledgeFullReconciliation(generation),
    { state: 'held' });
  await consumer.close();
});

test('a detected but unresolved path cannot be acknowledged as settled', async () => {
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'recorded_file' }) });
  consumer.accept('file:detected', [{ ManagedFolderID: 1,
    RelativePath: 'incoming.mkv' }]);
  assert.deepEqual(consumer.acknowledgeReconciliation(
    consumer.getState().generation), { state: 'held' });
  assert.equal(consumer.getState().reconciliationNeeded, true);
  await consumer.close();
});

test('an arrival beyond the path limit requires full reconciliation after tracked files resolve', async () => {
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'recorded_file', recognition: 'linked' }) });
  const arrival = (id) => ({ ManagedFolderID: 1,
    RelativePath: `incoming/${id}.mkv` });
  for (let id = 1; id <= 129; id++) {
    consumer.accept('file:detected', [arrival(id)]);
  }
  // Pace the hash events so the separate file-ID queue never overflows.
  for (let id = 1; id <= 128; id++) {
    consumer.accept('file:hashed', [{ ...arrival(id), FileID: id }]);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const state = consumer.getState();
  assert.equal(state.pending, 0);
  assert.equal(consumer.getArrivalState().pendingPaths, 0);
  assert.equal(state.fullReconciliationNeeded, true);
  assert.deepEqual(consumer.acknowledgeReconciliation(state.generation),
    { state: 'held' });
  assert.equal(consumer.getState().reconciliationNeeded, true);
  await consumer.close();
});
