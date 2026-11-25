import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionRequestQueue } from '../src/acquisition/acquisition-request-queue.mjs';
import { openCandidateCheckCache } from '../src/acquisition/candidate-check-cache.mjs';
import { openQualityInspectionRetry } from '../src/acquisition/quality-inspection-retry.mjs';

for (const revisionColumn of [false, true]) test(`v319 verification upgrade wakes evidence once with revision column ${revisionColumn}`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-verification-upgrade-')), dbPath = path.join(dir, 'state.sqlite');
  let ledger = openRequestLedger(dbPath), queue = openAcquisitionRequestQueue(dbPath);
  const retry = openQualityInspectionRetry(dbPath), cache = openCandidateCheckCache(dbPath, { now: () => 1000 });
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const cursor = (policy, ids) => `${digest([policy, ...ids])}:${digest([7, 'candidate'])}|`;
  const cases = ['memo', 'quality-policy-v8', 'quality-policy-season-pack-v6', 'quality-policy-episode-fallback-v6',
    'quality-policy-uncertain-pack-v6', 'already_due', 'null_due', 'empty', 'wrong_anime', 'wrong_target', 'fresh_memo',
    'current_revision', 'group_wait', 'cancelled', 'closed', 'inflight', 'current_cursor', 'wrong_scope', 'malformed'];
  const ids = new Map();
  let db;
  try {
    for (let i = 0; i < cases.length; i++) {
      const name = cases[i], anidbId = 100 + i, episodeId = 1001 + i;
      ids.set(name, ledger.submit({ requesterId: 1, requestKey: name, nowMs: 1000,
        intent: { state: 'ready', anidbId, kind: 'series', title: 'Example', episodeIds: [episodeId], monitorFuture: true } }).requestId);
    }
    const chosen = ids.get('memo'), candidate = { indexerId: 7, guid: 'private-example', title: 'Example - 01', size: 1000 };
    const preview = { torrentHash: 'a'.repeat(40), episodeIds: [1001], files: [{ name: 'Example - 01.mkv', size: 1000, episodeIds: [1001] }] };
    ledger.updateReleaseControl(chosen, 0, { mode: 'manual', phase: 'chosen', selection: { candidate, preview } }, 1000);
    ledger.updateReleasePreference(chosen, 1, { group: 'Preferred', audio: 'japanese', createdMs: 1000, knownEpisodeIds: [] }, 1000);
    ledger.checkPreferredRelease({ requestId: chosen, candidate, preview, releaseState: 'airing', nowMs: 1000 });
    retry.fail(ledger.getRequest(chosen), candidate, 1000);
    for (const name of cases) {
      const id = ids.get(name), request = ledger.getRequest(id), claim = queue.claimNext({ nowMs: 1000, priorityRequestId: id });
      queue.recordResult({ requestId: id, pass: claim.pass, state: 'held', reason: 'no_safe_release', checkedMs: 1000 });
      if (name === 'memo' || ['already_due', 'null_due', 'wrong_anime', 'wrong_target', 'fresh_memo', 'current_revision', 'group_wait', 'cancelled', 'closed', 'inflight'].includes(name)) {
        cache.put({ request: { ...request, anidbId: request.anidbId + (name === 'wrong_anime' ? 1000 : 0) },
          candidate: { ...candidate, guid: name }, result: { state: 'held', reason: 'shoko_preview_wrong_identity' } });
      }
    }
    cache.close(); retry.close(); queue.close(); ledger.close();
    db = new DatabaseSync(dbPath);
    if (db.prepare('PRAGMA table_info(acquisition_request_checks)').all().some(c => c.name === 'verification_policy_revision'))
      db.exec('ALTER TABLE acquisition_request_checks DROP COLUMN verification_policy_revision');
    if (revisionColumn) {
      db.exec('ALTER TABLE acquisition_request_checks ADD COLUMN verification_policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(verification_policy_revision>=0)');
      db.prepare('UPDATE acquisition_request_checks SET verification_policy_revision=1 WHERE request_id=?').run(ids.get('current_revision'));
    }
    db.exec(`UPDATE acquisition_request_checks SET search_policy_rechecked=2, discovery_policy_revision=1;
      UPDATE acquisition_candidate_checks SET result_json=json_remove(result_json,'$._previewIdentityRevision');`);
    for (const name of cases) {
      const id = ids.get(name), episodeId = 1001 + cases.indexOf(name);
      if (name.startsWith('quality-policy-')) db.prepare('UPDATE acquisition_request_checks SET candidate_fingerprint=?,candidate_offset=1 WHERE request_id=?').run(cursor(name, [episodeId]), id);
    }
    db.prepare('UPDATE acquisition_candidate_checks SET targets_json=? WHERE anidb_id=?').run('[99999]', 100 + cases.indexOf('wrong_target'));
    db.prepare('UPDATE acquisition_candidate_checks SET result_json=? WHERE anidb_id=?').run(JSON.stringify({ state: 'held', reason: 'shoko_preview_wrong_identity', _previewIdentityRevision: 'absolute-scope-v1-provider-failure' }), 100 + cases.indexOf('fresh_memo'));
    db.prepare('UPDATE acquisition_request_checks SET next_due_ms=500 WHERE request_id=?').run(ids.get('already_due'));
    db.prepare('UPDATE acquisition_request_checks SET next_due_ms=NULL WHERE request_id=?').run(ids.get('null_due'));
    db.prepare("UPDATE acquisition_request_checks SET reason='preferred_group_wait' WHERE request_id=?").run(ids.get('group_wait'));
    db.prepare('UPDATE requests SET cancelled_ms=1000 WHERE id=?').run(ids.get('cancelled'));
    db.prepare('UPDATE requests SET watch_closed=1 WHERE id=?').run(ids.get('closed'));
    db.prepare('UPDATE acquisition_request_checks SET state=NULL,reason=NULL,next_due_ms=NULL WHERE request_id=?').run(ids.get('inflight'));
    db.prepare('UPDATE acquisition_request_checks SET candidate_fingerprint=? WHERE request_id=?').run(cursor('quality-policy-v9', [1001 + cases.indexOf('current_cursor')]), ids.get('current_cursor'));
    db.prepare('UPDATE acquisition_request_checks SET candidate_fingerprint=? WHERE request_id=?').run(cursor('quality-policy-v8', [99999]), ids.get('wrong_scope'));
    db.prepare('UPDATE acquisition_request_checks SET candidate_fingerprint=? WHERE request_id=?').run(digest(['quality-policy-v8', 1001 + cases.indexOf('malformed')]) + ':not-a-candidate|', ids.get('malformed'));
    const state = () => ({ choices: db.prepare('SELECT id,release_control FROM requests ORDER BY id').all(),
      retry: db.prepare('SELECT * FROM acquisition_quality_retry').all(), wait: db.prepare('SELECT * FROM preferred_release_waits').all(),
      checks: db.prepare('SELECT request_id,scan_started_ms,candidate_offset,candidate_fingerprint,checked_ms,search_policy_rechecked,discovery_policy_revision FROM acquisition_request_checks ORDER BY request_id').all(),
      memo: db.prepare('SELECT * FROM acquisition_candidate_checks ORDER BY cache_key').all() });
    const before = state();
    queue = openAcquisitionRequestQueue(dbPath);
    for (const name of cases) {
      const row = db.prepare('SELECT next_due_ms FROM acquisition_request_checks WHERE request_id=?').get(ids.get(name));
      const wake = name === 'memo' || name === 'closed' || name === 'null_due' || name.startsWith('quality-policy-') || name === 'current_revision' && !revisionColumn;
      assert.equal(row.next_due_ms, name === 'already_due' ? 500 : name === 'inflight' ? null : wake ? 61000 : 3601000, name);
    }
    assert.deepEqual(state(), before, 'all state except due/revision remains exact');
    // Save a fresh genuine miss through the actual queue, then reopen.
    const fresh = queue.claimNext({ nowMs: 61000, priorityRequestId: chosen });
    assert.equal(fresh.requestId, chosen);
    queue.recordResult({ requestId: chosen, pass: fresh.pass, state: 'held', reason: 'no_safe_release', checkedMs: 61000 });
    const due = queue.getResult(chosen).nextDueMs;
    queue.close(); queue = openAcquisitionRequestQueue(dbPath);
    assert.equal(queue.getResult(chosen).nextDueMs, due);
    assert.equal(due, 3661000);
    const claim = queue.claimNext({ nowMs: 61000, priorityRequestId: ids.get('quality-policy-v8') });
    assert.equal(claim.requestId, ids.get('quality-policy-v8'));
  } finally { db?.close(); queue.close(); await rm(dir, { recursive: true, force: true }); }
});

