import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
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
      const first = ledger.reserve({ requestId: firstId, candidate, episodeIds: [1001, 1002], nowMs: 200 });
      assert.equal(first.state, 'reserved');
      assert.ok(Number.isSafeInteger(first.attemptId));
      assert.deepEqual(ledger.reserve({ requestId: firstId, candidate, episodeIds: [1001, 1002], nowMs: 201 }),
        { state: 'existing', attemptId: first.attemptId, status: 'reserved' });
      assert.deepEqual(ledger.reserve({ requestId: secondId, candidate, episodeIds: [1002, 1003], nowMs: 201 }),
        { state: 'held', reason: 'candidate_claimed' });
      assert.deepEqual(ledger.reserve({ requestId: secondId, episodeIds: [1002, 1003],
        candidate: { indexerId: 7, guid: 'other-release' }, nowMs: 202 }),
      { state: 'held', reason: 'target_busy' });
      assert.equal(ledger.reserve({ requestId: thirdId, episodeIds: [1004],
        candidate: { indexerId: 7, guid: 'later-episode' }, nowMs: 203 }).state, 'reserved');
      assert.deepEqual(ledger.getAttempt(first.attemptId), {
        id: first.attemptId, requestId: firstId, anidbId: 42,
        episodeIds: [1001, 1002], status: 'reserved', expectedHash: null, torrentHash: null,
      });
    } finally { ledger.close(); }
  }));

test('a request can reserve two disjoint explicit subsets for separate releases', async () =>
  withLedger(async ({ dbPath, firstId }) => {
    const ledger = openAcquisitionLedger(dbPath);
    try {
      const first = ledger.reserve({ requestId: firstId, candidate,
        episodeIds: [1001], nowMs: 200 });
      assert.equal(first.state, 'reserved');
      const second = ledger.reserve({ requestId: firstId,
        candidate: { indexerId: 7, guid: 'episode-2' },
        episodeIds: [1002], nowMs: 201 });
      assert.equal(second.state, 'reserved');
      assert.deepEqual(ledger.getAttempt(first.attemptId).episodeIds, [1001]);
      assert.deepEqual(ledger.getAttempt(second.attemptId).episodeIds, [1002]);
      assert.deepEqual(ledger.reserve({ requestId: firstId, candidate,
        episodeIds: [1002], nowMs: 202 }),
      { state: 'held', reason: 'candidate_claimed' });
      assert.deepEqual(ledger.reserve({ requestId: firstId,
        candidate: { indexerId: 7, guid: 'outside-request' },
        episodeIds: [1003], nowMs: 202 }),
      { state: 'held', reason: 'target_not_requested' });
      assert.throws(() => ledger.reserve({ requestId: firstId,
        candidate: { indexerId: 7, guid: 'implicit' }, nowMs: 203 }), TypeError);
    } finally { ledger.close(); }
  }));

test('a large installment can reserve one exact episode without reading a 500-target ceiling', async () =>
  withLedger(async ({ dbPath }) => {
    const requests = openRequestLedger(dbPath);
    const ledger = openAcquisitionLedger(dbPath);
    try {
      const episodes = Array.from({ length: 501 }, (_, index) => 2000 + index);
      const saved = requests.submit({ requesterId: 4, requestKey: 'large', nowMs: 150,
        intent: { state: 'ready', anidbId: 84, kind: 'series',
          monitorFuture: false, episodeIds: episodes } });
      const claim = ledger.reserve({ requestId: saved.requestId,
        candidate: { indexerId: 7, guid: 'large-episode-2500' },
        episodeIds: [2500], nowMs: 200 });
      assert.equal(claim.state, 'reserved');
      assert.deepEqual(ledger.getAttempt(claim.attemptId).episodeIds, [2500]);
      assert.deepEqual(ledger.reserve({ requestId: saved.requestId,
        candidate: { indexerId: 7, guid: 'outside-large' },
        episodeIds: [2501], nowMs: 201 }),
      { state: 'held', reason: 'target_not_requested' });
    } finally { ledger.close(); requests.close(); }
  }));

