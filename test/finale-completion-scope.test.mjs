import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionRequestQueue, createAcquisitionPageWorker } from '../src/acquisition/acquisition-request-queue.mjs';
import { createAcquisitionRequestProcessor } from '../src/acquisition/acquisition-request-processor.mjs';
import { pollAiringWatches } from '../src/requests/airing-watch-poll.mjs';
import { openRequestProgress } from '../src/requests/request-progress.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openPureMoveLedger } from '../src/acquisition/pure-move-ledger.mjs';
import { readWorkerDiagnostics } from '../src/admin/worker-diagnostics.mjs';
import { createPipelineScheduler } from '../src/acquisition/acquisition-pipeline-scheduler.mjs';

const episode = n => ({ id: 1000+n, number: n, type: 'Episode', airDate: '2026-11-25' });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-finale-scope-'));
  const dbPath = path.join(root, 'negev.sqlite');
  let ledger = openRequestLedger(dbPath), queue = openAcquisitionRequestQueue(dbPath);
  const acquisitions = openAcquisitionLedger(dbPath), moves = openPureMoveLedger(dbPath);
  let clock = Date.UTC(2026,10,26), detail = { state:'details', complete:true,
    anidbId:42, title:'Example', kind:'series', restricted:false, page:1, nextPage:null,
    total:1, episodeCount:2, airDate:'2026-01-01', endDate:null, episodes:[episode(1)] };
  let available = [1001], duringCoverage = null, coverageUnavailable = false;
  const visits = [], submissions = [];
  const id = ledger.submit({ requesterId:1, requestKey:'desired', nowMs:clock,
    intent:{state:'ready',anidbId:42,title:'Example',kind:'series',episodeIds:[1001],monitorFuture:true} }).requestId;
  const candidate = {indexerId:7,guid:'finale',title:'Example - 02 1080p',size:1000,seeders:10,evidence:'unverified'};
  const processor = createAcquisitionRequestProcessor({
    readRequest:id=>ledger.getRequest(id),
    readPublicCoverage:async request=>{
      if (coverageUnavailable) throw new Error('temporary provider outage');
      if (duringCoverage) { const fn=duringCoverage; duringCoverage=null; await fn(); }
      const ids=request.episodeIds.filter(id=>available.includes(id));
      return {targetCount:request.episodeIds.length,verifiedTargets:ids.length,availableEpisodeIds:ids,uncertainEpisodeIds:[]};
    },
    discoverCandidates:async()=>{visits.push(clock);return{state:'candidates',requestId:id,anidbId:42,items:available.includes(1002)?[]:[candidate]}},
    loadDetail:async()=>detail,
    previewCandidate:async()=>({state:'preflight',requestId:id,anidbId:42,torrentHash:'a'.repeat(40),episodeIds:[1002],files:[{name:'Example - 02.mkv',size:1000,episodeIds:[1002]}]}),
    submitCandidate:async input=>{submissions.push(input);return{state:'stopped_observed',attemptId:91}},now:()=>clock
  });
  t.after(async()=>{queue.close();ledger.close();acquisitions.close();moves.close();await rm(root,{recursive:true,force:true});});
  const poll = async ({add=true,close=true}={})=>{
    detail={...detail,total:add?2:1,episodeCount:close?(add?2:1):3,
      endDate:close?'2026-11-25':null,episodes:add?[episode(1),episode(2)]:[episode(1)]};
    return pollAiringWatches({ledger,loadDetail:async()=>detail,today:'2026-11-26',nowMs:clock,intervalMs:0});
  };
  return {root,dbPath,id,visits,submissions,poll,
    get queue(){return queue},get ledger(){return ledger},get clock(){return clock},
    tick:n=>clock+=n,available:ids=>available=ids,
    failCoverage:value=>coverageUnavailable=value,
    duringCoverage:fn=>duringCoverage=fn,
    reopen:()=>{queue.close();ledger.close();ledger=openRequestLedger(dbPath);queue=openAcquisitionRequestQueue(dbPath)},
    run:(options={priorityRequestId:id})=>createAcquisitionPageWorker({queue,processRequest:processor,now:()=>clock,limit:1}).runOnce(options),
    progress:()=>{const p=openRequestProgress(dbPath,{pureMode:true});try{return p.read(id)}finally{p.close()}}
  };
}

