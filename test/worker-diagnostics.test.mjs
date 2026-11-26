import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionRequestQueue } from '../src/acquisition/acquisition-request-queue.mjs';

test('operator diagnostics read one consistent snapshot without exposing paths, hashes or free-text reasons', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-worker-diagnostic-'));
  const dbPath = path.join(root, 'negev.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE acquisition_request_checks(request_id INTEGER, state TEXT, reason TEXT, checked_ms INTEGER, next_due_ms INTEGER);
    INSERT INTO acquisition_request_checks VALUES(1,NULL,NULL,NULL,NULL),(2,'held','provider_unavailable',100,200),
    (3,'held','/secret/path?token=private',100,500),(4,'stopped_observed',NULL,300,NULL);
    CREATE TABLE plex_card_cursors(library_id INTEGER,kind TEXT,offset INTEGER);
    INSERT INTO plex_card_cursors VALUES(1,'episode',100);
    CREATE TABLE shoko_recent_pending(seq INTEGER,file_id INTEGER,retry_after_ms INTEGER);
    INSERT INTO shoko_recent_pending VALUES(1,123,200);`);
  db.close();
  try {
    const { readWorkerDiagnostics } = await import('../src/admin/worker-diagnostics.mjs');
    const result = await readWorkerDiagnostics({ dataDir: root, nowMs: 400 });
    assert.equal(result.state, 'worker_snapshot');
    assert.equal(result.stages.acquisition.unresolvedClaims, 1);
    assert.equal(result.stages.acquisition.dueRetries, null);
    assert.equal(result.stages.acquisition.recordedDueRetries, 1);
    assert.equal(result.stages.acquisition.eligibility, 'not_established');
    assert.equal(result.stages.acquisition.lastSuccessfulMs, 300);
    assert.equal(result.stages.acquisition.oldestDueAgeMs, null);
    assert.equal(result.stages.acquisition.recordedOldestDueAgeMs, 200);
    assert.equal(result.recent.pending, 1);
    assert.equal(result.recent.due, 1);
    assert.deepEqual(result.plex.cursors, [{ kind: 'episode', offset: 100 }]);
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.ok(!JSON.stringify(result).includes('private'));
    assert.equal(result.stages.start.state, 'not_initialized');
    assert.equal(result.readiness, 'not_established');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('diagnostics preserve real durable queue state and report an overdue retry after reopen', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-real-diagnostic-'));
  const dbPath = path.join(root, 'negev.sqlite');
  try {
    const requests = openRequestLedger(dbPath);
    requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 1,
      intent: { state: 'ready', anidbId: 42, kind: 'series', episodeIds: [99], monitorFuture: false } });
    requests.close();
    let queue = openAcquisitionRequestQueue(dbPath);
    const claim = queue.claimNext({ nowMs: 100 });
    queue.recordResult({ requestId: claim.requestId, pass: claim.pass, state: 'held', reason: 'no_safe_release', checkedMs: 100 });
    const before = queue.getResult(claim.requestId);
    queue.close();
    const { readWorkerDiagnostics } = await import('../src/admin/worker-diagnostics.mjs');
    const snapshot = await readWorkerDiagnostics({ dataDir: root, nowMs: before.nextDueMs + 10 });
    assert.equal(snapshot.stages.acquisition.dueRetries, 1);
    assert.equal(snapshot.stages.acquisition.oldestDueAgeMs, 10);
    assert.equal(snapshot.stages.acquisition.lastSuccessfulMs, null);
    queue = openAcquisitionRequestQueue(dbPath);
    try { assert.deepEqual(queue.getResult(claim.requestId), before); }
    finally { queue.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
