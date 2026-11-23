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

for(const failure of ['503','timeout','transport','invalid-json'])test('temporary start read recovers without duplicate start across reopen: '+failure,async t=>{
 const f=await fixture(t);let broken=true,reads=0;
 const processAttempt=()=>processRecordedStart({...f.options,now:()=>f.clock,fetchImpl:async(...args)=>{reads++;if(!broken)return f.fetchGood(...args);if(failure==='503')return new Response('',{status:503});if(failure==='invalid-json')return new Response('{');throw Object.assign(new Error('synthetic'),{name:failure==='timeout'?'TimeoutError':'Error'});}});
 for(let i=0;i<3;i++){const worker=createStartWorker({queue:f.queue,processAttempt,now:()=>f.clock});const r=await worker.runOnce();assert.equal(r.result.reason,'provider_unavailable');assert.equal(f.acquisitions.getStart(f.attemptId),null);assert.equal(f.queue.getResult(f.attemptId).nextDueMs,f.clock+60000);f.clock+=60000;f.reopen();}
 broken=false;const worker=createStartWorker({queue:f.queue,processAttempt,now:()=>f.clock});assert.equal((await worker.runOnce()).result.state,'start_unknown');assert.equal(f.starts,1);f.reopen();assert.equal((await createStartWorker({queue:f.queue,processAttempt,now:()=>f.clock}).runOnce()).state,'idle');assert.equal(f.starts,1);assert.ok(reads>3);
});

test('upgrade recovers legacy permanent provider hold and one old season mismatch, preserving unrelated holds and sent intent',async t=>{
 const f=await fixture(t);const claim=f.queue.claimNext({nowMs:1000});f.queue.recordResult({...claim,state:'held',reason:'provider_unavailable',checkedMs:1000});
 const d=new DatabaseSync(f.dbPath);f.onCleanup(()=>d.close());d.prepare("UPDATE start_checks SET version=2,next_due_ms=NULL WHERE attempt_id=?").run(f.attemptId);d.exec('ALTER TABLE start_checks DROP COLUMN title_policy_revision');f.reopen();assert.equal(f.queue.getResult(f.attemptId).nextDueMs,61000);
 const columns=d.prepare('PRAGMA table_info(start_checks)').all().map(c=>c.name);assert.ok(columns.includes('title_policy_revision'));
 d.prepare("UPDATE start_checks SET reason='related_installment_mismatch',title_policy_revision=0,next_due_ms=NULL WHERE attempt_id=?").run(f.attemptId);f.reopen();assert.equal(f.queue.getResult(f.attemptId).nextDueMs,61000);
 d.prepare("UPDATE start_checks SET next_due_ms=NULL WHERE attempt_id=?").run(f.attemptId);f.reopen();assert.equal(f.queue.getResult(f.attemptId).nextDueMs,null,'current genuine mismatch must not be endlessly rearmed by reopen');
 d.prepare("UPDATE start_checks SET reason='incomplete_path_outside_staging',next_due_ms=NULL WHERE attempt_id=?").run(f.attemptId);f.reopen();assert.equal(f.queue.getResult(f.attemptId).nextDueMs,null);
 f.acquisitions.beginStart({attemptId:f.attemptId,hash:f.hash,manifestDigest:'b'.repeat(64),nowMs:2000});d.prepare("UPDATE start_checks SET reason='provider_unavailable',next_due_ms=NULL WHERE attempt_id=?").run(f.attemptId);f.reopen();assert.equal(f.queue.claimNext({nowMs:100000}).state,'idle');
});

test('actual pure completion worker retries a finishing-between-reads transition promptly, then prepares exact files',async t=>{
 const f=await fixture(t);f.acquisitions.beginStart({attemptId:f.attemptId,hash:f.hash,manifestDigest:'b'.repeat(64),nowMs:205});const moves=openPureMoveLedger(f.dbPath);let queue=openCompletionQueue(f.dbPath,{pureMode:true});f.onCleanup(()=>{queue.close();moves.close()});let info=0,writes=0,stopped=false;
 const stagingHostPath=path.join(f.root,'stage'),holdingRoot=path.join(f.root,'holding'),importRoot=path.join(f.root,'import');await mkdir(path.join(stagingHostPath,f.hash),{recursive:true});await mkdir(holdingRoot);await mkdir(importRoot);await writeFile(path.join(stagingHostPath,f.hash,f.name),Buffer.alloc(1000));
 const fetchImpl=async(url,init={})=>{const endpoint=new URL(url).pathname;if(init.method!=='GET'){assert.ok(endpoint.endsWith('/stop'));writes++;stopped=true;return new Response('');}if(endpoint.endsWith('/info')){info++;return Response.json([{hash:f.hash,category:'negev',save_path:f.savePath,state:stopped?'stoppedUP':info===1?'downloading':'uploading',progress:info===1?0.99:1,amount_left:info===1?10:0,auto_tmm:false,force_start:false}]);}if(endpoint.endsWith('/properties'))return Response.json({save_path:f.savePath,download_path:''});if(endpoint.endsWith('/files'))return Response.json([{index:0,name:f.name,size:1000,priority:1,progress:info===1?0.99:1,is_seed:info>1}]);throw Error('Unexpected endpoint')};
 const worker=()=>createCompletionWorker({queue,now:()=>f.clock,processAttempt:()=>processPureCompletedAttempt({...f.options,pureMoves:moves,nowMs:f.clock,stagingHostPath,holdingRoot,importRoot,verifyHandoffMounts:async()=>({state:'mounted_handoff_roots'}),fetchImpl})});
 const first=await worker().runOnce();assert.equal(first.result.reason,'completion_transition');assert.equal(queue.getResult(f.attemptId).nextDueMs,f.clock+60000);assert.equal(writes,0);assert.equal(moves.getIntent(f.attemptId),null);assert.equal((await stat(path.join(stagingHostPath,f.hash,f.name))).size,1000);
 queue.close();queue=openCompletionQueue(f.dbPath,{pureMode:true});f.clock+=60000;let second;for(let i=0;i<3;i++){second=await worker().runOnce();if(second.state==='processed')break;}assert.equal(second.result.state,'handoff_prepared',JSON.stringify(second));assert.equal(writes,1);assert.equal(moves.getIntent(f.attemptId).status,'prepared');
});