for (const reopen of [false,true]) test(`normal final poll acquires the added finale with monitoring closed; restart=${reopen}`,async t=>{
  const x=await fixture(t);
  assert.equal((await x.run()).results[0].reason,'request_fully_available');
  x.tick(1000);const poll=await x.poll();assert.equal(poll.results[0].watchClosed,true);
  assert.deepEqual(poll.results[0].addedEpisodeIds,[1002]);
  if(reopen)x.reopen();
  assert.notEqual(x.progress().oneTimeAcquisitionComplete,true);
  assert.equal((await readWorkerDiagnostics({dataDir:x.root,nowMs:x.clock})).stages.acquisition.dueRetries,1);
  assert.equal(x.queue.listMetadataRetries({nowMs:x.clock})[0]?.nextDueMs,0);
  const next=await x.run();assert.equal(next.results[0]?.state,'stopped_observed',JSON.stringify(next));
  assert.deepEqual(x.submissions.map(s=>s.episodeIds),[[1002]]);
  assert.equal(x.ledger.getRequest(x.id).watchClosed,true);
  x.reopen();x.tick(60000);x.available([1001,1002]);
  assert.equal((await x.run()).results[0].reason,'request_fully_available');
  assert.equal(x.progress().oneTimeAcquisitionComplete,true);
  x.reopen();x.tick(86400000);assert.equal((await x.run()).results.length,0);
  assert.equal(x.queue.listMetadataRetries({nowMs:x.clock}).length,0);
  assert.equal(x.submissions.length,1);
});

test('closing an unchanged fully available scope remains settled',async t=>{
  const x=await fixture(t);await x.run();await x.poll({add:false});x.reopen();x.tick(86400000);
  assert.equal((await x.run()).results.length,0);assert.equal(x.progress().oneTimeAcquisitionComplete,true);
  assert.equal(x.queue.listMetadataRetries({nowMs:x.clock}).length,0);assert.equal(x.submissions.length,0);
});

test('scope added during coverage cannot be swallowed by the old result',async t=>{
  const x=await fixture(t);x.duringCoverage(()=>x.poll());
  assert.equal((await x.run()).results[0].reason,'request_fully_available');
  assert.notEqual(x.progress().oneTimeAcquisitionComplete,true);
  assert.equal(x.queue.listMetadataRetries({nowMs:x.clock})[0]?.nextDueMs,0);
  assert.equal((await x.run()).results[0]?.state,'stopped_observed');
});

test('equal target counts cannot make a changed episode inherit completion',async t=>{
  const x=await fixture(t);await x.run();await x.poll({add:false});
  const db=new DatabaseSync(x.dbPath);
  db.prepare('UPDATE targets SET episode_id=1002 WHERE anidb_id=42 AND episode_id=1001').run();db.close();
  x.reopen();assert.notEqual(x.progress().oneTimeAcquisitionComplete,true);
  assert.equal(x.queue.listMetadataRetries({nowMs:x.clock})[0]?.nextDueMs,0);
  assert.equal(x.queue.claimNext({nowMs:x.clock,priorityRequestId:x.id}).state,'claimed');
});

test('finale retry keeps its normal due time through restart and finishes once after provider recovery',async t=>{
  const x=await fixture(t);await x.run();await x.poll();x.failCoverage(true);
  assert.equal((await x.run()).results[0].reason,'availability_unverified');
  const due=x.queue.getResult(x.id).nextDueMs;assert.ok(due>x.clock);
  x.reopen();assert.equal((await x.run()).results.length,0);
  assert.equal(x.queue.listMetadataRetries({nowMs:x.clock})[0]?.nextDueMs,due);
  x.tick(due-x.clock);x.failCoverage(false);
  assert.equal((await x.run()).results[0].state,'stopped_observed');
  assert.equal(x.submissions.length,1);assert.equal(x.ledger.getRequest(x.id).watchClosed,true);
});

for(const restarted of [false,true])test(`actual scheduler sees final scope wake without a manual request tick; restarted=${restarted}`,async t=>{
  const x=await fixture(t);await x.run();let pending;
  const idle=async()=>({state:'idle'});
  const scheduler=createPipelineScheduler({pipeline:{initialize:async()=>({state:'reconciled'}),
    listMetadataRetries:()=>x.queue.listMetadataRetries({nowMs:x.clock}),
    tickRequests:options=>x.run(options),tickCompletions:idle,tickPublish:idle,tickStarts:idle,close:async()=>{}},
    now:()=>x.clock,setTimer:(callback,delay)=>{pending={callback,delay};return 1},clearTimer:()=>{pending=null}});
  if(!restarted)await scheduler.start();
  const poll=await x.poll();assert.equal(poll.results[0].watchClosed,true);
  if(restarted){x.reopen();await scheduler.start()}
  // The durable deadline refresh reaches the actual scheduler; duplicate RSS
  // wake notifications may prioritize it but must not create another grab.
  if(!restarted){scheduler.wakeRequest(x.id);scheduler.wakeRequest(x.id)}
  try{
    for(let i=0;i<4&&x.submissions.length===0;i++){assert.ok(pending);const job=pending;pending=null;x.tick(job.delay);await job.callback();await new Promise(resolve=>setImmediate(resolve));}
    assert.equal(x.submissions.length,1);assert.equal(x.ledger.getRequest(x.id).watchClosed,true);
  }finally{await scheduler.stop()}
});