test('only an unsent, unbound candidate can release its claim for another release', async () =>
  withLedger(async ({ dbPath, firstId }) => {
    const ledger = openAcquisitionLedger(dbPath);
    try {
      const first = ledger.reserve({ requestId: firstId, candidate,
        episodeIds: [1001], nowMs: 200 });
      assert.deepEqual(ledger.releaseReserved({ attemptId: first.attemptId, nowMs: 201 }),
        { state: 'released_pre_dispatch' });
      assert.deepEqual(ledger.releaseReserved({ attemptId: first.attemptId, nowMs: 202 }),
        { state: 'released_pre_dispatch' });
      const reopened = openAcquisitionLedger(dbPath);
      try {
        assert.equal(reopened.getAttempt(first.attemptId).status, 'released_pre_dispatch');
        assert.deepEqual(reopened.beginDispatch({ attemptId: first.attemptId, nowMs: 203 }),
          { state: 'held', reason: 'candidate_released' });
      } finally { reopened.close(); }
      assert.deepEqual(ledger.reserve({ requestId: firstId, candidate,
        episodeIds: [1001], nowMs: 203 }),
        { state: 'held', reason: 'candidate_released' });
      assert.deepEqual(ledger.bindPreparedTorrent({ attemptId: first.attemptId,
        candidate, hash: 'a'.repeat(40), nowMs: 203 }),
        { state: 'held', reason: 'candidate_released' });
      const second = ledger.reserve({ requestId: firstId,
        candidate: { indexerId: 7, guid: 'replacement' },
        episodeIds: [1001], nowMs: 204 });
      assert.equal(second.state, 'reserved');
      ledger.bindPreparedTorrent({ attemptId: second.attemptId,
        candidate: { indexerId: 7, guid: 'replacement' },
        hash: 'b'.repeat(40), nowMs: 205 });
      assert.deepEqual(ledger.releaseReserved({ attemptId: second.attemptId, nowMs: 206 }),
        { state: 'held', reason: 'candidate_bound_or_sent' });
    } finally { ledger.close(); }
  }));

test('a verified wrong-show candidate is durably rejected without freeing its live target', async () =>
  withLedger(async ({ dbPath, firstId, thirdId }) => {
    let ledger = openAcquisitionLedger(dbPath);
    const torrentHash = 'a'.repeat(40);
    const claim = ledger.reserve({ requestId: firstId, candidate,
      episodeIds: [1001], nowMs: 200 });
    ledger.bindPreparedTorrent({ attemptId: claim.attemptId, candidate,
      hash: torrentHash, nowMs: 201 });
    ledger.recordFilePlan({ attemptId: claim.attemptId, hash: torrentHash,
      plannedFiles: [{ name: '01.mkv', size: 1000, episodeIds: [1001] }], nowMs: 202 });
    ledger.beginDispatch({ attemptId: claim.attemptId, nowMs: 203 });
    ledger.recordTorrent({ attemptId: claim.attemptId, hash: torrentHash, nowMs: 204 });
    assert.deepEqual(ledger.recordTerminalRejection({ attemptId: claim.attemptId,
      hash: torrentHash, reason: 'file_wrong_identity', nowMs: 205 }),
    { state: 'held', reason: 'start_intent_missing' });
    ledger.beginStart({ attemptId: claim.attemptId, hash: torrentHash,
      manifestDigest: 'b'.repeat(64), nowMs: 205 });
    assert.deepEqual(ledger.recordTerminalRejection({ attemptId: claim.attemptId,
      hash: 'c'.repeat(40), reason: 'file_wrong_identity', nowMs: 206 }),
    { state: 'held', reason: 'torrent_conflict' });
    assert.deepEqual(ledger.recordTerminalRejection({ attemptId: claim.attemptId,
      hash: torrentHash, reason: 'file_wrong_identity', nowMs: 206 }),
    { state: 'rejected_held', reason: 'file_wrong_identity' });
    ledger.close();
    ledger = openAcquisitionLedger(dbPath);
    try {
      assert.equal(ledger.getAttempt(claim.attemptId).status, 'rejected_held');
      assert.equal(ledger.getAttempt(claim.attemptId).rejectionReason, 'file_wrong_identity');
      assert.deepEqual(ledger.recordTerminalRejection({ attemptId: claim.attemptId,
        hash: torrentHash, reason: 'file_wrong_identity', nowMs: 207 }),
      { state: 'rejected_held', reason: 'file_wrong_identity' });
      assert.deepEqual(ledger.reserve({ requestId: firstId, candidate,
        episodeIds: [1001], nowMs: 208 }),
      { state: 'held', reason: 'candidate_rejected' });
      assert.deepEqual(ledger.reserve({ requestId: firstId,
        candidate: { indexerId: 7, guid: 'replacement' },
        episodeIds: [1001], nowMs: 209 }),
      { state: 'held', reason: 'target_busy' });
      assert.equal(ledger.reserve({ requestId: thirdId,
        candidate: { indexerId: 7, guid: 'later-episode' },
        episodeIds: [1004], nowMs: 210 }).state, 'reserved');
    } finally { ledger.close(); }
  }));

