import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openPureMoveLedger } from '../src/acquisition/pure-move-ledger.mjs';
import { openAcquisitionRequestQueue } from '../src/acquisition/acquisition-request-queue.mjs';
import { openAcquisitionPipeline } from '../src/acquisition/acquisition-pipeline.mjs';
import { createAcquisitionRequestProcessor } from '../src/acquisition/acquisition-request-processor.mjs';
import { openRequestProgress } from '../src/requests/request-progress.mjs';
import { requestPresentation } from '../src/web/public/request-progress-text.mjs';
import { pollAiringWatches } from '../src/requests/airing-watch-poll.mjs';
import { readWorkerDiagnostics } from '../src/admin/worker-diagnostics.mjs';
import { createPipelineScheduler } from '../src/acquisition/acquisition-pipeline-scheduler.mjs';
import { processRecordedStart } from '../src/acquisition/process-recorded-start.mjs';

async function fixture(t,{legacy=false,pauseBeforeRecovery=false}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'negev-dispatch-hold-')),dbPath=path.join(root,'negev.sqlite');
  if(legacy){const d=new DatabaseSync(dbPath);d.exec(await readFile(new URL('./fixtures/masked-dispatch-v0.0.323.sql',import.meta.url),'utf8'));d.close()}
  let ledger=openRequestLedger(dbPath),acquisitions=openAcquisitionLedger(dbPath),moves=openPureMoveLedger(dbPath),pipeline;
  let nowMs=Date.UTC(2026,10,26),searches=0,submissions=0;
  let startProcessor=async()=>({state:'held',reason:'not_started'});
  const candidate={indexerId:7,guid:'original',title:'Example - 01',size:1000},hash='a'.repeat(40);
  const id=legacy?1:ledger.submit({requesterId:1,requestKey:'desired',nowMs,
    intent:{state:'ready',anidbId:42,title:'Example',kind:'series',episodeIds:[1001],monitorFuture:true}}).requestId;
  let attemptId=1;
  if(!legacy){const q=openAcquisitionRequestQueue(dbPath);assert.equal(q.claimNext({nowMs,priorityRequestId:id}).state,'claimed');
    attemptId=acquisitions.reserve({requestId:id,candidate,episodeIds:[1001],nowMs}).attemptId;
    acquisitions.bindPreparedTorrent({attemptId,candidate,hash,nowMs});
    acquisitions.recordFilePlan({attemptId,hash,plannedFiles:[{name:'Example - 01.mkv',size:1000,episodeIds:[1001]}],nowMs});
    assert.equal(acquisitions.beginDispatch({attemptId,nowMs}).state,'dispatch_unknown');q.close()}
  const detail={state:'details',complete:true,page:1,nextPage:null,total:2,anidbId:42,title:'Example',kind:'series',restricted:false,
    airDate:'2026-01-01',endDate:'2026-11-25',episodeCount:2,episodes:[{id:1001,number:1,type:'Episode',airDate:'2026-01-01'},{id:1002,number:2,type:'Episode',airDate:'2026-11-25'}]};
  const processRequest=createAcquisitionRequestProcessor({readRequest:id=>ledger.getRequest(id),
    readPublicCoverage:async r=>({targetCount:r.episodeIds.length,verifiedTargets:0,availableEpisodeIds:[]}),loadDetail:async()=>detail,
    discoverCandidates:async()=>{searches++;return{state:'candidates',requestId:id,anidbId:42,items:[]}},previewCandidate:async()=>{throw Error('No release')},
    submitCandidate:async()=>{submissions++;throw Error('No submission')},now:()=>nowMs});
  const make=()=>openAcquisitionPipeline({dbPath,acquisitions,pureMode:true,qbBaseUrl:'http://qb.invalid/',
    sessionGate:{get:async()=>({state:'authenticated',sessionId:'synthetic_sid'}),invalidate:()=>{}},processRequest,
    processStart:input=>startProcessor(input),processCompletion:async()=>({state:'held',reason:'not_started'}),
    processPublish:async()=>({state:'held',reason:'not_started'}),now:()=>nowMs,requestPageLimit:1,
    fetchImpl:async()=>{throw Error('No provider calls')}});
  pipeline=make();if(!pauseBeforeRecovery)await pipeline.initialize();
  t.after(async()=>{await pipeline.close();moves.close();acquisitions.close();ledger.close();await rm(root,{recursive:true,force:true})});
  return{root,dbPath,id,attemptId,hash,candidate,get acquisitions(){return acquisitions},get now(){return nowMs},
    get pipeline(){return pipeline},
    get ledger(){return ledger},setStart:fn=>startProcessor=fn,
    tick:n=>nowMs+=n,get searches(){return searches},get submissions(){return submissions},
    poll:()=>pollAiringWatches({ledger,loadDetail:async()=>detail,today:'2026-11-26',nowMs:++nowMs,intervalMs:0}),
    run:()=>pipeline.tickRequests({priorityRequestId:id}),
    reopen:async()=>{await pipeline.close();ledger.close();acquisitions.close();moves.close();ledger=openRequestLedger(dbPath);acquisitions=openAcquisitionLedger(dbPath);moves=openPureMoveLedger(dbPath);pipeline=make();await pipeline.initialize()},
    progress:()=>{const p=openRequestProgress(dbPath,{pureMode:true});try{return p.read(id)}finally{p.close()}},
    queue:()=>openAcquisitionRequestQueue(dbPath)};
}

