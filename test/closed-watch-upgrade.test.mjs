import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionRequestQueue, createAcquisitionPageWorker } from '../src/acquisition/acquisition-request-queue.mjs';
import { createAcquisitionRequestProcessor } from '../src/acquisition/acquisition-request-processor.mjs';
import { openQualityInspectionRetry } from '../src/acquisition/quality-inspection-retry.mjs';
import { openCandidateCheckCache } from '../src/acquisition/candidate-check-cache.mjs';

// Removing the closed-watch recovery or broadening its evidence/eligibility
// guards must break these real durable queue and worker assertions.
for (const revision of [null, 0, 1]) test(`closed legacy misses recover once from revision ${revision}`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-closed-upgrade-'));
  const dbPath = path.join(dir, 'state.sqlite');
  let ledger = openRequestLedger(dbPath), queue = openAcquisitionRequestQueue(dbPath);
  const cache = openCandidateCheckCache(dbPath, { now: () => 1000 });
  let db, memo;
  const cases = ['null_memo','finite_cursor','elapsed_cursor','complete','cancelled','inflight','suspended',
    'empty_targets','wrong_anime','wrong_target','fresh_memo','current_cursor','wrong_scope','malformed','no_evidence','open_current'];
  const ids = new Map();
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const cursor = (policy, episodeId) => `${digest([policy,episodeId])}:${digest([7,'candidate'])}|`;
  try {
    for (const [i, name] of cases.entries()) {
      const id = ledger.submit({ requesterId: 1, requestKey: name, nowMs: 1000,
        intent: { state: 'ready', anidbId: 100+i, kind: 'series', title: 'Example', episodeIds: [1001+i], monitorFuture: true } }).requestId;
      ids.set(name, id);
      const claim = queue.claimNext({ nowMs: 1000, priorityRequestId: id });
      queue.recordResult({ requestId: id, pass: claim.pass, state: 'held', reason: 'no_safe_release', checkedMs: 1000 });
      if (!['finite_cursor','elapsed_cursor','current_cursor','wrong_scope','malformed','no_evidence'].includes(name)) {
        cache.put({ request: { ...ledger.getRequest(id), anidbId: 100+i+(name==='wrong_anime'?1000:0) },
          candidate: { indexerId: 7, guid: name, title: 'Example - 01', size: 1000 },
          result: { state: 'held', reason: 'shoko_preview_wrong_identity' } });
      }
    }

    const retry=openQualityInspectionRetry(dbPath);
    retry.fail(ledger.getRequest(ids.get('null_memo')),{indexerId:7,guid:'held-high',title:'[Group] Example - 01 WEB 1080p',size:400000000},1000);
    retry.close();
    const selection={candidate:{indexerId:7,guid:'manual-choice',title:'[Other] Example - 01 WEB 1080p',size:400000000},preview:{torrentHash:'b'.repeat(40),episodeIds:[1001],files:[{name:'Example - 01.mkv',size:400000000,episodeIds:[1001]}]}};
    assert.equal(ledger.updateReleaseControl(ids.get('null_memo'),0,{mode:'manual',phase:'chosen',selection},1000).state,'updated');
    ledger.updateReleasePreference(ids.get('null_memo'),1,{group:'Preferred',audio:'japanese',createdMs:1000,knownEpisodeIds:[]},1000);
    ledger.checkPreferredRelease({requestId:ids.get('null_memo'),candidate:selection.candidate,preview:selection.preview,releaseState:'airing',nowMs:1000});
    cache.close(); queue.close(); ledger.close();
    db = new DatabaseSync(dbPath);
    db.prepare('INSERT INTO acquisition_request_suspensions VALUES (?, ?, ?)').run(ids.get('suspended'), 'migration_review', 1000);
    db.exec('UPDATE requests SET watch_closed=1; UPDATE acquisition_request_checks SET search_policy_rechecked=2,discovery_policy_revision=1; UPDATE acquisition_candidate_checks SET result_json=json_remove(result_json,\'$._previewIdentityRevision\')');
    if (revision===null) db.exec('ALTER TABLE acquisition_request_checks DROP COLUMN verification_policy_revision');
    else db.prepare('UPDATE acquisition_request_checks SET verification_policy_revision=?').run(revision);
    db.prepare('UPDATE requests SET watch_closed=0 WHERE id=?').run(ids.get('open_current'));
    if (revision===null) {} else db.prepare('UPDATE acquisition_request_checks SET verification_policy_revision=1 WHERE request_id=?').run(ids.get('open_current'));
    for (const name of ['finite_cursor','elapsed_cursor','current_cursor','wrong_scope','malformed']) {
      const episodeId=1001+cases.indexOf(name);
      db.prepare('UPDATE acquisition_request_checks SET candidate_offset=1,candidate_fingerprint=? WHERE request_id=?')
        .run(name==='malformed'?`${digest(['quality-policy-v8',episodeId])}:broken|`:
          cursor(name==='current_cursor'?'quality-policy-v9':'quality-policy-v8',name==='wrong_scope'?99999:episodeId),ids.get(name));
    }
    db.prepare('UPDATE acquisition_candidate_checks SET targets_json=\'[99999]\' WHERE anidb_id=?').run(100+cases.indexOf('wrong_target'));
    db.prepare('UPDATE acquisition_candidate_checks SET result_json=? WHERE anidb_id=?').run(JSON.stringify({state:'held',reason:'shoko_preview_wrong_identity',_previewIdentityRevision:'absolute-scope-v1-provider-failure'}),100+cases.indexOf('fresh_memo'));
    db.prepare('UPDATE acquisition_request_checks SET next_due_ms=NULL WHERE request_id=?').run(ids.get('null_memo'));
    db.prepare('UPDATE acquisition_request_checks SET next_due_ms=500 WHERE request_id=?').run(ids.get('elapsed_cursor'));
    db.prepare("UPDATE acquisition_request_checks SET reason='request_fully_available' WHERE request_id=?").run(ids.get('complete'));
    db.prepare('UPDATE requests SET cancelled_ms=1000 WHERE id=?').run(ids.get('cancelled'));
    db.prepare('UPDATE acquisition_request_checks SET state=NULL,reason=NULL,next_due_ms=NULL WHERE request_id=?').run(ids.get('inflight'));
    db.prepare('DELETE FROM request_targets WHERE request_id=?').run(ids.get('empty_targets'));
    const state = () => ({requests:db.prepare('SELECT * FROM requests ORDER BY id').all(),
      checks:db.prepare('SELECT request_id,pass,state,reason,checked_ms,empty_since_ms,scan_started_ms,candidate_offset,candidate_fingerprint,scan_scope,scan_target_count FROM acquisition_request_checks ORDER BY request_id').all(),
      memo:db.prepare('SELECT * FROM acquisition_candidate_checks ORDER BY cache_key').all(),
      retry:db.prepare('SELECT * FROM acquisition_quality_retry').all(),
      waits:db.prepare('SELECT * FROM preferred_release_waits').all(),
      suspensions:db.prepare('SELECT * FROM acquisition_request_suspensions').all()});
    const before=state();
    assert.equal(before.waits.length,1,'real preferred wait seeded');
    assert.equal(JSON.parse(before.requests.find(row=>row.id===ids.get('null_memo')).release_control).mode,'manual','real manual choice seeded');
    queue=openAcquisitionRequestQueue(dbPath);
    for (const name of cases) assert.equal(queue.getResult(ids.get(name)).nextDueMs,
      (['null_memo','finite_cursor'].includes(name)||name==='open_current'&&revision===null)?61000:name==='elapsed_cursor'?500:name==='inflight'?null:3601000,name);
    assert.deepEqual(state(),before,'recovery changes only scheduling and revision');
    // Ten days later a NULL legacy hold is claimable through the normal worker;
    // a fresh miss keeps its ordinary closed-watch retry and closure persists.
    let now=61000, recovered=false, previewCalls=0;
    ledger=openRequestLedger(dbPath);
    memo=openCandidateCheckCache(dbPath,{now:()=>now});
    const candidate={indexerId:7,guid:'null_memo',title:'Example - 01',size:1000,evidence:'unverified'};
    const submitted=[];
    const processRequest=createAcquisitionRequestProcessor({
      readRequest:id=>ledger.getRequest(id),
      discoverCandidates:async()=>({state:'candidates',requestId:ids.get('null_memo'),anidbId:100,releaseState:'airing',items:[candidate]}),
      loadDetail:async()=>({state:'details',complete:true,total:1,anidbId:100,title:'Example',kind:'series',restricted:false,episodes:[{id:1001,number:1,type:'Episode'}]}),
      previewCandidate:async(input)=>{ const saved=memo.get({request:ledger.getRequest(input.requestId),candidate:input.candidate}); if(saved)return saved; previewCalls++; return recovered?{state:'preflight',requestId:ids.get('null_memo'),anidbId:100,torrentHash:'a'.repeat(40),episodeIds:[1001],files:[{name:'Example - 01.mkv',size:1000,episodeIds:[1001]}]}:{state:'held',reason:'invalid_metainfo'}; },
      submitCandidate:async({request,candidate:chosen})=>{submitted.push({requestId:request.id,guid:chosen.guid});return{state:'stopped_observed',attemptId:1}},now:()=>now
    });
    const worker=createAcquisitionPageWorker({queue,limit:1,now:()=>now,
      processRequest});
    const outcome=(await worker.runOnce({priorityRequestId:ids.get('null_memo')})).results[0]; assert.equal(outcome.reason,'no_safe_release'); assert.equal(outcome.requestId,ids.get('null_memo'));
    const due=queue.getResult(ids.get('null_memo')).nextDueMs;
    assert.equal(previewCalls,1,'old wrong-identity memo is reconsidered by the actual processor');
    assert.deepEqual(submitted,[]);
    assert.equal(due,1861000,'closed watch uses normal 30 minute cadence after a fresh miss');
    queue.close(); queue=openAcquisitionRequestQueue(dbPath);
    assert.equal(queue.getResult(ids.get('null_memo')).nextDueMs,due,'restart cannot repeat upgrade wake');
    assert.equal(db.prepare('SELECT watch_closed,monitor_future FROM requests WHERE id=?').get(ids.get('null_memo')).watch_closed,1);
    assert.equal(db.prepare('SELECT watch_closed,monitor_future FROM requests WHERE id=?').get(ids.get('null_memo')).monitor_future,1);
    assert.equal(queue.claimNext({nowMs:now,priorityRequestId:ids.get('null_memo')}).requestId,ids.get('finite_cursor'));
    now=864001000; recovered=true;
    const restored=createAcquisitionPageWorker({queue,limit:1,now:()=>now,processRequest});
    assert.equal((await restored.runOnce({priorityRequestId:ids.get('null_memo')})).results[0].state,'stopped_observed');
    assert.deepEqual(submitted,[{requestId:ids.get('null_memo'),guid:'null_memo'}]);
    assert.equal(db.prepare('SELECT watch_closed FROM requests WHERE id=?').get(ids.get('null_memo')).watch_closed,1);
    memo.close();
  } finally { db?.close(); queue.close(); try { memo?.close(); } catch {} try { ledger.close(); } catch {} try { cache.close(); } catch {} await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
});






