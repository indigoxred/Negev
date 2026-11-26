import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionRequestQueue } from '../src/acquisition/acquisition-request-queue.mjs';
import { readWorkerDiagnostics } from '../src/admin/worker-diagnostics.mjs';

for (const kind of ['cancelled','suspended','closed_available','one_time_available','inflight','empty_targets','not_held','due','future','choice','scope']) {
  test(`acquisition diagnostics match reopened queue eligibility: ${kind}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'negev-diagnostic-eligibility-'));
    const dbPath = path.join(root, 'negev.sqlite');
    let queue, requests;
    try {
      requests = openRequestLedger(dbPath);
      const saved = requests.submit({ requesterId: 1, requestKey: 'case', nowMs: 1,
        intent: { state: 'ready', anidbId: 42, kind: 'series', episodeIds: [99],
          monitorFuture: kind === 'closed_available' } });
      queue = openAcquisitionRequestQueue(dbPath);
      const claim = queue.claimNext({ nowMs: 100 });
      if (kind !== 'inflight') queue.recordResult({ requestId: claim.requestId, pass: claim.pass,
        state: 'held', reason: kind.includes('available') ? 'request_fully_available' : 'no_safe_release', checkedMs: 100 });
      const due = queue.getResult(saved.requestId).nextDueMs;
      const nowMs = kind === 'future' || kind === 'choice' || kind === 'scope' ? 101 : (due ?? 100) + 1000;
      if (kind === 'cancelled') assert.equal(requests.cancelRequest({requesterId:1,requestId:saved.requestId,nowMs:101}).state,'cancelled');
      if (kind === 'suspended') assert.equal(queue.suspendUnstarted({requestId:saved.requestId,reason:'cutover_review',nowMs:101}).state,'suspended');
      const db = new DatabaseSync(dbPath);
      if (kind === 'closed_available') db.prepare('UPDATE requests SET watch_closed=1 WHERE id=?').run(saved.requestId);
      if (kind === 'empty_targets') db.prepare('DELETE FROM request_targets WHERE request_id=?').run(saved.requestId);
      if (kind === 'not_held') { db.exec('PRAGMA ignore_check_constraints=ON'); db.prepare("UPDATE requests SET status='historical' WHERE id=?").run(saved.requestId); }
      if (kind === 'choice') db.prepare('UPDATE requests SET release_control=? WHERE id=?').run(JSON.stringify({mode:'auto',phase:'consumed',selection:null,revision:2}),saved.requestId);
      if (kind === 'scope') db.prepare('UPDATE acquisition_request_checks SET scan_target_count=0 WHERE request_id=?').run(saved.requestId);
      db.close();
      requests.close(); requests = null;
      queue.close(); queue = openAcquisitionRequestQueue(dbPath);
      // Snapshot must leave the durable ledger unchanged, including in-flight claims.
      queue.close(); queue = null;
      const before = await readFile(dbPath);
      const result = await readWorkerDiagnostics({dataDir:root,nowMs});
      assert.deepEqual(await readFile(dbPath), before);
      const eligible = ['due','choice','scope'].includes(kind);
      assert.equal(result.stages.acquisition.dueRetries, Number(eligible));
      assert.equal(result.stages.acquisition.recorded, 1);
      const timestampDue = due !== null && due <= nowMs;
      assert.equal(result.stages.acquisition.recordedDueRetries, Number(timestampDue));
      assert.equal(result.stages.acquisition.retainedDueRetries, Number(timestampDue && !eligible));
      assert.equal(result.stages.acquisition.eligibility, 'persisted_queue_rules');
      assert.equal(result.stages.acquisition.unresolvedClaims, Number(kind === 'inflight'));
      assert.equal(result.stages.acquisition.oldestDueAgeMs, eligible ? (kind === 'due' ? 1000 : 0) : null);
      assert.equal(result.readiness, 'not_established');
      queue = openAcquisitionRequestQueue(dbPath);
      assert.equal(queue.claimNext({nowMs,priorityRequestId:saved.requestId}).state === 'claimed', eligible);
      if (kind === 'suspended') {
        assert.equal(queue.resumeSuspended({requestId:saved.requestId}).state,'resumed');
        queue.close(); queue = null;
        assert.equal((await readWorkerDiagnostics({dataDir:root,nowMs})).stages.acquisition.dueRetries,1);
        queue = openAcquisitionRequestQueue(dbPath);
        assert.equal(queue.claimNext({nowMs,priorityRequestId:saved.requestId}).requestId,saved.requestId);
      }
    } finally { queue?.close(); requests?.close(); await rm(root,{recursive:true,force:true}); }
  });
}
