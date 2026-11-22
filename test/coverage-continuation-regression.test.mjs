import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {openAcquisitionLedger} from '../src/acquisition/acquisition-ledger.mjs';
import {openAcquisitionRequestQueue,createAcquisitionPageWorker} from '../src/acquisition/acquisition-request-queue.mjs';
import {createAcquisitionRequestProcessor} from '../src/acquisition/acquisition-request-processor.mjs';
import {verifyCachedPositiveCoverage} from '../src/acquisition/verify-cached-positive-coverage.mjs';
import {createPipelineScheduler} from '../src/acquisition/acquisition-pipeline-scheduler.mjs';

async function fixture(t,count){
 const root=await mkdtemp(path.join(tmpdir(),'negev-coverage-continuation-')),dbPath=path.join(root,'db.sqlite');
 const requests=openRequestLedger(dbPath),acquisitions=openAcquisitionLedger(dbPath),cleanups=[];
 const ids=Array.from({length:count},(_,i)=>1001+i),requestId=requests.submit({requesterId:1,requestKey:'desired-completed',nowMs:100,intent:{state:'ready',title:'Example',anidbId:42,kind:'series',monitorFuture:false,episodeIds:ids}}).requestId;
 let queue=openAcquisitionRequestQueue(dbPath),memo=new Map(),clock=1000;const reads=[],searches=[];
 t.after(async()=>{for(const f of cleanups)await f();queue.close();acquisitions.close();requests.close();await rm(root,{recursive:true,force:true})});
 const processor=createAcquisitionRequestProcessor({readRequest:id=>requests.getRequest(id),now:()=>clock,
  discoverCandidates:async input=>{searches.push(input);throw Error('all episodes already exist; search is forbidden')},previewCandidate:async()=>{throw Error('no preview')},loadDetail:async()=>null,submitCandidate:async()=>{throw Error('no download')},
  readPublicCoverage:request=>verifyCachedPositiveCoverage({request,cached:{targetCount:count,verifiedTargets:count,availableEpisodeIds:ids},cache:memo,now:()=>clock,readRevision:()=>0,
   readShoko:async({episodeId})=>{reads.push(episodeId);return {state:'ok',complete:true,files:[{fileId:episodeId}]}},readPublic:async()=>({state:'available'})})});
 return {dbPath,requestId,reads,searches,ids,cleanup:f=>cleanups.push(f),get clock(){return clock},set clock(v){clock=v},get queue(){return queue},reopen({cold=false}={}){queue.close();queue=openAcquisitionRequestQueue(dbPath);if(cold)memo=new Map()},worker:()=>createAcquisitionPageWorker({queue,processRequest:processor,now:()=>clock,limit:1})};
}

for(const count of [24,26,220])test('actual request queue/worker/scheduler finishes bounded '+count+'-episode coverage before proof expiry',async t=>{
 const f=await fixture(t,count),timers=new Map();let sequence=0,completions=0;
 const scheduler=createPipelineScheduler({now:()=>f.clock,setTimer:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id},clearTimer:id=>timers.delete(id),
  pipeline:{initialize:async()=>({state:'reconciled'}),close:()=>{},listMetadataRetries:()=>f.queue.listMetadataRetries({nowMs:f.clock}),tickCompletions:async()=>{completions++;return {state:'idle'}},tickPublish:async()=>({state:'idle'}),tickStarts:async()=>({state:'idle'}),tickRequests:options=>f.worker().runOnce(options)}});
 f.cleanup(()=>scheduler.stop());await scheduler.start();
 for(let i=0;i<400&&f.queue.getResult(f.requestId)?.reason!=='request_fully_available';i++){
  assert.ok(timers.size);const [id,timer]=timers.entries().next().value;timers.delete(id);f.clock+=timer.ms;
  if(f.clock>=300000)break;await timer.fn();await new Promise(setImmediate);
 }
 const result=f.queue.getResult(f.requestId);assert.equal(result?.reason,'request_fully_available',JSON.stringify({clock:f.clock,result,reads:f.reads.length}));
 assert.ok(f.clock<300000);assert.equal(f.reads.length,count);assert.equal(new Set(f.reads).size,count);assert.equal(f.searches.length,0);assert.ok(completions>0);
});

test('unfinished coverage survives durable queue reopen and cold memo without recreating the request',async t=>{
 const f=await fixture(t,26);const first=await f.worker().runOnce({priorityRequestId:f.requestId});assert.equal(first.results[0].reason,'availability_check_pending');assert.equal(f.queue.getResult(f.requestId).nextDueMs,f.clock+1000);
 f.reopen({cold:true});f.clock+=1000;await f.worker().runOnce({priorityRequestId:f.requestId});f.clock=f.queue.getResult(f.requestId).nextDueMs;
 await f.worker().runOnce({priorityRequestId:f.requestId});assert.equal(f.queue.getResult(f.requestId).reason,'request_fully_available');assert.equal(f.searches.length,0);assert.equal(f.reads.length,42);
});

test('upgrade brings old generic availability delays forward without changing unrelated search delays',async t=>{
 const f=await fixture(t,24);const claim=f.queue.claimNext({nowMs:f.clock,priorityRequestId:f.requestId});f.queue.recordResult({...claim,state:'held',reason:'availability_unverified',checkedMs:f.clock});
 const d=new DatabaseSync(f.dbPath);f.cleanup(()=>d.close());d.prepare('UPDATE acquisition_request_checks SET next_due_ms=? WHERE request_id=?').run(f.clock+1800000,f.requestId);
 d.exec('ALTER TABLE acquisition_request_checks DROP COLUMN coverage_policy_revision');f.reopen();assert.equal(f.queue.getResult(f.requestId).nextDueMs,f.clock+60000);
 d.prepare('UPDATE acquisition_request_checks SET next_due_ms=? WHERE request_id=?').run(f.clock+1800000,f.requestId);f.reopen();assert.equal(f.queue.getResult(f.requestId).nextDueMs,f.clock+1800000,'fresh genuine uncertainty is not rearmed by every reopen');
 d.prepare("UPDATE acquisition_request_checks SET reason='no_safe_release',next_due_ms=? WHERE request_id=?").run(f.clock+1800000,f.requestId);f.reopen();assert.equal(f.queue.getResult(f.requestId).nextDueMs,f.clock+1800000);
});
