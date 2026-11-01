import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openFileBackfillCursor } from
  '../src/availability/file-backfill-cursor.mjs';

test('file backfill retries a pending claim after restart and wraps after a complete pass', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-backfill-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const inventory = { listFileHintIds: ({ afterFileId, limit }) =>
    [2, 5, 9].filter((id) => id > afterFileId).slice(0, limit) };
  let cursor = openFileBackfillCursor(dbPath);
  try {
    const first = cursor.claim({ inventory, nowMs: 100, limit: 2 });
    assert.equal(first.state, 'claimed');
    assert.deepEqual(first.fileIds, [2, 5]);
    cursor.close();
    cursor = openFileBackfillCursor(dbPath);
    assert.deepEqual(cursor.claim({ inventory, nowMs: 200, limit: 2 }), first);
    assert.deepEqual(cursor.record({ claim: first,
      outcomes: [{ fileId: 2, state: 'unknown' },
        { fileId: 5, state: 'available' }], nowMs: 210 }),
    { state: 'recorded', count: 2 });
    const second = cursor.claim({ inventory, nowMs: 220, limit: 2 });
    assert.deepEqual(second.fileIds, [9]);
    assert.deepEqual(cursor.record({ claim: second,
      outcomes: [{ fileId: 9, state: 'held' }], nowMs: 230 }),
    { state: 'recorded', count: 1 });
    const wrapped = cursor.claim({ inventory, nowMs: 240, limit: 2 });
    assert.equal(wrapped.pass, first.pass + 1);
    assert.deepEqual(wrapped.fileIds, [2, 5]);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('stale or malformed receipts cannot advance the file cursor', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-backfill-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const inventory = { listFileHintIds: ({ afterFileId }) =>
    [7, 8].filter((id) => id > afterFileId) };
  const cursor = openFileBackfillCursor(dbPath);
  try {
    const claim = cursor.claim({ inventory, nowMs: 100, limit: 2 });
    assert.equal(cursor.record({ claim: { ...claim, receipt: claim.receipt + 1 },
      outcomes: [{ fileId: 7, state: 'unknown' },
        { fileId: 8, state: 'unknown' }], nowMs: 101 }).state, 'held');
    assert.equal(cursor.record({ claim, outcomes: [{ fileId: 8,
      state: 'available' }], nowMs: 102 }).state, 'held');
    assert.deepEqual(cursor.claim({ inventory, nowMs: 103, limit: 2 }), claim);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an invalid inventory page holds without advancing or persisting a claim', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-backfill-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const cursor = openFileBackfillCursor(dbPath);
  try {
    const invalid = { listFileHintIds: () => [8, 7] };
    assert.deepEqual(cursor.claim({ inventory: invalid, nowMs: 100,
      limit: 2 }), { state: 'held', reason: 'invalid_file_hint_page' });
    const valid = { listFileHintIds: () => [7, 8] };
    const claim = cursor.claim({ inventory: valid, nowMs: 101, limit: 2 });
    assert.equal(claim.receipt, 1);
    assert.deepEqual(claim.fileIds, [7, 8]);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});
