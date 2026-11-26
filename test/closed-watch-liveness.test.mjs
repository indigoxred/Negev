import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionRequestQueue, createAcquisitionPageWorker } from '../src/acquisition/acquisition-request-queue.mjs';
import { openCandidateCheckCache } from '../src/acquisition/candidate-check-cache.mjs';
import { createAcquisitionRequestProcessor } from '../src/acquisition/acquisition-request-processor.mjs';
import { openQualityInspectionRetry } from '../src/acquisition/quality-inspection-retry.mjs';

const candidate = {indexerId:7,guid:'legacy',title:'Example - 01',size:1000,evidence:'unverified'};
async function fixture(version) {
  const dir=await mkdtemp(path.join(tmpdir(),'negev-closed-liveness-')),dbPath=path.join(dir,'state.sqlite');
  const db=new DatabaseSync(dbPath);
  db.exec(await readFile(new URL(`./fixtures/closed-watch-${version}.sql`,import.meta.url),'utf8'));
  assert.equal(db.prepare('SELECT next_due_ms FROM acquisition_request_checks').get().next_due_ms,3601000,'real historical writer uses a finite deadline');
  const ledger=openRequestLedger(dbPath);
  db.exec('UPDATE requests SET watch_closed=1; UPDATE acquisition_request_checks SET search_policy_rechecked=2');
  return {db,dbPath,ledger,async close(){ledger.close();db.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})}};
}
for (const version of ['v0.0.319','v0.0.320','v0.0.321']) {
  for(const suspended of [false,true]) test(`${version}: cache-first expired sole memo ${suspended?'stays suspended until explicit resume':'recovers closed missing work'}`,async()=>{
    const f=await fixture(version); let queue,cache,now=864001000;
    try {
      cache=openCandidateCheckCache(f.dbPath,{now:()=>1000});
      cache.put({request:f.ledger.getRequest(1),candidate,result:{state:'held',reason:'shoko_preview_wrong_identity'}});cache.close();
      f.db.exec("UPDATE acquisition_candidate_checks SET result_json=json_remove(result_json,'$._previewIdentityRevision'); UPDATE acquisition_request_checks SET next_due_ms=NULL,empty_since_ms=500,decision_ms=700,scan_started_ms=800");
      if(suspended)f.db.exec("INSERT INTO acquisition_request_suspensions VALUES(1,'migration_review',1000)");
      // Production startup order: pruning the cache precedes opening the queue.
      cache=openCandidateCheckCache(f.dbPath,{now:()=>now});
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM acquisition_candidate_checks').get().n,0,'the sole old memo is really gone');
      const retry=openQualityInspectionRetry(f.dbPath);retry.fail(f.ledger.getRequest(1),{...candidate,guid:'held-high'},1000);retry.close();
      const savedRetry=f.db.prepare('SELECT * FROM acquisition_quality_retry').all();
      queue=openAcquisitionRequestQueue(f.dbPath);
      if(suspended){
        assert.equal(queue.getResult(1).nextDueMs,null);assert.equal(queue.claimNext({nowMs:now}).state,'pass_complete');
        queue.close();queue=openAcquisitionRequestQueue(f.dbPath);
        assert.equal(queue.getResult(1).nextDueMs,null,'revision stamp and restart cannot bypass suspension');
        assert.deepEqual(queue.resumeSuspended({requestId:1}),{state:'resumed'});
        assert.deepEqual(queue.resumeSuspended({requestId:1}),{state:'held',reason:'not_suspended'});
      }
      assert.equal(queue.getResult(1).nextDueMs,61000,'repair schedules only a fresh check');
      const saved=f.db.prepare('SELECT empty_since_ms,decision_ms,scan_started_ms FROM acquisition_request_checks').get();
      assert.deepEqual({...saved},{empty_since_ms:500,decision_ms:700,scan_started_ms:800});
      assert.deepEqual(f.db.prepare('SELECT * FROM acquisition_quality_retry').all(),savedRetry);
      let available=false,previewCalls=0;const submissions=[];
      const processRequest=createAcquisitionRequestProcessor({readRequest:id=>f.ledger.getRequest(id),
        discoverCandidates:async()=>({state:'candidates',requestId:1,anidbId:100,releaseState:'airing',items:[candidate]}),
        loadDetail:async()=>({state:'details',complete:true,total:1,anidbId:100,title:'Example',kind:'series',restricted:false,episodes:[{id:1001,number:1,type:'Episode'}]}),
        previewCandidate:async()=>{previewCalls++;return available?{state:'preflight',requestId:1,anidbId:100,torrentHash:'a'.repeat(40),episodeIds:[1001],files:[{name:'Example - 01.mkv',size:1000,episodeIds:[1001]}]}:{state:'held',reason:'invalid_metainfo'}},
        submitCandidate:async()=>{submissions.push(1);return {state:'stopped_observed',attemptId:1}},now:()=>now});
      const worker=()=>createAcquisitionPageWorker({queue,limit:1,now:()=>now,processRequest});
      assert.equal((await worker().runOnce({priorityRequestId:1})).results[0].reason,'no_safe_release');
      assert.equal(previewCalls,1,'actual processor rechecks, rather than dispatching from migration evidence');assert.deepEqual(submissions,[]);
      const due=queue.getResult(1).nextDueMs;assert.equal(due,now+1800000);
      queue.close();queue=openAcquisitionRequestQueue(f.dbPath);assert.equal(queue.getResult(1).nextDueMs,due,'fresh retry is durable');
      assert.deepEqual((await worker().runOnce({priorityRequestId:1})).results,[]);
      now=due;available=true;
      assert.equal((await worker().runOnce({priorityRequestId:1})).results[0].state,'stopped_observed');
      assert.deepEqual(submissions,[1]);
      queue.close();queue=openAcquisitionRequestQueue(f.dbPath);
      assert.deepEqual((await worker().runOnce({priorityRequestId:1})).results,[]);assert.deepEqual(submissions,[1],'no repeated claim/submission');
      assert.equal(f.db.prepare('SELECT watch_closed FROM requests').get().watch_closed,1);
    } finally {queue?.close();cache?.close();await f.close()}
  });
  test(`${version}: NULL repair eligibility and finite deadlines preserve controls`,async()=>{
    const cases={finite:'',elapsed:'UPDATE acquisition_request_checks SET next_due_ms=500',
      completed:"UPDATE acquisition_request_checks SET reason='request_fully_available',next_due_ms=NULL",
      cancelled:'UPDATE acquisition_request_checks SET next_due_ms=NULL; UPDATE requests SET cancelled_ms=1000',
      inflight:'UPDATE acquisition_request_checks SET state=NULL,reason=NULL,next_due_ms=NULL',
      observed:"UPDATE acquisition_request_checks SET state='stopped_observed',next_due_ms=NULL",
      unchecked:'UPDATE acquisition_request_checks SET checked_ms=NULL,next_due_ms=NULL',
      group:"UPDATE acquisition_request_checks SET reason='preferred_group_wait',next_due_ms=NULL",
      open:'UPDATE acquisition_request_checks SET next_due_ms=NULL; UPDATE requests SET watch_closed=0',
      wrong_scope:'UPDATE acquisition_request_checks SET next_due_ms=NULL; UPDATE targets SET anidb_id=999',
      orphan:'PRAGMA foreign_keys=OFF; UPDATE acquisition_request_checks SET next_due_ms=NULL; DELETE FROM targets; PRAGMA foreign_keys=ON',
      empty:'UPDATE acquisition_request_checks SET next_due_ms=NULL; DELETE FROM request_targets',
      suspended:"UPDATE acquisition_request_checks SET next_due_ms=NULL; INSERT INTO acquisition_request_suspensions VALUES(1,'migration_review',1000)"};
    for(const [name,sql] of Object.entries(cases)){
      const f=await fixture(version);let queue;
      try {
        f.db.exec(sql);
        if(name!=='suspended')f.db.exec("INSERT INTO acquisition_request_suspensions VALUES(1,'migration_review',1000)");
        const before=f.db.prepare('SELECT * FROM acquisition_request_checks').get();
        const requests=f.db.prepare('SELECT * FROM requests').all();
        queue=openAcquisitionRequestQueue(f.dbPath);
        const after=f.db.prepare('SELECT * FROM acquisition_request_checks').get();
        if(name!=='suspended'){
          assert.deepEqual(queue.resumeSuspended({requestId:1}),{state:'resumed'});
          const resumed=f.db.prepare('SELECT * FROM acquisition_request_checks').get();
          assert.deepEqual(resumed,after,name+' resume preserves check state');
        }
        delete before.verification_policy_revision;delete after.verification_policy_revision;
        assert.deepEqual(after,before,name);assert.deepEqual(f.db.prepare('SELECT * FROM requests').all(),requests,name);
      } finally {queue?.close();await f.close()}
    }
  });
}


