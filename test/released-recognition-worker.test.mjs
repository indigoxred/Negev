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
  let nowMs=Date.UTC(2026,10,26),searches=0,submissions=0; const searched=[];
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
    readPublicCoverage:async r=>({targetCount:r.episodeIds.length,verifiedTargets:1,availableEpisodeIds:[1001]}),loadDetail:async()=>detail,
    discoverCandidates:async input=>{searched.push(input.searchTargetEpisodeId);searches++;return{state:'candidates',requestId:id,anidbId:42,items:[]}},previewCandidate:async()=>{throw Error('No release')},
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
    tick:n=>nowMs+=n,get searched(){return searched},get searches(){return searches},get submissions(){return submissions},
    poll:()=>pollAiringWatches({ledger,loadDetail:async()=>detail,today:'2026-11-26',nowMs:++nowMs,intervalMs:0}),
    run:()=>pipeline.tickRequests({priorityRequestId:id}),
    reopen:async()=>{await pipeline.close();ledger.close();acquisitions.close();moves.close();ledger=openRequestLedger(dbPath);acquisitions=openAcquisitionLedger(dbPath);moves=openPureMoveLedger(dbPath);pipeline=make();await pipeline.initialize()},
    progress:()=>{const p=openRequestProgress(dbPath,{pureMode:true});try{return p.read(id)}finally{p.close()}},
    queue:()=>openAcquisitionRequestQueue(dbPath)};
}


import{openRecognitionRecoveryLedger}from'../src/acquisition/recognition-recovery-ledger.mjs';

async function published(x,status='released'){
 x.acquisitions.recordTorrent({attemptId:x.attemptId,hash:x.hash,nowMs:x.now});
 x.acquisitions.beginStart({attemptId:x.attemptId,hash:x.hash,manifestDigest:'c'.repeat(64),nowMs:x.now});
 const m=openPureMoveLedger(x.dbPath);
 try{assert.equal(m.recordIntent({attemptId:x.attemptId,torrentHash:x.hash,stagingRoot:path.join(x.root,'staging',x.hash),holdingPath:path.join(x.root,'holding','negev-'+x.attemptId+'-'+x.hash.slice(0,16)),files:[{name:'Example - 01.mkv',size:1000,episodeIds:[1001],dev:'1',ino:'2',mtimeNs:'3'}],nowMs:x.now}).state,'recorded');
 m.markPrepared({attemptId:x.attemptId,nowMs:x.now});m.beginPublish({attemptId:x.attemptId,nowMs:x.now});m.markPublished({attemptId:x.attemptId,nowMs:x.now});}finally{m.close()}
 const r=openRecognitionRecoveryLedger(x.dbPath);
 try{if(status==='none')return;r.recordFirstSeen({attemptId:x.attemptId,fileId:81,nowMs:x.now});if(status==='observed')return;x.tick(60000);r.beginPreserve({attemptId:x.attemptId,fileId:81,nowMs:x.now});if(status==='preserve_unknown')return;r.markPreserved({attemptId:x.attemptId,nowMs:x.now});if(status==='preserved')return;assert.equal(r.releaseForAlternate({attemptId:x.attemptId,nowMs:x.now}).state,'released')}finally{r.close()}
}
for(const existingHold of [false,true]) for(const replacement of [false,true]) for(const retirementControl of [false,true])test('final Shoko recovery release permits missing finale after restart '+JSON.stringify({existingHold,replacement,retirementControl}),async t=>{
 const x=await fixture(t,{pauseBeforeRecovery:true});await published(x);
 if(retirementControl){const d=new DatabaseSync(x.dbPath);d.prepare("INSERT INTO acquisition_retirements VALUES(?,?,'policy_reset',?)").run(x.attemptId,x.hash,x.now);d.close()}
 if(replacement){const c={...x.candidate,guid:'alternate'},hash='b'.repeat(40),a=x.acquisitions.reserve({requestId:x.id,candidate:c,episodeIds:[1001],nowMs:x.now});assert.equal(a.state,'reserved');x.acquisitions.bindPreparedTorrent({attemptId:a.attemptId,candidate:c,hash,nowMs:x.now});x.acquisitions.beginDispatch({attemptId:a.attemptId,nowMs:x.now});x.acquisitions.recordTorrent({attemptId:a.attemptId,hash,nowMs:x.now});}
 if(existingHold){const q=x.queue();try{assert.equal(q.recordResult({requestId:x.id,pass:q.getResult(x.id).pass,state:'held',reason:'interrupted_attempt_present',checkedMs:x.now}).state,'recorded')}finally{q.close()}}
 const inspection=x.acquisitions.inspectRequestAttempts(x.id);
 await x.pipeline.initialize();await x.poll();await x.run();await x.reopen();x.tick(86400000);await x.run();

 assert.equal(x.searches,2);assert.deepEqual(x.searched,[1002,1002]);assert.equal(x.submissions,0);assert.equal(x.progress().reviewRequired,false);
});

for(const state of ['unknown','observed_no_hash','observed_no_claim','observed_plus_unknown'])test('genuine uncertain dispatch stays held '+state,async t=>{
 const x=await fixture(t);await x.poll();
 if(state==='observed_no_hash'){const d=new DatabaseSync(x.dbPath);d.exec("UPDATE acquisition_attempts SET status='torrent_observed',torrent_hash=NULL");d.close()}
 if(state==='observed_no_claim'){x.acquisitions.recordTorrent({attemptId:x.attemptId,hash:x.hash,nowMs:x.now});const d=new DatabaseSync(x.dbPath);d.exec('UPDATE acquisition_target_claims SET active=0');d.close()}
 if(state==='observed_plus_unknown'){const c={...x.candidate,guid:'second'},a=x.acquisitions.reserve({requestId:x.id,candidate:c,episodeIds:[1002],nowMs:x.now});x.acquisitions.bindPreparedTorrent({attemptId:a.attemptId,candidate:c,hash:'b'.repeat(40),nowMs:x.now});x.acquisitions.beginDispatch({attemptId:a.attemptId,nowMs:x.now});x.acquisitions.recordTorrent({attemptId:x.attemptId,hash:x.hash,nowMs:x.now})}
 await x.run();await x.reopen();x.tick(86400000);await x.run();assert.equal(x.searches,0);assert.equal(x.progress().reviewRequired,true);
});

for(const status of ['none','observed','preserve_unknown','preserved'])test('nonfinal recognition status cannot end an inactive-claim attempt: '+status,async t=>{const x=await fixture(t,{pauseBeforeRecovery:true});await published(x,status);const d=new DatabaseSync(x.dbPath);d.exec('UPDATE acquisition_target_claims SET active=0');d.close();assert.equal(x.acquisitions.inspectRequestAttempts(x.id).state,'attempt_present');await x.pipeline.initialize();await x.poll();await x.run();await x.reopen();assert.equal(x.searches,0);assert.equal(x.progress().reviewRequired,true)});
test('a final released old attempt cannot conceal a genuinely unknown alternate',async t=>{const x=await fixture(t,{pauseBeforeRecovery:true});await published(x);const c={...x.candidate,guid:'unobserved-alternate'},a=x.acquisitions.reserve({requestId:x.id,candidate:c,episodeIds:[1001],nowMs:x.now});x.acquisitions.bindPreparedTorrent({attemptId:a.attemptId,candidate:c,hash:'b'.repeat(40),nowMs:x.now});x.acquisitions.beginDispatch({attemptId:a.attemptId,nowMs:x.now});await x.pipeline.initialize();await x.poll();await x.run();await x.reopen();assert.equal(x.searches,0);assert.equal(x.progress().reviewRequired,true)});
