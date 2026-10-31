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
  await consumer.close();
  assert.deepEqual(calls, []);
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
  gate.resolve({ state: 'recorded_file' });
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
  gate.resolve({ state: 'recorded_file' });
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