for(const version of ['v0.0.319','v0.0.320','v0.0.321']) {
  test(`${version}: repaired hold still obeys live ownership and exact public coverage`,async()=>{
    const f=await fixture(version);let queue;
    try {
      f.db.exec('UPDATE acquisition_request_checks SET next_due_ms=NULL');
      queue=openAcquisitionRequestQueue(f.dbPath,{ownershipGate:{status:()=>'owned'}});
      assert.equal(queue.getResult(1).nextDueMs,61000);
      assert.equal(queue.claimNext({nowMs:61000}).state,'pass_complete','repair cannot bypass ownership gate');
      assert.equal(queue.getResult(1).state,'held');queue.close();
      queue=openAcquisitionRequestQueue(f.dbPath);
      let searches=0,submissions=0;
      const processRequest=createAcquisitionRequestProcessor({readRequest:id=>f.ledger.getRequest(id),
        readPublicCoverage:async request=>({targetCount:request.episodeIds.length,verifiedTargets:1,availableEpisodeIds:[1001]}),
        discoverCandidates:async()=>{searches++;throw Error('should not search')},
        loadDetail:async()=>{throw Error('should not inspect')},
        previewCandidate:async()=>{throw Error('should not preview')},
        submitCandidate:async()=>{submissions++;throw Error('should not submit')},now:()=>61000});
      const worker=createAcquisitionPageWorker({queue,limit:1,now:()=>61000,processRequest});
      assert.equal((await worker.runOnce({priorityRequestId:1})).results[0].reason,'request_fully_available');
      assert.equal(searches,0);assert.equal(submissions,0);
      assert.deepEqual((await worker.runOnce({priorityRequestId:1})).results,[],'completed closed request remains settled');
    }finally{queue?.close();await f.close()}
  });
  test(`${version}: repair preserves manual choice and preferred-group deadline`,async()=>{
    const f=await fixture(version);let queue;
    try {
      f.db.exec('UPDATE requests SET watch_closed=0');
      const selectedCandidate={...candidate,title:'[Other] Example - 01 WEB 1080p',size:400000000};
      const selection={candidate:selectedCandidate,preview:{torrentHash:'b'.repeat(40),episodeIds:[1001],files:[{name:'Example - 01.mkv',size:1000,episodeIds:[1001]}]}};
      assert.equal(f.ledger.updateReleasePreference(1,0,{group:'Preferred',audio:'japanese',createdMs:1000,knownEpisodeIds:[]},1000).state,'updated');
      assert.equal(f.ledger.checkPreferredRelease({requestId:1,candidate:selectedCandidate,preview:selection.preview,releaseState:'airing',nowMs:1000}).reason,'preferred_group_wait');
      assert.equal(f.ledger.updateReleaseControl(1,1,{mode:'manual',phase:'chosen',selection},1000).state,'updated');
      f.db.exec('UPDATE requests SET watch_closed=1; UPDATE acquisition_request_checks SET next_due_ms=NULL');
      const before=f.db.prepare('SELECT * FROM requests').all(),waits=f.db.prepare('SELECT * FROM preferred_release_waits').all();
      assert.equal(waits.length,1);
      queue=openAcquisitionRequestQueue(f.dbPath);assert.equal(queue.getResult(1).nextDueMs,61000);
      assert.deepEqual(f.db.prepare('SELECT * FROM requests').all(),before);
      assert.deepEqual(f.db.prepare('SELECT * FROM preferred_release_waits').all(),waits);
    }finally{queue?.close();await f.close()}
  });
}


