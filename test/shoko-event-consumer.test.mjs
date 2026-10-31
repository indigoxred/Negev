import test from 'node:test';
import assert from 'node:assert/strict';
import { createShokoEventConsumer } from '../src/availability/shoko-event-consumer.mjs';

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
  const consumer = createShokoEventConsumer({
    refreshFile: async (id) => { seen.push(id); return { state: 'recorded_file' }; },
    onDeleted: () => { throw new Error('queue unavailable'); },
  });
  assert.deepEqual(consumer.accept('file:deleted', [{ FileID: 12 }]),
    { state: 'queued', fileId: 12 });
  consumer.accept('file:hashed', [{ FileID: 13 }]);
  await consumer.close();
  assert.deepEqual(seen, [12, 13]);
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
