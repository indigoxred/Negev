import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openShokoRecentLedger } from '../src/availability/shoko-recent-ledger.mjs';
import { bootstrapShokoRecentHead } from
  '../src/availability/shoko-recent-baseline.mjs';

const item = (fileId) => ({ fileId,
  importedNs: String(1_800_000_000_000_000_000n + BigInt(fileId)) });

async function withLedger(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-recent-baseline-'));
  const ledger = openShokoRecentLedger(path.join(dir, 'negev.sqlite'));
  try { await run(ledger); }
  finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
}

test('two stable bounded Shoko head reads save one immutable baseline', async () => {
  await withLedger(async (ledger) => {
    let reads = 0;
    const readPage = async ({ page, pageSize }) => {
      reads++;
      assert.equal(page, 1);
      assert.equal(pageSize, 100);
      return { state: 'page', page, total: 3,
        items: [item(13), item(12), item(11)] };
    };
    assert.deepEqual(await bootstrapShokoRecentHead({ ledger, readPage }),
      { state: 'baseline_saved', cursor: item(13) });
    assert.equal(reads, 2);
    assert.deepEqual(ledger.getCursor(), item(13));
    assert.deepEqual(ledger.getCapacity().pending, 3);
    assert.deepEqual(ledger.nextDue(0), { fileId: 11 });
    ledger.recordResult({ fileId: 11, success: true, nowMs: 0 });
    assert.deepEqual(ledger.nextDue(0), { fileId: 12 });
    assert.deepEqual(await bootstrapShokoRecentHead({ ledger, readPage }),
      { state: 'held', reason: 'recent_baseline_exists' });
    assert.equal(reads, 2);
  });
});

test('an arrival between head reads cannot establish a cursor', async () => {
  await withLedger(async (ledger) => {
    let reads = 0;
    const result = await bootstrapShokoRecentHead({ ledger,
      readPage: async () => ({ state: 'page', page: 1,
        total: ++reads === 1 ? 2 : 3,
        items: reads === 1 ? [item(12), item(11)] :
          [item(13), item(12), item(11)] }) });
    assert.deepEqual(result, { state: 'held', reason: 'recent_head_changed' });
    assert.equal(ledger.getCursor(), null);
  });
});

test('empty, malformed and unavailable heads leave the baseline unset', async () => {
  await withLedger(async (ledger) => {
    for (const readPage of [
      async () => ({ state: 'page', page: 1, total: 0, items: [] }),
      async () => ({ state: 'page', page: 1, total: 2,
        items: [item(11), item(12)] }),
      async () => { throw new Error('offline'); },
    ]) {
      assert.equal((await bootstrapShokoRecentHead({ ledger, readPage })).state,
        'held');
      assert.equal(ledger.getCursor(), null);
    }
  });
});

test('baseline capacity failure leaves both cursor and pending queue empty', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-recent-small-'));
  const ledger = openShokoRecentLedger(path.join(dir, 'negev.sqlite'),
    { maxPending: 2 });
  try {
    const result = await bootstrapShokoRecentHead({ ledger,
      readPage: async () => ({ state: 'page', page: 1, total: 3,
        items: [item(13), item(12), item(11)] }) });
    assert.deepEqual(result, { state: 'held', reason: 'recent_backlog_full' });
    assert.equal(ledger.getCursor(), null);
    assert.equal(ledger.getCapacity().pending, 0);
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});
