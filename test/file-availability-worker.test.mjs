import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDirectAvailabilityQueue, createFileAvailabilityWorker } from
  '../src/availability/direct-availability-queue.mjs';
import { openShokoInventoryLedger } from
  '../src/availability/shoko-inventory-worker.mjs';

test('one Shoko file read checks several exact episode receipts without swallowing another target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-file-availability-'));
  const queue = openDirectAvailabilityQueue(path.join(root, 'state.sqlite'));
  try {
    const pairs = [1001, 1002, 1003, 1004, 1005].map((episodeId) =>
      ({ anidbId: 42, episodeId }));
    for (const pair of pairs) queue.enqueue({ ...pair, observedMs: 100 });
    let reads = 0;
    const observed = [];
    const recordedProofs = [];
    let sharedBudget;
    const worker = createFileAvailabilityWorker({ queue,
      onRecordedAvailable: (proof) => recordedProofs.push(proof.fileId),
      inventory: {
        getObservedFileIds: () => [51],
        getFile: () => ({ fileId: 51, state: 'linked', pairs }),
      },
      resolveKind: async () => 'series',
      readCandidate: async () => { reads++; return { state: 'candidate',
        fileId: 51, pairs }; },
      observeCandidate: async ({ target, budget }) => {
        if (sharedBudget) assert.equal(budget, sharedBudget);
        else sharedBudget = budget;
        assert.equal(budget.cardReads, observed.length);
        budget.cardReads++;
        observed.push(target.episodeId);
        return { state: 'available', proof: { fileId: 51, libraryId: 102,
          ratingKey: target.episodeId, partId: 900 } }; },
      observeFallback: async () => { throw Error('batch path expected'); },
      now: () => 101 });
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      target: pairs[0], result: 'available', batchSize: 4,
      load: { cardReads: 4, physicalProbes: 0 } });
    assert.equal(reads, 1);
    assert.equal(sharedBudget.cardReads, 4);
    assert.deepEqual(observed, [1001, 1002, 1003, 1004]);
    assert.deepEqual(recordedProofs, [51, 51, 51, 51]);
    assert.equal(queue.getStatus({ ...pairs[3], nowMs: 101 }).state,
      'available');
    assert.equal(queue.getStatus({ ...pairs[4], nowMs: 101 }).state,
      'unknown');
  } finally { queue.close(); await rm(root, { recursive: true, force: true }); }
});

test('a changed file candidate cannot publish its old linked episodes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-file-remap-'));
  const queue = openDirectAvailabilityQueue(path.join(root, 'state.sqlite'));
  try {
    const pairs = [{ anidbId: 42, episodeId: 1001 },
      { anidbId: 42, episodeId: 1002 }];
    for (const pair of pairs) queue.enqueue({ ...pair, observedMs: 100 });
    let cardReads = 0;
    const worker = createFileAvailabilityWorker({ queue,
      inventory: { getObservedFileIds: () => [51],
        getFile: () => ({ fileId: 51, state: 'linked', pairs }) },
      resolveKind: async () => 'series',
      readCandidate: async () => ({ state: 'candidate', fileId: 51,
        pairs: [{ anidbId: 42, episodeId: 2001 }] }),
      observeCandidate: async () => { cardReads++; return { state: 'available' }; },
      observeFallback: async () => { throw Error('batch path expected'); },
      now: () => 101 });
    assert.equal((await worker.runOnce()).result, 'unknown');
    assert.equal(cardReads, 0);
    for (const pair of pairs) assert.equal(queue.getStatus({ ...pair,
      nowMs: 101 }).state, 'unknown');
  } finally { queue.close(); await rm(root, { recursive: true, force: true }); }
});

test('a Shoko unlink during the card read rejects every in-flight batch proof', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-file-race-'));
  const dbPath = path.join(root, 'state.sqlite');
  const inventory = openShokoInventoryLedger(dbPath);
  const queue = openDirectAvailabilityQueue(dbPath);
  try {
    const pairs = [{ anidbId: 42, episodeId: 1001 },
      { anidbId: 42, episodeId: 1002 }];
    const linked = { fileId: 51, updated: '2026-11-02T00:00:00Z',
      state: 'linked', pairs };
    inventory.recordFileObservation({ item: linked, observedMs: 90 });
    for (const pair of pairs) queue.enqueue({ ...pair, observedMs: 100 });
    let reads = 0;
    const worker = createFileAvailabilityWorker({ queue, inventory,
      resolveKind: async () => 'series',
      readCandidate: async () => ({ state: 'candidate', fileId: 51, pairs }),
      observeCandidate: async ({ target }) => {
        if (++reads === 1) inventory.recordFileObservation({
          item: { ...linked, updated: '2026-11-02T00:01:00Z',
            state: 'unverified', pairs: [] }, observedMs: 101 });
        return { state: 'available', proof: { fileId: 51, libraryId: 102,
          ratingKey: target.episodeId, partId: 900 } };
      },
      observeFallback: async () => { throw Error('batch path expected'); },
      now: () => 101 });
    assert.deepEqual(await worker.runOnce(),
      { state: 'held', reason: 'shoko_changed' });
    assert.equal(reads, 2);
    for (const pair of pairs) assert.equal(queue.getStatus({ ...pair,
      nowMs: 101 }).state, 'unknown');
  } finally { inventory.close(); queue.close();
    await rm(root, { recursive: true, force: true }); }
});

