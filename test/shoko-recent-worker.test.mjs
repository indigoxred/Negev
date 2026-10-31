import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openShokoRecentLedger } from '../src/availability/shoko-recent-ledger.mjs';
import { createShokoRecentWorker } from '../src/availability/shoko-recent-worker.mjs';

const cursor = (fileId) => ({ fileId,
  importedNs: String(1_800_000_000_000_000_000n + BigInt(fileId)) });

async function withLedger(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-recent-worker-'));
  const ledger = openShokoRecentLedger(path.join(dir, 'negev.sqlite'));
  try { await run(ledger); }
  finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
}

test('one bounded scan journals new IDs before moving the cursor', async () => {
  await withLedger(async (ledger) => {
    ledger.bootstrap(cursor(10));
    const pages = [];
    const worker = createShokoRecentWorker({ ledger, now: () => 100,
      readPage: async ({ page }) => {
        pages.push(page);
        return { state: 'page', page, total: 3,
          items: [cursor(13), cursor(12), cursor(11)] };
      },
      refreshFile: async () => ({ state: 'recorded_file' }) });
    assert.deepEqual(await worker.scan(), { state: 'caught_up', added: 3 });
    assert.deepEqual(pages, [1, 1]);
    assert.deepEqual(ledger.getCursor(), cursor(13));
    assert.deepEqual(ledger.nextDue(100), { fileId: 11 });
  });
});

test('failed targeted recheck waits while a later file is processed', async () => {
  await withLedger(async (ledger) => {
    ledger.bootstrap(cursor(10));
    ledger.recordBatch({ state: 'complete', fileIds: [11, 12],
      newest: cursor(12) });
    const seen = [];
    const worker = createShokoRecentWorker({ ledger, now: () => 100,
      readPage: async () => { throw new Error('scan not used'); },
      refreshFile: async (fileId) => {
        seen.push(fileId);
        return fileId === 11 ? { state: 'held' } : { state: 'recorded_file' };
      } });
    assert.deepEqual(await worker.drainOne(), { state: 'retry_scheduled', fileId: 11 });
    assert.deepEqual(await worker.drainOne(), { state: 'acknowledged', fileId: 12 });
    assert.deepEqual(seen, [11, 12]);
    assert.deepEqual(ledger.nextDue(100), null);
  });
});

test('a missing baseline and an active operation cannot start a second scan', async () => {
  await withLedger(async (ledger) => {
    let reads = 0;
    let release;
    const firstPage = new Promise((resolve) => { release = resolve; });
    const page = { state: 'page', page: 1, total: 1, items: [cursor(10)] };
    const worker = createShokoRecentWorker({ ledger, now: () => 100,
      readPage: () => ++reads === 1 ? firstPage : page,
      refreshFile: async () => ({ state: 'recorded_file' }) });
    assert.deepEqual(await worker.scan(), { state: 'held',
      reason: 'recent_baseline_required' });
    assert.equal(reads, 0);
    ledger.bootstrap(cursor(10));
    const running = worker.scan();
    assert.deepEqual(await worker.scan(), { state: 'held', reason: 'recent_worker_busy' });
    assert.equal(reads, 1);
    release(page);
    assert.equal((await running).state, 'caught_up');
  });
});
