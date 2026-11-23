import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,mkdir,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {openAcquisitionLedger} from '../src/acquisition/acquisition-ledger.mjs';
import {openAcquisitionRequestQueue} from '../src/acquisition/acquisition-request-queue.mjs';
import {openStartQueue,createStartWorker} from '../src/acquisition/start-queue.mjs';
import {processRecordedStart} from '../src/acquisition/process-recorded-start.mjs';
import {openHandoffLedger} from '../src/acquisition/handoff-ledger.mjs';
import {openPureMoveLedger} from '../src/acquisition/pure-move-ledger.mjs';
import {openCompletionQueue,createCompletionWorker} from '../src/acquisition/completion-queue.mjs';
import {processPureCompletedAttempt} from '../src/acquisition/process-pure-completed-attempt.mjs';

async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'negev-start-completion-')),dbPath=path.join(root,'state.sqlite');
 const requests=openRequestLedger(dbPath),acquisitions=openAcquisitionLedger(dbPath);
 const requestId=requests.submit({requesterId:1,requestKey:'desired',nowMs:100,intent:{state:'ready',title:'Example',anidbId:42,kind:'series',monitorFuture:false,episodeIds:[1001]}}).requestId;
 const candidate={indexerId:1,guid:'saved'},hash='a'.repeat(40),name='Example - 01.mkv',savePath='/Downloads/negev/'+hash;
 const attemptId=acquisitions.reserve({requestId,candidate,episodeIds:[1001],nowMs:200}).attemptId;
 acquisitions.bindPreparedTorrent({attemptId,candidate,hash,nowMs:201});acquisitions.recordFilePlan({attemptId,hash,plannedFiles:[{name,size:1000,episodeIds:[1001]}],nowMs:202});acquisitions.beginDispatch({attemptId,nowMs:203});acquisitions.recordTorrent({attemptId,hash,nowMs:204});
 const requestQueue=openAcquisitionRequestQueue(dbPath),cleanup=[];let queue=openStartQueue(dbPath);
 t.after(async()=>{for(const close of cleanup)close();queue.close();requestQueue.close();acquisitions.close();requests.close();await rm(root,{recursive:true,force:true});});
 let starts=0;
 const fetchGood=async(url,init={})=>{const endpoint=new URL(url).pathname;if(endpoint.endsWith('/start')){starts++;return new Response('Ok.');}if(endpoint.endsWith('/info'))return Response.json([{hash,category:'negev',save_path:savePath,state:'stoppedDL',progress:0,downloaded:0,amount_left:1000,auto_tmm:false,force_start:false}]);if(endpoint.endsWith('/properties'))return Response.json({save_path:savePath,download_path:''});if(endpoint.endsWith('/files'))return Response.json([{index:0,name,size:1000,priority:1,progress:0}]);throw Error('Unexpected endpoint '+endpoint)};
 const options={requests,acquisitions,attemptId,stagingHostPath:path.join(root,'stage'),qbitStagingRoot:'/Downloads/negev',qbittorrent:{baseUrl:'http://synthetic.invalid/',sessionId:'syntheticSID'},verifyStagingRoot:async()=>({state:'verified_staging_root'}),publicLibraryIds:[102],readEvidence:async({anidbId,episodeIds})=>({anidbId,episodeIds,observedAtMs:clock,importFence:{state:'settled',anidbId,episodeIds,beforeObservedAtMs:clock,afterObservedAtMs:clock},shoko:{state:'ok',complete:true,files:[]},plex:{state:'ok',complete:true,sourceVerified:true,libraryIds:[102],parts:[]}})};
 let clock=1000;return {onCleanup:fn=>cleanup.push(fn),root,dbPath,requests,acquisitions,attemptId,hash,name,savePath,options,fetchGood,get starts(){return starts},get clock(){return clock},set clock(v){clock=v},get queue(){return queue},reopen(){queue.close();queue=openStartQueue(dbPath)}};
}