for(const legacy of [false,true])test(`interrupted dispatch stays held across final scope, ordinary tick and restart; legacy=${legacy}`,async t=>{
  const x=await fixture(t,{legacy});assert.equal(x.progress().reviewRequired,true);await x.poll();
  for(const elapsed of [0,86400000]){x.tick(elapsed);assert.equal((await x.run()).results.length,0);await x.reopen();
    const p=x.progress();assert.equal(p.state,'request_interrupted');assert.equal(p.reviewRequired,true);
    assert.equal(requestPresentation(p,'series',{monitorFuture:true,watchClosed:true}).group,'attention');}
  assert.equal(x.searches,0);assert.equal(x.submissions,0);
  assert.equal(x.acquisitions.getAttempt(x.attemptId).status,'dispatch_unknown');
  assert.equal(x.acquisitions.reserve({requestId:x.id,candidate:{...x.candidate,guid:'competing'},episodeIds:[1001],nowMs:x.now}).reason,'target_busy');
  const q=x.queue();try{assert.deepEqual(q.resumeObservedAttemptHolds({nowMs:x.now}),[]);assert.deepEqual(q.listMetadataRetries({nowMs:x.now}),[])}finally{q.close()}
  assert.equal((await readWorkerDiagnostics({dataDir:x.root,nowMs:x.now})).stages.acquisition.dueRetries,0);
});

test('a wake from another recovery cannot clear an unresolved dispatch warning',async t=>{
  const x=await fixture(t);await x.poll();const q=x.queue();try{q.wakeRecognitionRecovery({requestId:x.id,nowMs:x.now});
    q.wakeAfterMediaRetirement({requestId:x.id,nowMs:x.now});assert.deepEqual(q.resumeObservedAttemptHolds({nowMs:x.now}),[])}finally{q.close()}
  assert.equal((await x.run()).results.length,0);assert.equal(x.progress().reviewRequired,true);await x.reopen();assert.equal(x.progress().reviewRequired,true);
});

test('exact observed torrent evidence clears the hold and allows the pending finale without reopening monitoring',async t=>{
  const x=await fixture(t);await x.poll();
  assert.equal(x.acquisitions.recordTorrent({attemptId:x.attemptId,hash:x.hash,nowMs:x.now}).state,'torrent_observed');
  const result=await x.run();assert.equal(result.results[0]?.reason,'no_release_candidates');assert.equal(x.searches,1);
  assert.notEqual(x.progress().reviewRequired,true);await x.reopen();assert.notEqual(x.progress().reviewRequired,true);
  const q=x.queue();try{assert.ok(q.getResult(x.id).nextDueMs>x.now)}finally{q.close()}
});

