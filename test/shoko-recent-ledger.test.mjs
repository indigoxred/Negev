import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openShokoRecentLedger } from '../src/availability/shoko-recent-ledger.mjs';

const cursor = (fileId) => ({ fileId,
  importedNs: String(1_800_000_000_000_000_000n + BigInt(fileId)) });

async function withLedger(run, options) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-recent-ledger-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  let ledger;
  try {
    ledger = openShokoRecentLedger(dbPath, options);
    await run({ ledger, dbPath, reopen() {
      ledger.close();
      ledger = openShokoRecentLedger(dbPath, options);
      return ledger;
    } });
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
}

test('exact baseline is one-time and a batch survives restart with IDs oldest first', async () => {
  await withLedger(({ ledger, reopen }) => {
    assert.deepEqual(ledger.recordBatch({ state: 'complete', fileIds: [11],
      newest: cursor(11) }), { state: 'held', reason: 'recent_baseline_required' });
    assert.deepEqual(ledger.bootstrap(cursor(10)), { state: 'baseline_saved' });
    assert.deepEqual(ledger.bootstrap(cursor(9)), { state: 'held',
      reason: 'recent_baseline_exists' });
    assert.deepEqual(ledger.recordBatch({ state: 'complete', fileIds: [11, 12],
      newest: cursor(12) }), { state: 'recorded', added: 2 });
    ledger = reopen();
    assert.deepEqual(ledger.getCursor(), cursor(12));
    assert.deepEqual(ledger.nextDue(100), { fileId: 11 });
    assert.deepEqual(ledger.recordResult({ fileId: 11, success: true,
      nowMs: 100 }), { state: 'acknowledged' });
    assert.deepEqual(ledger.nextDue(100), { fileId: 12 });
  });
});

test('a failed file waits while a later file proceeds, then retries', async () => {
  await withLedger(({ ledger }) => {
    ledger.bootstrap(cursor(10));
    ledger.recordBatch({ state: 'complete', fileIds: [11, 12],
      newest: cursor(12) });
    assert.deepEqual(ledger.recordResult({ fileId: 11, success: false,
      nowMs: 100 }), { state: 'retry_scheduled' });
    assert.deepEqual(ledger.nextDue(100), { fileId: 12 });
    ledger.recordResult({ fileId: 12, success: true, nowMs: 100 });
    assert.deepEqual(ledger.nextDue(300_099), null);
    assert.deepEqual(ledger.nextDue(300_100), { fileId: 11 });
  });
});

test('queue capacity failure and database write failure preserve the old watermark', async () => {
  await withLedger(({ ledger }) => {
    ledger.bootstrap(cursor(10));
    assert.deepEqual(ledger.recordBatch({ state: 'complete', fileIds: [11, 12],
      newest: cursor(12) }), { state: 'held', reason: 'recent_backlog_full' });
    assert.deepEqual(ledger.getCursor(), cursor(10));
    assert.equal(ledger.nextDue(0), null);
  }, { maxPending: 1 });
  await withLedger(({ ledger, dbPath }) => {
    ledger.bootstrap(cursor(10));
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TRIGGER abort_recent BEFORE INSERT ON shoko_recent_pending
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
    db.close();
    assert.throws(() => ledger.recordBatch({ state: 'complete',
      fileIds: [11], newest: cursor(11) }));
    assert.deepEqual(ledger.getCursor(), cursor(10));
    assert.equal(ledger.nextDue(0), null);
  });
});

test('overlapping event and catch-up IDs deduplicate before advancing', async () => {
  await withLedger(({ ledger }) => {
    ledger.bootstrap(cursor(10));
    assert.deepEqual(ledger.recordBatch({ state: 'complete', fileIds: [11],
      newest: cursor(11) }), { state: 'recorded', added: 1 });
    assert.deepEqual(ledger.recordBatch({ state: 'complete', fileIds: [11, 12],
      newest: cursor(12) }), { state: 'recorded', added: 1 });
    assert.deepEqual(ledger.nextDue(0), { fileId: 11 });
    ledger.recordResult({ fileId: 11, success: true, nowMs: 0 });
    assert.deepEqual(ledger.nextDue(0), { fileId: 12 });
  });
});