test('dispatch intent persists before network action and never auto-retries after restart', async () =>
  withLedger(async ({ dbPath, firstId }) => {
    const ledger = openAcquisitionLedger(dbPath);
    const reserved = ledger.reserve({ requestId: firstId, candidate, episodeIds: [1001, 1002], nowMs: 200 });
    const hash = 'a'.repeat(40);
    assert.deepEqual(ledger.beginDispatch({ attemptId: reserved.attemptId, nowMs: 200 }),
      { state: 'held', reason: 'torrent_not_prepared' });
    assert.deepEqual(ledger.bindPreparedTorrent({ attemptId: reserved.attemptId,
      candidate, hash, nowMs: 200 }), { state: 'prepared', expectedHash: hash });
    assert.deepEqual(ledger.recordTorrent({ attemptId: reserved.attemptId,
      hash, nowMs: 200 }), { state: 'held', reason: 'dispatch_not_recorded' });
    assert.deepEqual(ledger.beginDispatch({ attemptId: reserved.attemptId, nowMs: 201 }),
      { state: 'dispatch_unknown', sendNow: true });
    ledger.close();
    const restarted = openAcquisitionLedger(dbPath);
    try {
      assert.deepEqual(restarted.reserve({ requestId: firstId, candidate, episodeIds: [1001, 1002], nowMs: 202 }),
        { state: 'existing', attemptId: reserved.attemptId, status: 'dispatch_unknown' });
      assert.deepEqual(restarted.beginDispatch({ attemptId: reserved.attemptId, nowMs: 202 }),
        { state: 'dispatch_unknown', sendNow: false });
      assert.deepEqual(restarted.recordTorrent({ attemptId: reserved.attemptId, hash, nowMs: 203 }),
        { state: 'torrent_observed' });
      assert.deepEqual(restarted.recordTorrent({ attemptId: reserved.attemptId, hash, nowMs: 204 }),
        { state: 'torrent_observed' });
      assert.deepEqual(restarted.recordTorrent({ attemptId: reserved.attemptId,
        hash: 'b'.repeat(40), nowMs: 205 }), { state: 'held', reason: 'torrent_conflict' });
    } finally { restarted.close(); }
  }));

test('prepared hash is bound durably to the exact reserved candidate', async () =>
  withLedger(async ({ dbPath, firstId }) => {
    const ledger = openAcquisitionLedger(dbPath);
    try {
      const reserved = ledger.reserve({ requestId: firstId, candidate, episodeIds: [1001, 1002], nowMs: 200 });
      const hash = 'a'.repeat(40);
      assert.deepEqual(ledger.bindPreparedTorrent({ attemptId: reserved.attemptId,
        candidate: { ...candidate, guid: 'other' }, hash, nowMs: 201 }),
      { state: 'held', reason: 'candidate_mismatch' });
      assert.deepEqual(ledger.bindPreparedTorrent({ attemptId: reserved.attemptId,
        candidate, hash, nowMs: 201 }), { state: 'prepared', expectedHash: hash });
      assert.deepEqual(ledger.bindPreparedTorrent({ attemptId: reserved.attemptId,
        candidate, hash: 'b'.repeat(40), nowMs: 202 }),
      { state: 'held', reason: 'torrent_conflict' });
      assert.deepEqual(ledger.recordTorrent({ attemptId: reserved.attemptId,
        hash: 'b'.repeat(40), nowMs: 202 }),
      { state: 'held', reason: 'torrent_conflict' });
      assert.equal(ledger.getAttempt(reserved.attemptId).expectedHash, hash);
    } finally { ledger.close(); }
  }));