test('a failed episode card does not prevent the next episode from being checked', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-file-next-'));
  const queue = openDirectAvailabilityQueue(path.join(root, 'state.sqlite'));
  try {
    const pairs = [{ anidbId: 42, episodeId: 1001 },
      { anidbId: 42, episodeId: 1002 }];
    for (const pair of pairs) queue.enqueue({ ...pair, observedMs: 100 });
    const worker = createFileAvailabilityWorker({ queue,
      inventory: { getObservedFileIds: () => [51],
        getFile: () => ({ fileId: 51, state: 'linked', pairs }) },
      resolveKind: async () => 'series',
      readCandidate: async () => ({ state: 'candidate', fileId: 51, pairs }),
      observeCandidate: async ({ target }) => {
        if (target.episodeId === 1001) throw Error('first Plex card unavailable');
        return { state: 'available', proof: { fileId: 51, libraryId: 102,
          ratingKey: 500, partId: 900 } };
      },
      observeFallback: async () => { throw Error('batch path expected'); },
      now: () => 101 });
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      target: pairs[0], result: 'unknown', batchSize: 2,
      load: { cardReads: 0, physicalProbes: 0 } });
    assert.equal(queue.getStatus({ ...pairs[0], nowMs: 101 }).state,
      'unknown');
    assert.equal(queue.getStatus({ ...pairs[1], nowMs: 101 }).state,
      'available');
  } finally { queue.close(); await rm(root, { recursive: true, force: true }); }
});

test('a busy Shoko file read releases every claimed episode for immediate retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-file-busy-'));
  const queue = openDirectAvailabilityQueue(path.join(root, 'state.sqlite'));
  try {
    const pairs = [{ anidbId: 42, episodeId: 1001 },
      { anidbId: 42, episodeId: 1002 }];
    for (const pair of pairs) queue.enqueue({ ...pair, observedMs: 100 });
    let busy = true;
    const worker = createFileAvailabilityWorker({ queue,
      inventory: { getObservedFileIds: () => [51],
        getFile: () => ({ fileId: 51, state: 'linked', pairs }) },
      resolveKind: async () => 'series',
      readCandidate: async () => busy ? { state: 'busy' } :
        { state: 'candidate', fileId: 51, pairs },
      observeCandidate: async () => ({ state: 'unknown' }),
      observeFallback: async () => { throw Error('batch path expected'); },
      now: () => 101 });
    assert.deepEqual(await worker.runOnce(),
      { state: 'held', reason: 'metadata_busy' });
    busy = false;
    const retried = await worker.runOnce();
    assert.deepEqual(retried, { state: 'checked', target: pairs[0],
      result: 'unknown', batchSize: 2,
      load: { cardReads: 0, physicalProbes: 0 } });
  } finally { queue.close(); await rm(root, { recursive: true, force: true }); }
});

test('a busy Plex metadata slot retries its episode without delaying a sibling', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-file-card-busy-'));
  const queue = openDirectAvailabilityQueue(path.join(root, 'state.sqlite'));
  try {
    const pairs = [{ anidbId: 42, episodeId: 1001 },
      { anidbId: 42, episodeId: 1002 }];
    for (const pair of pairs) queue.enqueue({ ...pair, observedMs: 100 });
    let busy = true;
    let siblingChecks = 0;
    const worker = createFileAvailabilityWorker({ queue,
      inventory: { getObservedFileIds: () => [51],
        getFile: () => ({ fileId: 51, state: 'linked', pairs }) },
      resolveKind: async () => 'series',
      readCandidate: async () => ({ state: 'candidate', fileId: 51, pairs }),
      observeCandidate: async ({ target }) => {
        if (target.episodeId === 1002) siblingChecks++;
        return busy && target.episodeId === 1001
          ? { state: 'busy' } : { state: 'unknown' };
      },
      observeFallback: async () => { throw Error('batch path expected'); },
      now: () => 101 });
    assert.deepEqual(await worker.runOnce(),
      { state: 'held', reason: 'metadata_busy' });
    assert.equal(siblingChecks, 1);
    busy = false;
    assert.equal((await worker.runOnce()).result, 'unknown');
  } finally { queue.close(); await rm(root, { recursive: true, force: true }); }
});