test('a newer manual choice and elapsed preferred deadline cannot override interrupted recovery',async t=>{
  const x=await fixture(t);await x.poll();const d=new DatabaseSync(x.dbPath);
  // New evidence previously made ordinary admission eligible; it cannot be
  // permission to bypass a separate unresolved provider dispatch.
  d.prepare('UPDATE requests SET release_control=? WHERE id=?').run(JSON.stringify({mode:'auto',phase:'consumed',selection:null,revision:2}),x.id);d.close();
  x.tick(7200001);assert.equal((await x.run()).results.length,0);assert.equal(x.progress().reviewRequired,true);
});

test('claim-time live dispatch is not stamped as a recovery hold when a second queue opens',async t=>{
  const x=await fixture(t,{pauseBeforeRecovery:true});const db=new DatabaseSync(x.dbPath);
  db.exec('ALTER TABLE acquisition_request_checks DROP COLUMN recovery_hold');db.close();
  const q=x.queue();try{
    assert.notEqual(x.progress().reviewRequired,true);
    assert.equal(q.getResult(x.id).state,null);
    const d=new DatabaseSync(x.dbPath,{readOnly:true});assert.equal(d.prepare('SELECT recovery_hold FROM acquisition_request_checks').get().recovery_hold,0);d.close();
  }finally{q.close()}
});

test('durable warning survives replacement of the mutable search reason',async t=>{
  const x=await fixture(t);const d=new DatabaseSync(x.dbPath);
  d.exec("UPDATE acquisition_request_checks SET reason='no_safe_release',next_due_ms=0");d.close();
  assert.equal(x.progress().reviewRequired,true);assert.equal((await x.run()).results.length,0);
  await x.reopen();assert.equal(x.progress().reviewRequired,true);
});

test('one observed attempt cannot clear another pending dispatch',async t=>{
  const x=await fixture(t);await x.poll();const other={...x.candidate,guid:'second'};
  const second=x.acquisitions.reserve({requestId:x.id,candidate:other,episodeIds:[1002],nowMs:x.now});assert.equal(second.state,'reserved');
  x.acquisitions.bindPreparedTorrent({attemptId:second.attemptId,candidate:other,hash:'b'.repeat(40),nowMs:x.now});
  x.acquisitions.beginDispatch({attemptId:second.attemptId,nowMs:x.now});
  x.acquisitions.recordTorrent({attemptId:x.attemptId,hash:x.hash,nowMs:x.now});
  assert.equal((await x.run()).results.length,0);assert.equal(x.progress().reviewRequired,true);
  x.acquisitions.recordTorrent({attemptId:second.attemptId,hash:'b'.repeat(40),nowMs:x.now});
  assert.equal((await x.run()).results.length,1);assert.notEqual(x.progress().reviewRequired,true);
});

test('legacy later-submission outcome cannot conceal an earlier unknown dispatch',async t=>{
  const x=await fixture(t,{legacy:true});const d=new DatabaseSync(x.dbPath);
  d.exec(`ALTER TABLE acquisition_request_checks DROP COLUMN recovery_hold;
    UPDATE acquisition_request_checks SET state='stopped_observed',reason=NULL,attempt_id=2`);d.close();
  const q=x.queue();q.close();assert.equal(x.progress().reviewRequired,true);
  assert.equal((await x.run()).results.length,0);
  x.acquisitions.recordTorrent({attemptId:x.attemptId,hash:x.hash,nowMs:x.now});
  assert.equal((await x.run()).results.length,1);assert.notEqual(x.progress().reviewRequired,true);
});

