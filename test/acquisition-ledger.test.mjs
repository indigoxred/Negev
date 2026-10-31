import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';

async function withLedger(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-attempts-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const first = requests.submit({ requesterId: 1, requestKey: 'first', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
      episodeIds: [1001, 1002] } });
  const second = requests.submit({ requesterId: 2, requestKey: 'second', nowMs: 101,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
      episodeIds: [1002, 1003] } });
  const third = requests.submit({ requesterId: 3, requestKey: 'third', nowMs: 102,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
      episodeIds: [1004] } });
  try { await run({ dbPath, firstId: first.requestId, secondId: second.requestId,
    thirdId: third.requestId }); }
  finally { requests.close(); await rm(dir, { recursive: true, force: true }); }
}

const candidate = { indexerId: 7, guid: 'synthetic-private-candidate-guid' };

test('reserves an exact request once and blocks overlapping targets but not other targets', async () =>
  withLedger(async ({ dbPath, firstId, secondId, thirdId }) => {
    const ledger = openAcquisitionLedger(dbPath);
    try {
      const first = ledger.reserve({ requestId: firstId, candidate, nowMs: 200 });
      assert.equal(first.state, 'reserved');
      assert.ok(Number.isSafeInteger(first.attemptId));
      assert.deepEqual(ledger.reserve({ requestId: firstId, candidate, nowMs: 201 }),
        { state: 'existing', attemptId: first.attemptId, status: 'reserved' });
      assert.deepEqual(ledger.reserve({ requestId: secondId, candidate, nowMs: 201 }),
        { state: 'held', reason: 'candidate_claimed' });
      assert.deepEqual(ledger.reserve({ requestId: secondId,
        candidate: { indexerId: 7, guid: 'other-release' }, nowMs: 202 }),
      { state: 'held', reason: 'target_busy' });
      assert.equal(ledger.reserve({ requestId: thirdId,
        candidate: { indexerId: 7, guid: 'later-episode' }, nowMs: 203 }).state, 'reserved');
      assert.deepEqual(ledger.getAttempt(first.attemptId), {
        id: first.attemptId, requestId: firstId, anidbId: 42,
        episodeIds: [1001, 1002], status: 'reserved', torrentHash: null,
      });
    } finally { ledger.close(); }
  }));

test('dispatch intent persists before network action and never auto-retries after restart', async () =>
  withLedger(async ({ dbPath, firstId }) => {
    const ledger = openAcquisitionLedger(dbPath);
    const reserved = ledger.reserve({ requestId: firstId, candidate, nowMs: 200 });
    assert.deepEqual(ledger.recordTorrent({ attemptId: reserved.attemptId,
      hash: 'a'.repeat(40), nowMs: 200 }), { state: 'held', reason: 'dispatch_not_recorded' });
    assert.deepEqual(ledger.beginDispatch({ attemptId: reserved.attemptId, nowMs: 201 }),
      { state: 'dispatch_unknown', sendNow: true });
    ledger.close();
    const restarted = openAcquisitionLedger(dbPath);
    try {
      assert.deepEqual(restarted.reserve({ requestId: firstId, candidate, nowMs: 202 }),
        { state: 'existing', attemptId: reserved.attemptId, status: 'dispatch_unknown' });
      assert.deepEqual(restarted.beginDispatch({ attemptId: reserved.attemptId, nowMs: 202 }),
        { state: 'dispatch_unknown', sendNow: false });
      const hash = 'a'.repeat(40);
      assert.deepEqual(restarted.recordTorrent({ attemptId: reserved.attemptId, hash, nowMs: 203 }),
        { state: 'torrent_observed' });
      assert.deepEqual(restarted.recordTorrent({ attemptId: reserved.attemptId, hash, nowMs: 204 }),
        { state: 'torrent_observed' });
      assert.deepEqual(restarted.recordTorrent({ attemptId: reserved.attemptId,
        hash: 'b'.repeat(40), nowMs: 205 }), { state: 'held', reason: 'torrent_conflict' });
    } finally { restarted.close(); }
  }));

test('two connections cannot reserve competing candidates for one target', async () =>
  withLedger(async ({ dbPath, firstId, secondId }) => {
    const one = openAcquisitionLedger(dbPath);
    const two = openAcquisitionLedger(dbPath);
    try {
      assert.equal(one.reserve({ requestId: firstId, candidate, nowMs: 200 }).state, 'reserved');
      assert.deepEqual(two.reserve({ requestId: secondId,
        candidate: { indexerId: 8, guid: 'competing' }, nowMs: 201 }),
      { state: 'held', reason: 'target_busy' });
    } finally { one.close(); two.close(); }
  }));

test('raw indexer GUID is not stored in the private SQLite database', async () =>
  withLedger(async ({ dbPath, firstId }) => {
    const ledger = openAcquisitionLedger(dbPath);
    ledger.reserve({ requestId: firstId, candidate, nowMs: 200 });
    ledger.close();
    assert.equal((await readFile(dbPath)).includes(Buffer.from(candidate.guid)), false);
  }));
