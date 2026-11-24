import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {openAcquisitionLedger} from '../src/acquisition/acquisition-ledger.mjs';
import {openPureMoveLedger} from '../src/acquisition/pure-move-ledger.mjs';
import {openCompletionQueue} from '../src/acquisition/completion-queue.mjs';
import {openRequestProgress} from '../src/requests/request-progress.mjs';
async function fixture(t,episodeIds=[1001]){
 const dir=await mkdtemp(path.join(tmpdir(),'negev-long-history-')),dbPath=path.join(dir,'db.sqlite');
 const requests=openRequestLedger(dbPath),saved=requests.submit({requesterId:1,requestKey:'desired',nowMs:100,intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:false,episodeIds}});
 const acquisitions=openAcquisitionLedger(dbPath),moves=openPureMoveLedger(dbPath);let seq=0,time=200;
 const cleanups=[];t.after(async()=>{for(const close of cleanups.reverse())close();moves.close();acquisitions.close();requests.close();await rm(dir,{recursive:true,force:true})});
 const reserve=(episodeId=1001)=>{const candidate={indexerId:7,guid:'candidate-'+(++seq)};const reserved=acquisitions.reserve({requestId:saved.requestId,candidate,episodeIds:[episodeId],nowMs:time++});assert.equal(reserved.state,'reserved');return {id:reserved.attemptId,candidate}};
 const release=()=>{const a=reserve();assert.equal(acquisitions.releaseReserved({attemptId:a.id,nowMs:time++}).state,'released_pre_dispatch')};
 const start=episodeId=>{const a=reserve(episodeId),hash=a.id.toString(16).padStart(40,'0');acquisitions.bindPreparedTorrent({attemptId:a.id,candidate:a.candidate,hash,nowMs:time++});acquisitions.beginDispatch({attemptId:a.id,nowMs:time++});acquisitions.recordTorrent({attemptId:a.id,hash,nowMs:time++});acquisitions.beginStart({attemptId:a.id,hash,manifestDigest:'c'.repeat(64),nowMs:time++});return {...a,hash}};
 return {dbPath,requestId:saved.requestId,requests,acquisitions,reserve,release,start,cleanup:fn=>cleanups.push(fn)};
}
test('150 retained released attempts do not hide current measured transfer, including reopen',async t=>{
 const f=await fixture(t);for(let i=0;i<150;i++)f.release();const current=f.start(1001);
 const completion=openCompletionQueue(f.dbPath,{pureMode:true});f.cleanup(()=>completion.close());
 const claim=completion.claimNext({nowMs:10000});assert.equal(claim.attemptId,current.id);
 completion.recordResult({...claim,state:'held',reason:'incomplete',checkedMs:10000,transfer:{progressBasisPoints:3750,etaSeconds:120,speedBytesPerSecond:500000,transferState:'active'}});
 let progress=openRequestProgress(f.dbPath,{pureMode:true,now:()=>11000});
 try{const p=progress.read(f.requestId);assert.equal(p.state,'download_unverified');assert.equal(p.activeAttempts,1);assert.equal(p.transfer.progressBasisPoints,3750)}finally{progress.close()}
 progress=openRequestProgress(f.dbPath,{pureMode:true,now:()=>11000});try{assert.equal(progress.read(f.requestId).transfer.progressBasisPoints,3750)}finally{progress.close()}
 const db=new DatabaseSync(f.dbPath,{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) n FROM acquisition_attempts').get().n,151);assert.equal(db.prepare('SELECT COUNT(*) n FROM acquisition_releases').get().n,150)}finally{db.close()}
});
test('history aggregation retains unresolved rejection review beside a later live download',async t=>{
 const f=await fixture(t,[1001,1002]);for(let i=0;i<120;i++)f.release();const rejected=f.start(1001);
 assert.equal(f.acquisitions.recordTerminalRejection({attemptId:rejected.id,hash:rejected.hash,reason:'file_wrong_identity',nowMs:10000}).state,'rejected_held');
 f.start(1002);const p=openRequestProgress(f.dbPath,{pureMode:true});try{const result=p.read(f.requestId);assert.equal(result.state,'review_needed');assert.equal(result.reviewRequired,true);assert.equal(result.activeAttempts,1)}finally{p.close()}
});
test('more than 100 genuinely active attempts remain representable without fetching retained history',async t=>{
 const ids=Array.from({length:150},(_,i)=>1001+i),f=await fixture(t,ids);for(const id of ids)f.reserve(id);
 const p=openRequestProgress(f.dbPath,{pureMode:true});try{const result=p.read(f.requestId);assert.equal(result.state,'release_preparing');assert.equal(result.activeAttempts,150);assert.equal(result.targetCount,150)}finally{p.close()}
});
test('existing ledgers gain an idempotent request index used by the actual progress query',async t=>{
 const f=await fixture(t);f.release();const db=new DatabaseSync(f.dbPath);
 try{db.exec('DROP INDEX IF EXISTS acquisition_attempts_by_request');const reopened=openAcquisitionLedger(f.dbPath);reopened.close();
 assert.ok(db.prepare('PRAGMA index_list(acquisition_attempts)').all().some(x=>x.name==='acquisition_attempts_by_request'),'request index is migrated');
 const statements=[],original=DatabaseSync.prototype.prepare;let progress;
 try{DatabaseSync.prototype.prepare=function(sql){statements.push(sql);return original.call(this,sql)};progress=openRequestProgress(f.dbPath,{pureMode:true})}finally{DatabaseSync.prototype.prepare=original}
 try{const query=statements.find(sql=>sql.includes('FROM acquisition_attempts a')&&sql.includes('claimed_count'));assert.ok(query,'capture real progress query');const parameters=[JSON.stringify([]),f.requestId];const plan=db.prepare('EXPLAIN QUERY PLAN '+query).all(...parameters);assert.ok(plan.some(x=>/SEARCH a USING INDEX acquisition_attempts_by_request/.test(x.detail)),JSON.stringify(plan));assert.ok(!plan.some(x=>/SCAN a\b/.test(x.detail)),JSON.stringify(plan))}finally{progress.close()}
 }finally{db.close()}
});

test('actual progress query keeps the same result with 10000 unrelated historical rows and uses request lookup',async t=>{
 const f=await fixture(t);f.start(1001);
 const other=f.requests.submit({requesterId:2,requestKey:'other',nowMs:100,intent:{state:'ready',anidbId:43,kind:'series',monitorFuture:false,episodeIds:[2001]}});
 const db=new DatabaseSync(f.dbPath);let progress;const statements=[],original=DatabaseSync.prototype.prepare;
 try{
  db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
    INSERT INTO acquisition_attempts(request_id,anidb_id,indexer_id,candidate_digest,status,created_ms,updated_ms)
    SELECT ?,43,9000,printf('%064x',x),'reserved',200,200 FROM n`).run(other.requestId);
  try{DatabaseSync.prototype.prepare=function(sql){statements.push(sql);return original.call(this,sql)};progress=openRequestProgress(f.dbPath,{pureMode:true})}finally{DatabaseSync.prototype.prepare=original}
  const sql=statements.find(x=>x.includes('FROM acquisition_attempts a')&&x.includes('claimed_count')),params=[JSON.stringify([]),f.requestId];
  const indexedPlan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(...params);
  assert.ok(indexedPlan.some(x=>/SEARCH a USING INDEX acquisition_attempts_by_request/.test(x.detail)),JSON.stringify(indexedPlan));
  assert.ok(!indexedPlan.some(x=>/USE TEMP B-TREE FOR ORDER BY/.test(x.detail)),JSON.stringify(indexedPlan));
  const indexed=db.prepare(sql);let expected;const before=performance.now();for(let i=0;i<30;i++)expected=indexed.get(...params);const indexedMs=performance.now()-before;
  db.exec('DROP INDEX acquisition_attempts_by_request');
  const scanPlan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(...params);assert.ok(scanPlan.some(x=>/SCAN a\b/.test(x.detail)),JSON.stringify(scanPlan));
  const scan=db.prepare(sql),start=performance.now();let actual;for(let i=0;i<30;i++)actual=scan.get(...params);const scanMs=performance.now()-start;
  assert.deepEqual(actual,expected);assert.equal(actual.active_count,1);
  const reopened=openAcquisitionLedger(f.dbPath);reopened.close();assert.equal(progress.read(f.requestId).activeAttempts,1);
  t.diagnostic(`Synthetic 10000-row history,30 reads: indexed=${indexedMs.toFixed(2)}ms scan=${scanMs.toFixed(2)}ms; timing is diagnostic only`);
 }finally{progress?.close();db.close()}
});

test('identity-check status aggregates more than100 current checks without a second row cap',async t=>{
 const ids=Array.from({length:105},(_,i)=>1001+i),f=await fixture(t,ids);for(const id of ids)f.start(id);
 const completions=openCompletionQueue(f.dbPath,{pureMode:true});f.cleanup(()=>completions.close());
 for(let i=0;i<ids.length;i++){const claim=completions.claimNext({nowMs:10000});assert.equal(claim.state,'claimed');completions.recordResult({...claim,state:'held',reason:'file_lookup_inconclusive',checkedMs:10000})}
 const p=openRequestProgress(f.dbPath,{pureMode:true});try{assert.equal(p.read(f.requestId).state,'release_identity_unverified')}finally{p.close()}
});