test('the video-to-episode plan survives restart and cannot be reinterpreted', async () =>
  withLedger(async ({ dbPath, firstId }) => {
    let ledger = openAcquisitionLedger(dbPath);
    try {
      const reserved = ledger.reserve({ requestId: firstId, candidate,
        episodeIds: [1001, 1002], nowMs: 200 });
      const hash = 'a'.repeat(40);
      const plannedFiles = [
        { name: 'Show/01.mkv', size: 1000, episodeIds: [1001] },
        { name: 'Show/02.mkv', size: 1100, episodeIds: [1002] },
      ];
      assert.equal(ledger.bindPreparedTorrent({ attemptId: reserved.attemptId,
        candidate, hash, nowMs: 201 }).state, 'prepared');
      assert.deepEqual(ledger.recordFilePlan({ attemptId: reserved.attemptId,
        hash, plannedFiles, nowMs: 202 }), { state: 'planned' });
      ledger.close();
      ledger = null;
      const restarted = openAcquisitionLedger(dbPath);
      try {
        assert.deepEqual(restarted.getFilePlan(reserved.attemptId), plannedFiles);
        assert.deepEqual(restarted.recordFilePlan({ attemptId: reserved.attemptId,
          hash, plannedFiles: [{ ...plannedFiles[0], episodeIds: [1002] },
            { ...plannedFiles[1], episodeIds: [1001] }], nowMs: 203 }),
        { state: 'held', reason: 'file_plan_conflict' });
        assert.deepEqual(restarted.recordFilePlan({ attemptId: reserved.attemptId,
          hash, plannedFiles, nowMs: 203 }), { state: 'planned' });
      } finally { restarted.close(); }
    } finally { ledger?.close(); }
  }));

test('two disjoint requests cannot claim the same torrent hash', async () =>
  withLedger(async ({ dbPath, firstId, thirdId }) => {
    const one = openAcquisitionLedger(dbPath);
    const two = openAcquisitionLedger(dbPath);
    try {
      const first = one.reserve({ requestId: firstId, candidate, episodeIds: [1001, 1002], nowMs: 200 });
      const other = { indexerId: 8, guid: 'different-indexer-same-torrent' };
      const third = two.reserve({ requestId: thirdId, candidate: other, episodeIds: [1004], nowMs: 201 });
      assert.equal(third.state, 'reserved');
      assert.equal(one.bindPreparedTorrent({ attemptId: first.attemptId,
        candidate, hash: 'a'.repeat(40), nowMs: 202 }).state, 'prepared');
      assert.deepEqual(two.bindPreparedTorrent({ attemptId: third.attemptId,
        candidate: other, hash: 'a'.repeat(40), nowMs: 203 }),
      { state: 'held', reason: 'torrent_claimed' });
    } finally { one.close(); two.close(); }
  }));

test('two connections cannot reserve competing candidates for one target', async () =>
  withLedger(async ({ dbPath, firstId, secondId }) => {
    const one = openAcquisitionLedger(dbPath);
    const two = openAcquisitionLedger(dbPath);
    try {
      assert.equal(one.reserve({ requestId: firstId, candidate, episodeIds: [1001, 1002], nowMs: 200 }).state, 'reserved');
      assert.deepEqual(two.reserve({ requestId: secondId, episodeIds: [1002, 1003],
        candidate: { indexerId: 8, guid: 'competing' }, nowMs: 201 }),
      { state: 'held', reason: 'target_busy' });
    } finally { one.close(); two.close(); }
  }));

