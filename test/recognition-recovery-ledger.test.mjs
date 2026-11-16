import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openPureMoveLedger } from '../src/acquisition/pure-move-ledger.mjs';
import { openRecognitionRecoveryLedger } from
  '../src/acquisition/recognition-recovery-ledger.mjs';

test('a published unrecognized file releases one claim only after durable preservation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-recognition-'));
  const dbPath = path.join(root, 'state.sqlite');
  const hash = 'a'.repeat(40);
  let recovery, acquisition;
  try {
    const requests = openRequestLedger(dbPath);
    const submitted = requests.submit({ requesterId: 1, requestKey: 'one',
      nowMs: 100, intent: { state: 'ready', anidbId: 42,
        kind: 'series', monitorFuture: false, episodeIds: [1001] } });
    requests.close();
    acquisition = openAcquisitionLedger(dbPath);
    const candidate = { indexerId: 7, guid: 'first' };
    const { attemptId } = acquisition.reserve({ requestId: submitted.requestId,
      candidate, episodeIds: [1001], evidencePolicy: 'first_time_permissive',
      nowMs: 200 });
    acquisition.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 201 });
    acquisition.recordFilePlan({ attemptId, hash, plannedFiles: [
      { name: '01.mkv', size: 1000, episodeIds: [1001] }], nowMs: 202 });
    acquisition.beginDispatch({ attemptId, nowMs: 203 });
    acquisition.recordTorrent({ attemptId, hash, nowMs: 204 });
    acquisition.beginStart({ attemptId, hash,
      manifestDigest: 'c'.repeat(64), nowMs: 205 });
    const moves = openPureMoveLedger(dbPath);
    moves.recordIntent({ attemptId, torrentHash: hash,
      stagingRoot: path.join(root, 'staging', hash),
      holdingPath: path.join(root, 'holding',
        `negev-${attemptId}-${hash.slice(0, 16)}`),
      files: [{ name: '01.mkv', size: 1000, episodeIds: [1001],
        dev: '1', ino: '2', mtimeNs: '3' }], nowMs: 206 });
    moves.markPrepared({ attemptId, nowMs: 207 });
    moves.beginPublish({ attemptId, nowMs: 208 });
    moves.markPublished({ attemptId, nowMs: 209 });
    moves.close();
    recovery = openRecognitionRecoveryLedger(dbPath);
    assert.equal(recovery.getPendingForRequest(submitted.requestId).attemptId,
      attemptId);
    assert.equal(recovery.recordFirstSeen({ attemptId, fileId: 81,
      nowMs: 600_000 }).state, 'observed');
    assert.equal(recovery.beginPreserve({ attemptId, fileId: 81,
      nowMs: 660_000 }).state, 'preserve_unknown');
    assert.equal(acquisition.reserve({ requestId: submitted.requestId,
      candidate: { indexerId: 7, guid: 'second' }, episodeIds: [1001],
      evidencePolicy: 'first_time_permissive',
      nowMs: 660_001 }).state, 'held');
    recovery.close();
    recovery = openRecognitionRecoveryLedger(dbPath);
    assert.equal(recovery.get(attemptId).status, 'preserve_unknown');
    assert.equal(recovery.markPreserved({ attemptId, nowMs: 660_002 }).state,
      'preserved');
    assert.equal(recovery.releaseForAlternate({ attemptId, nowMs: 660_003 }).state,
      'released');
    assert.equal(recovery.releaseForAlternate({ attemptId, nowMs: 660_004 }).state,
      'released');
    const alternate = acquisition.reserve({ requestId: submitted.requestId,
      candidate: { indexerId: 7, guid: 'second' }, episodeIds: [1001],
      evidencePolicy: 'first_time_permissive',
      nowMs: 660_005 });
    assert.equal(alternate.state, 'reserved');
    const fixture = new DatabaseSync(dbPath);
    fixture.prepare('UPDATE acquisition_target_claims SET active=0 WHERE attempt_id=?')
      .run(alternate.attemptId);
    fixture.close();
    assert.deepEqual(acquisition.reserve({ requestId: submitted.requestId,
      candidate: { indexerId: 7, guid: 'third' }, episodeIds: [1001],
      evidencePolicy: 'first_time_permissive',
      nowMs: 660_006 }), { state: 'held',
      reason: 'replacement_attempt_exhausted' });
  } finally {
    recovery?.close(); acquisition?.close();
    await rm(root, { recursive: true, force: true });
  }
});
