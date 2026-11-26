import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {openAcquisitionLedger} from '../src/acquisition/acquisition-ledger.mjs';
import {openHandoffLedger} from '../src/acquisition/handoff-ledger.mjs';
import {openAcquisitionRequestQueue} from '../src/acquisition/acquisition-request-queue.mjs';
import {openAcquisitionPipeline} from '../src/acquisition/acquisition-pipeline.mjs';
import {openAcquisitionRuntime} from '../src/acquisition/acquisition-runtime.mjs';
import {createAcquisitionRequestProcessor} from '../src/acquisition/acquisition-request-processor.mjs';
import {createReleaseWake} from '../src/acquisition/release-wake.mjs';
const alternative={guid:'alternative',indexerId:1,title:'[Other] Example - 02 1080p',size:1000,seeders:20,evidence:'unverified'};
const preferred={...alternative,guid:'preferred',title:'[SubsPlease] Example - 02 1080p'};
const preview={state:'preflight',requestId:1,anidbId:42,torrentHash:'a'.repeat(40),episodeIds:[102],files:[{name:'Example - 02.mkv',size:1000,episodeIds:[102]}]};
async function fixture(run){
 const dir=await mkdtemp(join(tmpdir(),'negev-preferred-wake-')),dbPath=join(dir,'state.sqlite');
 const requests=openRequestLedger(dbPath),acquisitions=openAcquisitionLedger(dbPath),handoffs=openHandoffLedger(dbPath);
 requests.submit({requesterId:1,requestKey:'airing',nowMs:100,intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:true,episodeIds:[102]}});
 requests.updateReleasePreference(1,0,{group:'SubsPlease',audio:'japanese',knownEpisodeIds:[],createdMs:100},100);
 try{await run({dbPath,requests,acquisitions,handoffs,dir});}finally{handoffs.close();acquisitions.close();requests.close();await rm(dir,{recursive:true,force:true});}
}
function saveWait(queue,requests,nowMs=1000){
 const wait=requests.checkPreferredRelease({requestId:1,candidate:alternative,preview,releaseState:'airing',nowMs});
 const claim=queue.claimNext({nowMs,priorityRequestId:1});
 queue.recordResult({requestId:1,pass:claim.pass,state:'held',reason:wait.reason,retryAtMs:wait.retryAtMs,checkedMs:nowMs});return wait.retryAtMs;
}
for(const release of [preferred,alternative])test('RSS admission at minute 30 '+(release===preferred?'admits preferred release':'retains fallback deadline')+' across restart',async()=>fixture(async({dbPath,requests,acquisitions})=>{
 let ms=1000,items=[alternative],submits=[];
 const processRequest=createAcquisitionRequestProcessor({readRequest:id=>requests.getRequest(id),discoverCandidates:async()=>({state:'candidates',requestId:1,anidbId:42,releaseState:'airing',items}),previewCandidate:async()=>preview,
  loadDetail:async()=>({state:'details',anidbId:42,kind:'series',title:'Example',restricted:false,complete:true,total:1,episodes:[{id:102,number:2,type:'Episode'}]}),readReleaseControl:(id,now)=>requests.getReleaseControl(id,now),checkPreferredRelease:input=>requests.checkPreferredRelease(input),getPreferredFallback:(...args)=>requests.getPreferredFallback(...args),closePreferredWaits:(...args)=>requests.closePreferredWaits(...args),submitCandidate:async input=>{submits.push(input.candidate.guid);return {state:'stopped_observed',attemptId:7};},now:()=>ms});
 const open=()=>openAcquisitionPipeline({dbPath,acquisitions,processRequest,processStart:async()=>{},processCompletion:async()=>{},processPublish:async()=>{},qbBaseUrl:'http://qb:8080/',sessionGate:{get:async()=>({state:'authenticated',sessionId:'synthetic'}),invalidate:()=>{}},now:()=>ms});
 let pipeline=open(),wake;const inspect=openAcquisitionRequestQueue(dbPath);
 try{await pipeline.initialize();const first=await pipeline.tickRequests({priorityRequestId:1});assert.equal(first.results[0].reason,'preferred_group_wait');const deadline=inspect.getResult(1).nextDueMs;assert.equal(deadline,7201000);
  ms=1801000;items=[release];assert.deepEqual((await pipeline.tickRequests({priorityRequestId:1})).results,[]);
  wake=createReleaseWake({wakeRequest:id=>pipeline.wakeRequest({requestId:id,nowMs:ms}),pollWatch:async()=>({results:[]})});await wake(1,{releaseTitles:[release.title]});assert.equal(inspect.getResult(1).nextDueMs,ms);
  await pipeline.close();pipeline=open();await pipeline.initialize();const resumed=await pipeline.tickRequests({priorityRequestId:1});
  if(release===preferred){assert.equal(resumed.results[0].state,'stopped_observed');assert.deepEqual(submits,['preferred']);}
  else{assert.equal(resumed.results[0].reason,'preferred_group_wait');assert.deepEqual(submits,[]);assert.equal(inspect.getResult(1).nextDueMs,deadline);assert.equal(requests.getPreferredWait(1,ms).deadlineMs,deadline);ms=deadline;await pipeline.tickRequests({priorityRequestId:1});assert.deepEqual(submits,['alternative']);}
 }finally{await wake?.close();await pipeline.close();inspect.close();}
}));
for(const guard of ['other_reason','suspended','cancelled','recovery','active_claim'])test('release wake preserves '+guard,async()=>fixture(async({dbPath,requests})=>{
 const queue=openAcquisitionRequestQueue(dbPath),db=new DatabaseSync(dbPath);
 try{saveWait(queue,requests);if(guard==='other_reason')db.exec("UPDATE acquisition_request_checks SET reason='import_activity_unverified'");if(guard==='suspended')queue.suspendUnstarted({requestId:1,reason:'migration_review',nowMs:1001});if(guard==='cancelled')requests.cancelRequest({requesterId:1,requestId:1,nowMs:1001});if(guard==='recovery')db.exec('UPDATE acquisition_request_checks SET recovery_hold=1');if(guard==='active_claim')db.exec('UPDATE acquisition_request_checks SET state=NULL');
  const before=queue.getResult(1);queue.wakePreferredGroupWait({requestId:1,nowMs:1801000});assert.deepEqual(queue.getResult(1),before);assert.notEqual(queue.claimNext({nowMs:1801000,priorityRequestId:1}).requestId,1);
 }finally{db.close();queue.close();}
}));
test('runtime wake persists preferred-group admission before scheduler and across reopen',async()=>fixture(async({dbPath,requests,acquisitions,handoffs,dir})=>{
 let queue=openAcquisitionRequestQueue(dbPath);const deadline=saveWait(queue,requests);queue.close();let runtime;
 try{runtime=openAcquisitionRuntime({enabled:true,dbPath,requests,acquisitions,handoffs,now:()=>1801000,qbBaseUrl:'http://qb:8080/',sessionGate:{get:async()=>{throw Error('no login')},invalidate:()=>{}},discoverCandidates:async()=>{throw Error('no search')},previewCandidate:async()=>{},loadDetail:async()=>{},releaseQueries:async()=>[],readEvidence:async()=>{},readPublicCoverage:()=>({verifiedTargets:0,targetCount:1}),publicSections:{episode:[102],movie:[]},prowlarr:{baseUrl:'http://prowlarr:9696/',apiKey:'synthetic',indexerIds:[1]},shoko:{baseUrl:'http://shoko:8111/',apiKey:'synthetic',providerId:'11111111-2222-4333-8444-555555555555'},stagingHostPath:join(dir,'staging'),holdingRoot:join(dir,'holding'),importRoot:join(dir,'import'),inspectMounts:async()=>{},verifyShokoSource:async()=>{},realpathImpl:async()=>{},fetchImpl:async()=>{throw Error('no network')}});
  runtime.wakeRequest(1);await runtime.stop();queue=openAcquisitionRequestQueue(dbPath);assert.equal(queue.getResult(1).nextDueMs,1801000);assert.equal(requests.getPreferredWait(1,1801000).deadlineMs,deadline);assert.equal(queue.claimNext({nowMs:1801000,priorityRequestId:1}).requestId,1);
 }finally{await runtime?.stop();queue.close();}
}));