test('raw indexer GUID is not stored in the private SQLite database', async () =>
  withLedger(async ({ dbPath, firstId }) => {
    const ledger = openAcquisitionLedger(dbPath);
    ledger.reserve({ requestId: firstId, candidate, episodeIds: [1001, 1002], nowMs: 200 });
    ledger.close();
    assert.equal((await readFile(dbPath)).includes(Buffer.from(candidate.guid)), false);
  }));

test('an old uncertain attempt remains unsendable after the hash-column migration', async () =>
  withLedger(async ({ dbPath, firstId }) => {
    const old = new DatabaseSync(dbPath);
    old.exec(`CREATE TABLE acquisition_attempts (
      id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL, anidb_id INTEGER NOT NULL,
      indexer_id INTEGER NOT NULL, candidate_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reserved','dispatch_unknown','torrent_observed')),
      torrent_hash TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
      UNIQUE(indexer_id,candidate_digest)) STRICT`);
    const digest = (await import('node:crypto')).createHash('sha256').update(candidate.guid).digest('hex');
    old.prepare(`INSERT INTO acquisition_attempts
      (request_id,anidb_id,indexer_id,candidate_digest,status,created_ms,updated_ms)
      VALUES (?,?,?,?,'dispatch_unknown',200,201)`).run(firstId, 42, candidate.indexerId, digest);
    old.close();
    const ledger = openAcquisitionLedger(dbPath);
    try {
      assert.deepEqual(ledger.beginDispatch({ attemptId: 1, nowMs: 202 }),
        { state: 'dispatch_unknown', sendNow: false });
      assert.deepEqual(ledger.recordTorrent({ attemptId: 1, hash: 'a'.repeat(40), nowMs: 202 }),
        { state: 'held', reason: 'torrent_conflict' });
    } finally { ledger.close(); }
  }));

test('only an observed stopped torrent can receive one durable start intent', async () =>
  withLedger(async ({ dbPath, firstId }) => {
    const ledger = openAcquisitionLedger(dbPath);
    const attempt = ledger.reserve({ requestId: firstId, candidate, episodeIds: [1001, 1002], nowMs: 200 });
    const hash = 'a'.repeat(40);
    const manifestDigest = 'b'.repeat(64);
    try {
      assert.deepEqual(ledger.beginStart({ attemptId: attempt.attemptId, hash,
        manifestDigest, nowMs: 201 }), { state: 'held', reason: 'torrent_not_observed' });
      ledger.bindPreparedTorrent({ attemptId: attempt.attemptId, candidate, hash, nowMs: 201 });
      ledger.beginDispatch({ attemptId: attempt.attemptId, nowMs: 202 });
      ledger.recordTorrent({ attemptId: attempt.attemptId, hash, nowMs: 203 });
      assert.deepEqual(ledger.beginStart({ attemptId: attempt.attemptId, hash,
        manifestDigest, nowMs: 204 }), { state: 'start_unknown', sendNow: true });
      assert.deepEqual(ledger.getStart(attempt.attemptId), {
        status: 'start_unknown', torrentHash: hash, manifestDigest,
      });
      assert.deepEqual(ledger.beginStart({ attemptId: attempt.attemptId, hash,
        manifestDigest, nowMs: 205 }), { state: 'start_unknown', sendNow: false });
      const restarted = openAcquisitionLedger(dbPath);
      try {
        assert.deepEqual(restarted.getStart(attempt.attemptId), {
          status: 'start_unknown', torrentHash: hash, manifestDigest,
        });
        assert.deepEqual(restarted.beginStart({ attemptId: attempt.attemptId, hash,
          manifestDigest, nowMs: 205 }), { state: 'start_unknown', sendNow: false });
      } finally { restarted.close(); }
      assert.deepEqual(ledger.beginStart({ attemptId: attempt.attemptId, hash,
        manifestDigest: 'c'.repeat(64), nowMs: 206 }),
      { state: 'held', reason: 'start_manifest_conflict' });
      assert.deepEqual(ledger.beginStart({ attemptId: attempt.attemptId,
        hash: 'd'.repeat(40), manifestDigest, nowMs: 207 }),
      { state: 'held', reason: 'torrent_conflict' });
    } finally { ledger.close(); }
  }));