test('verification cursor wake supports old queues without a candidate memo table', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-verification-no-memo-')), dbPath = path.join(dir, 'state.sqlite');
  const ledger = openRequestLedger(dbPath);
  let queue = openAcquisitionRequestQueue(dbPath);
  try {
    const id = ledger.submit({ requesterId: 1, requestKey: 'old', nowMs: 1000,
      intent: { state: 'ready', anidbId: 42, kind: 'series', title: 'Example', episodeIds: [1001], monitorFuture: true } }).requestId;
    const claim = queue.claimNext({ nowMs: 1000, priorityRequestId: id });
    const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
    queue.recordResult({ requestId: id, pass: claim.pass, state: 'held', reason: 'no_safe_release', checkedMs: 1000,
      nextCandidateOffset: 0, nextCandidateFingerprint: `${digest(['quality-policy-v8',1001])}:${digest([7,'candidate'])}|` });
    queue.close();
    const db = new DatabaseSync(dbPath);
    db.exec('UPDATE acquisition_request_checks SET verification_policy_revision=0,search_policy_rechecked=2');
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='acquisition_candidate_checks'").get(), undefined);
    db.close();
    queue = openAcquisitionRequestQueue(dbPath);
    assert.equal(queue.getResult(id).nextDueMs, 61000);
  } finally { queue.close(); ledger.close(); await rm(dir, { recursive: true, force: true }); }
});
