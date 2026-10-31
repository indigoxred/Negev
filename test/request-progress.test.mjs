import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { openRequestProgress } from '../src/requests/request-progress.mjs';

test('request progress distinguishes private proof from public availability', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-progress-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'series', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
      episodeIds: [1001, 1002] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  const progress = openRequestProgress(dbPath);
  try {
    assert.deepEqual(progress.read(saved.requestId), { state: 'saved',
      targetCount: 2, privateVerifiedTargets: 0, activeAttempts: 0,
      reviewRequired: false, publicAvailability: 'unverified' });
    const candidate = { indexerId: 7, guid: 'first' };
    const hash = 'a'.repeat(40);
    const claim = acquisitions.reserve({ requestId: saved.requestId, candidate,
      episodeIds: [1001], nowMs: 200 });
    acquisitions.bindPreparedTorrent({ attemptId: claim.attemptId, candidate,
      hash, nowMs: 201 });
    acquisitions.recordFilePlan({ attemptId: claim.attemptId, hash,
      plannedFiles: [{ name: '01.mkv', size: 10, episodeIds: [1001] }], nowMs: 202 });
    acquisitions.beginDispatch({ attemptId: claim.attemptId, nowMs: 203 });
    acquisitions.recordTorrent({ attemptId: claim.attemptId, hash, nowMs: 204 });
    acquisitions.beginStart({ attemptId: claim.attemptId, hash,
      manifestDigest: 'b'.repeat(64), nowMs: 205 });
    assert.deepEqual(progress.read(saved.requestId), { state: 'download_unverified',
      targetCount: 2, privateVerifiedTargets: 0, activeAttempts: 1,
      reviewRequired: false, publicAvailability: 'unverified' });
    const manifest = { anidbId: 42, torrentHash: hash,
      files: [{ name: '01.mkv', size: 10, ed2k: 'A'.repeat(32),
        anidbFileId: 51, episodeIds: [1001] }], subtitles: [] };
    handoffs.recordPrepared({ attemptId: claim.attemptId,
      prepared: { ...manifest, state: 'handoff_prepared', publishReady: false,
        holdingPath: path.join(root, 'holding'),
        evidenceDigest: evaluateHandoffEvidence(manifest).digest }, nowMs: 206 });
    assert.deepEqual(progress.read(saved.requestId), { state: 'partial_private_copy',
      targetCount: 2, privateVerifiedTargets: 1, activeAttempts: 1,
      reviewRequired: false, publicAvailability: 'unverified' });
    assert.equal(progress.read(999), null);
  } finally {
    progress.close(); handoffs.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
});