test('actual v322 normal-writer finale fixture migrates and dispatches through the worker after restart',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'negev-v322-final-upgrade-')),dbPath=path.join(root,'negev.sqlite');
  const db=new DatabaseSync(dbPath);
  db.exec(await readFile(new URL('./fixtures/airing-finale-v0.0.322.sql',import.meta.url),'utf8'));db.close();
  let ledger=openRequestLedger(dbPath),queue=openAcquisitionRequestQueue(dbPath),submits=0;
  t.after(async()=>{queue.close();ledger.close();await rm(root,{recursive:true,force:true})});
  const initial=ledger.getRequest(1);assert.equal(initial.watchClosed,true);assert.deepEqual(initial.episodeIds,[1001,1002]);
  queue.close();ledger.close();ledger=openRequestLedger(dbPath);queue=openAcquisitionRequestQueue(dbPath);
  const clock=Date.UTC(2026,10,27);
  assert.equal(queue.listMetadataRetries({nowMs:clock})[0]?.nextDueMs,0);
  const processor=createAcquisitionRequestProcessor({readRequest:id=>ledger.getRequest(id),
    readPublicCoverage:async()=>({targetCount:2,verifiedTargets:1,availableEpisodeIds:[1001]}),
    discoverCandidates:async()=>({state:'candidates',requestId:1,anidbId:42,items:[{indexerId:7,guid:'finale',title:'Example - 02',size:1000,seeders:10,evidence:'unverified'}]}),
    loadDetail:async()=>({state:'details',complete:true,total:2,anidbId:42,title:'Example',kind:'series',restricted:false,episodes:[episode(1),episode(2)]}),
    previewCandidate:async()=>({state:'preflight',requestId:1,anidbId:42,torrentHash:'a'.repeat(40),episodeIds:[1002],files:[{name:'Example - 02.mkv',size:1000,episodeIds:[1002]}]}),
    submitCandidate:async input=>{assert.deepEqual(input.episodeIds,[1002]);submits++;return{state:'stopped_observed',attemptId:91}},now:()=>clock});
  const worker=createAcquisitionPageWorker({queue,processRequest:processor,now:()=>clock,limit:1});
  let result=await worker.runOnce();
  // Retain the old queue cursor: an ordinary pass wraps before revisiting id1.
  if(result.state==='pass_complete')result=await worker.runOnce();
  assert.equal(result.results[0]?.state,'stopped_observed',JSON.stringify(result));assert.equal(submits,1);assert.equal(ledger.getRequest(1).watchClosed,true);
});

for(const guard of ['suspended','cancelled','inflight'])test(`expanded finale preserves ${guard} guard`,async t=>{
  const x=await fixture(t);await x.run();
  if(guard==='suspended')assert.equal(x.queue.suspendUnstarted({requestId:x.id,reason:'owner_review',nowMs:x.clock}).state,'suspended');
  await x.poll();
  if(guard==='cancelled')assert.equal(x.ledger.cancelRequest({requesterId:1,requestId:x.id,nowMs:x.clock}).state,'cancelled');
  if(guard==='inflight')assert.equal(x.queue.claimNext({nowMs:x.clock,priorityRequestId:x.id}).state,'claimed');
  x.reopen();assert.equal((await x.run()).results.length,0);
  assert.equal(x.queue.listMetadataRetries({nowMs:x.clock}).length,0);
  if(guard==='suspended'){
    x.queue.resumeSuspended({requestId:x.id});assert.equal((await x.run()).results[0]?.state,'stopped_observed');
  }
});

for(const mode of ['unchanged','expanded','unknown','same_count'])test(`v322 scope migration ${mode} is durable and conservative`,async t=>{
  const x=await fixture(t);await x.run();await x.poll({add:mode==='expanded'});
  const db=new DatabaseSync(x.dbPath);
  // Frozen pre-fix schema: its only exact snapshot is the existing scan hash.
  if(db.prepare('PRAGMA table_info(acquisition_request_checks)').all().some(c=>c.name==='scan_targets_json'))db.exec('ALTER TABLE acquisition_request_checks DROP COLUMN scan_targets_json');
  if(mode==='unknown')db.exec('UPDATE acquisition_request_checks SET scan_scope=NULL');
  if(mode==='same_count')db.exec('UPDATE targets SET episode_id=1002');
  db.exec('UPDATE acquisition_request_checks SET next_due_ms=NULL');db.close();
  x.reopen();x.reopen();
  assert.equal(x.progress().oneTimeAcquisitionComplete===true,mode==='unchanged');
  const next=x.queue.listMetadataRetries({nowMs:x.clock});
  assert.equal(next.length,mode==='unchanged'?0:1);
  assert.equal(x.queue.claimNext({nowMs:x.clock,priorityRequestId:x.id}).state==='claimed',mode!=='unchanged');
});