test('actual start still rejects an explicit wrong season before downloader reads',async t=>{
 const f=await fixture(t);const d=new DatabaseSync(f.dbPath);f.onCleanup(()=>d.close());
 d.prepare('UPDATE acquisition_file_plans SET file_name=? WHERE attempt_id=?').run('Example Second Season S01E01.mkv',f.attemptId);let reads=0;
 const r=await processRecordedStart({...f.options,now:()=>f.clock,loadDetail:async()=>({state:'details',anidbId:42,kind:'series',title:'Example Season 2'}),releaseQueries:async()=>['Example Second Season'],readRelatedTitles:async()=>({state:'related_titles',anidbId:42,items:[]}),fetchImpl:async()=>{reads++;throw Error('must not read downloader')}});
 assert.equal(r.reason,'related_installment_mismatch');assert.equal(reads,0);assert.equal(f.acquisitions.getStart(f.attemptId),null);
});

test('pure queue upgrade wakes legacy completion-race delay without changing legacy handoff queue',async t=>{
 const f=await fixture(t);f.acquisitions.beginStart({attemptId:f.attemptId,hash:f.hash,manifestDigest:'b'.repeat(64),nowMs:205});const moves=openPureMoveLedger(f.dbPath),handoffs=openHandoffLedger(f.dbPath),legacy=openCompletionQueue(f.dbPath);let q=openCompletionQueue(f.dbPath,{pureMode:true});const d=new DatabaseSync(f.dbPath);f.onCleanup(()=>{d.close();q.close();legacy.close();handoffs.close();moves.close()});const old=legacy.claimNext({nowMs:1000});legacy.recordResult({...old,state:'held',reason:'torrent_changed',checkedMs:1000});
 const claim=q.claimNext({nowMs:1000});q.recordResult({...claim,state:'held',reason:'torrent_changed',checkedMs:1000});d.prepare('UPDATE pure_move_completion_checks SET next_due_ms=1801000 WHERE attempt_id=?').run(f.attemptId);q.close();q=openCompletionQueue(f.dbPath,{pureMode:true});assert.equal(q.getResult(f.attemptId).nextDueMs,61000);assert.equal(legacy.getResult(f.attemptId).nextDueMs,1801000);
});

test('legacy terminal storage check is reobserved once through actual guards, preserving intent exclusion',async t=>{
 const f=await fixture(t);for(let i=0;i<2;i++){const claim=f.queue.claimNext({nowMs:f.clock});f.queue.recordResult({...claim,state:'held',reason:'storage_path_unverified',checkedMs:f.clock});if(i===0)f.clock=f.queue.getResult(f.attemptId).nextDueMs;}
 assert.equal(f.queue.getResult(f.attemptId).nextDueMs,null);const d=new DatabaseSync(f.dbPath);f.onCleanup(()=>d.close());if(d.prepare('pragma table_info(start_checks)').all().some(c=>c.name==='storage_policy_revision'))d.exec('ALTER TABLE start_checks DROP COLUMN storage_policy_revision');
 f.reopen();assert.equal(f.queue.getResult(f.attemptId).nextDueMs,f.clock+60000);f.clock+=60000;
 const result=await createStartWorker({queue:f.queue,now:()=>f.clock,processAttempt:()=>processRecordedStart({...f.options,now:()=>f.clock,fetchImpl:f.fetchGood})}).runOnce();assert.equal(result.result.state,'start_unknown');assert.equal(f.starts,1);f.reopen();assert.equal((await createStartWorker({queue:f.queue,now:()=>f.clock+999999,processAttempt:()=>{throw Error('intent must not replay')}}).runOnce()).state,'idle');assert.equal(f.starts,1);
});

test('migrated legacy storage uncertainty keeps real mismatches held and does not rearm across restarts',async t=>{
 const f=await fixture(t);const claim=f.queue.claimNext({nowMs:f.clock});f.queue.recordResult({...claim,state:'held',reason:'storage_path_unverified',checkedMs:f.clock});const d=new DatabaseSync(f.dbPath);f.onCleanup(()=>d.close());d.prepare('UPDATE start_checks SET version=2,next_due_ms=NULL WHERE attempt_id=?').run(f.attemptId);if(d.prepare('pragma table_info(start_checks)').all().some(c=>c.name==='storage_policy_revision'))d.exec('ALTER TABLE start_checks DROP COLUMN storage_policy_revision');f.reopen();f.clock+=60000;
 const bad=async(url,init)=>new URL(url).pathname.endsWith('/properties')?Response.json({save_path:'/Downloads/wrong',download_path:''}):f.fetchGood(url,init);
 const r=await createStartWorker({queue:f.queue,now:()=>f.clock,processAttempt:()=>processRecordedStart({...f.options,now:()=>f.clock,fetchImpl:bad})}).runOnce();assert.equal(r.state,'processed');assert.equal(r.result.state,'held');assert.equal(f.starts,0);assert.equal(f.queue.getResult(f.attemptId).nextDueMs,null);for(let i=0;i<2;i++){f.reopen();assert.equal(f.queue.getResult(f.attemptId).nextDueMs,null);assert.equal(f.queue.claimNext({nowMs:f.clock+9999999}).state,'idle');}
});