test('actual scheduler RSS wakes preserve review, then genuine observation allows ordinary resumption',async t=>{
  const x=await fixture(t);let pending;
  const scheduler=createPipelineScheduler({pipeline:x.pipeline,now:()=>x.now,
    setTimer:(callback,delay)=>{pending={callback,delay};return 1},clearTimer:()=>{pending=null}});
  await scheduler.start();await x.poll();scheduler.wakeRequest(x.id);scheduler.wakeRequest(x.id);
  const advance=async()=>{assert.ok(pending);const job=pending;pending=null;x.tick(job.delay);await job.callback();await new Promise(resolve=>setImmediate(resolve))};
  try{
    for(let i=0;i<8;i++)await advance();
    assert.equal(x.searches,0);assert.equal(x.progress().reviewRequired,true);
    x.acquisitions.recordTorrent({attemptId:x.attemptId,hash:x.hash,nowMs:x.now});
    for(let i=0;i<8&&x.searches===0;i++)await advance();
    assert.equal(x.searches,1);assert.notEqual(x.progress().reviewRequired,true);assert.equal(x.submissions,0);
  }finally{await scheduler.stop()}
});

test('a legitimately released old reservation does not prevent resolved dispatch resumption',async t=>{
  const x=await fixture(t);await x.poll();
  const old=x.acquisitions.reserve({requestId:x.id,candidate:{...x.candidate,guid:'released-old'},episodeIds:[1002],nowMs:x.now});
  assert.equal(old.state,'reserved');assert.equal(x.acquisitions.releaseReserved({attemptId:old.attemptId,nowMs:x.now}).state,'released_pre_dispatch');
  assert.equal((await x.run()).results.length,0);
  x.acquisitions.recordTorrent({attemptId:x.attemptId,hash:x.hash,nowMs:x.now});
  assert.equal((await x.run()).results.length,1);assert.notEqual(x.progress().reviewRequired,true);
});

test('normal start recovery observes exact saved manifest after an outage/restart, then resumes finale without another add',async t=>{
  const x=await fixture(t);await x.poll();let healthy=false,reads=0,writes=0;
  const savePath='/Downloads/negev/'+x.hash;
  x.setStart(input=>processRecordedStart({...input,requests:x.ledger,acquisitions:x.acquisitions,
    stagingHostPath:'/srv/staging',qbitStagingRoot:'/Downloads/negev',
    verifyStagingRoot:async()=>({state:'verified_staging_root'}),readEvidence:async()=>({}),publicLibraryIds:[102],now:()=>x.now,
    fetchImpl:async(url,init)=>{if(init.method!=='GET')writes++;reads++;if(!healthy)return new Response('',{status:503});
      if(url.pathname.endsWith('/info'))return Response.json([{hash:x.hash,category:'negev',save_path:savePath,state:'stoppedDL',progress:0,downloaded:0,amount_left:1000,auto_tmm:false,force_start:false}]);
      if(url.pathname.endsWith('/properties'))return Response.json({save_path:savePath,download_path:''});
      if(url.pathname.endsWith('/files'))return Response.json([{index:0,name:'Example - 01.mkv',size:1000,priority:1,progress:0}]);
      throw Error('Unexpected provider read')},
    start:async()=>({state:'held',reason:'provider_unavailable'})}));
  const unavailable=await x.pipeline.tickStarts();assert.equal(unavailable.result.state,'held');
  assert.equal(x.acquisitions.getAttempt(x.attemptId).status,'dispatch_unknown');assert.equal((await x.run()).results.length,0);
  await x.reopen();x.tick(60000);healthy=true;
  await x.pipeline.tickStarts();assert.equal(x.acquisitions.getAttempt(x.attemptId).status,'torrent_observed');
  assert.equal((await x.run()).results[0]?.reason,'no_release_candidates');assert.equal(x.progress().reviewRequired,false);
  assert.ok(reads>=7);assert.equal(writes,0);assert.equal(x.submissions,0);
});