test('temporary HTTP503 in actual pure completion retains a one-minute durable retry',async t=>{const f=await fixture(t);f.acquisitions.beginStart({attemptId:f.attemptId,hash:f.hash,manifestDigest:'b'.repeat(64),nowMs:205});const moves=openPureMoveLedger(f.dbPath),q=openCompletionQueue(f.dbPath,{pureMode:true});f.onCleanup(()=>{q.close();moves.close()});let reads=0;const options={requests:f.requests,acquisitions:f.acquisitions,pureMoves:moves,attemptId:f.attemptId,stagingHostPath:path.join(f.root,'stage'),qbitStagingRoot:'/Downloads/negev',holdingRoot:path.join(f.root,'holding'),importRoot:path.join(f.root,'import'),qbittorrent:f.options.qbittorrent,verifyStagingRoot:f.options.verifyStagingRoot,verifyHandoffMounts:async()=>({state:'mounted_handoff_roots'}),fetchImpl:async()=>{reads++;return new Response('',{status:503})}};const w=createCompletionWorker({queue:q,now:()=>f.clock,processAttempt:()=>processPureCompletedAttempt({...options,nowMs:f.clock})});const result=await w.runOnce();const saved=q.getResult(f.attemptId);assert.equal(saved.reason,'provider_http_error');assert.equal(saved.nextDueMs,f.clock+60000);console.log(JSON.stringify({finding:'completion-provider-retry',result,saved,reads}));});
for (const reason of ['provider_http_error','provider_timeout','provider_transport',
  'provider_invalid_response','provider_unavailable','torrent_unavailable_after_stop',
  'stop_outcome_unknown']) test(`legacy ${reason} delay migrates and remains one minute after repeated retries/reopen`, async t => {
  const f = await fixture(t);
  f.acquisitions.beginStart({attemptId:f.attemptId,hash:f.hash,manifestDigest:'b'.repeat(64),nowMs:205});
  const moves=openPureMoveLedger(f.dbPath);let q=openCompletionQueue(f.dbPath,{pureMode:true});
  f.onCleanup(()=>{q.close();moves.close()});
  let claim=q.claimNext({nowMs:1000});q.recordResult({attemptId:claim.attemptId,pass:claim.pass,state:'held',reason,checkedMs:1000});q.close();
  // Actual older writer's persisted policy, without fabricating an import outcome.
  const db=new DatabaseSync(f.dbPath);db.prepare('UPDATE pure_move_completion_checks SET next_due_ms=1801000 WHERE attempt_id=?').run(f.attemptId);db.close();
  q=openCompletionQueue(f.dbPath,{pureMode:true});assert.equal(q.getResult(f.attemptId).nextDueMs,61000);
  for(let n=0;n<4;n++){
    const nowMs=61000+n*60000;claim=q.claimNext({nowMs});if(claim.state==='pass_complete')claim=q.claimNext({nowMs});
    assert.equal(claim.attemptId,f.attemptId);
    q.recordResult({attemptId:claim.attemptId,pass:claim.pass,state:'held',reason,checkedMs:nowMs});
    assert.equal(q.getResult(f.attemptId).nextDueMs,nowMs+60000);
    q.close();q=openCompletionQueue(f.dbPath,{pureMode:true});
    assert.equal(q.getResult(f.attemptId).nextDueMs,nowMs+60000);
  }
});

test('temporary failure clears through actual torrent observations when the provider recovers',async t=>{
 const f=await fixture(t);f.acquisitions.beginStart({attemptId:f.attemptId,hash:f.hash,manifestDigest:'b'.repeat(64),nowMs:205});
 const moves=openPureMoveLedger(f.dbPath),q=openCompletionQueue(f.dbPath,{pureMode:true});f.onCleanup(()=>{q.close();moves.close()});
 let failed=true,reads=0;
 const w=createCompletionWorker({queue:q,now:()=>f.clock,processAttempt:()=>processPureCompletedAttempt({requests:f.requests,acquisitions:f.acquisitions,pureMoves:moves,attemptId:f.attemptId,nowMs:f.clock,stagingHostPath:path.join(f.root,'stage'),qbitStagingRoot:'/Downloads/negev',holdingRoot:path.join(f.root,'holding'),importRoot:path.join(f.root,'import'),qbittorrent:f.options.qbittorrent,verifyStagingRoot:f.options.verifyStagingRoot,verifyHandoffMounts:async()=>({state:'mounted_handoff_roots'}),fetchImpl:async(...args)=>{reads++;return failed?new Response('',{status:503}):f.fetchGood(...args)}})});
 await w.runOnce();assert.equal(q.getResult(f.attemptId).reason,'provider_http_error');
 failed=false;f.clock=61000;let result=await w.runOnce();if(result.state==='pass_complete')result=await w.runOnce();
 assert.equal(result.result.reason,'incomplete');assert.equal(q.getResult(f.attemptId).reason,'incomplete');assert.equal(reads,7);
 assert.equal(f.starts,0);
});

test('ownership, changed manifest and unresolved claim are not expedited by provider migration',async t=>{
 const f=await fixture(t);f.acquisitions.beginStart({attemptId:f.attemptId,hash:f.hash,manifestDigest:'b'.repeat(64),nowMs:205});
 const moves=openPureMoveLedger(f.dbPath);let q=openCompletionQueue(f.dbPath,{pureMode:true});f.onCleanup(()=>{q.close();moves.close()});
 for(const reason of ['wrong_torrent_owner','manifest_changed','storage_path_changed']){
  let claim=q.claimNext({nowMs:f.clock});if(claim.state==='pass_complete')claim=q.claimNext({nowMs:f.clock});
  q.recordResult({attemptId:claim.attemptId,pass:claim.pass,state:'held',reason,checkedMs:f.clock});
  const due=f.clock+1800000;q.close();q=openCompletionQueue(f.dbPath,{pureMode:true});assert.equal(q.getResult(f.attemptId).nextDueMs,due);f.clock=due;
 }
 let claim=q.claimNext({nowMs:f.clock});if(claim.state==='pass_complete')claim=q.claimNext({nowMs:f.clock});
 q.close();q=openCompletionQueue(f.dbPath,{pureMode:true});assert.equal(q.getResult(f.attemptId).state,null);
});
