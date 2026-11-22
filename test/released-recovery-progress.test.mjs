import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {openAcquisitionLedger} from '../src/acquisition/acquisition-ledger.mjs';
import {openPureMoveLedger} from '../src/acquisition/pure-move-ledger.mjs';
import {openRecognitionRecoveryLedger} from '../src/acquisition/recognition-recovery-ledger.mjs';
import {openAcquisitionRequestQueue} from '../src/acquisition/acquisition-request-queue.mjs';
import {openCompletionQueue} from '../src/acquisition/completion-queue.mjs';
import {openRequestProgress} from '../src/requests/request-progress.mjs';
import {requestPresentation} from '../src/web/public/request-progress-text.mjs';

async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'negev-released-status-')),dbPath=path.join(root,'state.sqlite');
 const requests=openRequestLedger(dbPath),acquisitions=openAcquisitionLedger(dbPath),moves=openPureMoveLedger(dbPath),queue=openAcquisitionRequestQueue(dbPath);
 const requestId=requests.submit({requesterId:1,requestKey:'desired',nowMs:100,intent:{state:'ready',title:'Example',anidbId:42,kind:'series',monitorFuture:true,episodeIds:[1001,1002]}}).requestId;
 const cleanups=[];let progress=openRequestProgress(dbPath,{pureMode:true,now:()=>700000});
 t.after(async()=>{for(const close of cleanups)close();progress.close();queue.close();moves.close();acquisitions.close();requests.close();await rm(root,{recursive:true,force:true})});
 const reserve=(guid,hash)=>{const candidate={indexerId:1,guid};const id=acquisitions.reserve({requestId,candidate,episodeIds:[1001],nowMs:200}).attemptId;acquisitions.bindPreparedTorrent({attemptId:id,candidate,hash,nowMs:201});acquisitions.recordFilePlan({attemptId:id,hash,plannedFiles:[{name:'Example - 01.mkv',size:1000,episodeIds:[1001]}],nowMs:202});acquisitions.beginDispatch({attemptId:id,nowMs:203});acquisitions.recordTorrent({attemptId:id,hash,nowMs:204});acquisitions.beginStart({attemptId:id,hash,manifestDigest:'c'.repeat(64),nowMs:205});return id};
 const attemptId=reserve('first','a'.repeat(40));
 const release=()=>{const hash='a'.repeat(40);moves.recordIntent({attemptId,torrentHash:hash,stagingRoot:path.join(root,'staging',hash),holdingPath:path.join(root,'holding',`negev-${attemptId}-${hash.slice(0,16)}`),files:[{name:'Example - 01.mkv',size:1000,episodeIds:[1001],dev:'1',ino:'2',mtimeNs:'3'}],nowMs:206});moves.markPrepared({attemptId,nowMs:207});moves.beginPublish({attemptId,nowMs:208});moves.markPublished({attemptId,nowMs:209});const recovery=openRecognitionRecoveryLedger(dbPath);cleanups.push(()=>recovery.close());recovery.recordFirstSeen({attemptId,fileId:81,nowMs:600000});recovery.beginPreserve({attemptId,fileId:81,nowMs:660000});recovery.markPreserved({attemptId,nowMs:660001});assert.equal(recovery.releaseForAlternate({attemptId,nowMs:660002}).state,'released');const claim=queue.claimNext({nowMs:660003,priorityRequestId:requestId});queue.recordResult({...claim,state:'held',reason:'no_safe_release',checkedMs:660003});return recovery};
 return {root,dbPath,requestId,attemptId,reserve,release,moves,acquisitions,cleanup:fn=>cleanups.push(fn),get progress(){return progress},reopen(){progress.close();progress=openRequestProgress(dbPath,{pureMode:true,now:()=>700000})}};
}

test('real preserved/released recovery is history, not a current download, including a late-opened ledger and restart',async t=>{
 const f=await fixture(t);assert.equal(f.progress.read(f.requestId).state,'download_unverified');const recovery=f.release();
 for(let i=0;i<2;i++){const p=f.progress.read(f.requestId,{availableEpisodeIds:[1002]});assert.equal(p.state,'saved');assert.equal(p.activeAttempts,0);assert.equal(p.waitingForRelease,true);assert.equal(p.transfer,undefined);const shown=requestPresentation({...p,publicAvailability:'verified_recently',publicVerifiedTargets:1},'series',{monitorFuture:true});assert.equal(shown.stage,'Partly available');assert.equal(shown.note,'Watching for a suitable release');assert.equal(recovery.get(f.attemptId).status,'released');assert.equal(f.acquisitions.getAttempt(f.attemptId).id,f.attemptId);f.reopen()}
});

test('an inactive historical claim without a recognition table cannot invent a download',async t=>{
 const f=await fixture(t);const d=new DatabaseSync(f.dbPath);f.cleanup(()=>d.close());d.prepare('UPDATE acquisition_target_claims SET active=0 WHERE attempt_id=?').run(f.attemptId);const p=f.progress.read(f.requestId);assert.equal(p.activeAttempts,0);assert.equal(p.state,'saved');assert.equal(p.completionChecking,undefined);
});

test('a genuine alternate retains its own measured progress while released history remains intact',async t=>{
 const f=await fixture(t);f.release();const id=f.reserve('alternate','b'.repeat(40));const completions=openCompletionQueue(f.dbPath,{pureMode:true});f.cleanup(()=>completions.close());const claim=completions.claimNext({nowMs:690000});assert.equal(claim.attemptId,id);completions.recordResult({...claim,state:'held',reason:'incomplete',checkedMs:690000,transfer:{progressBasisPoints:3750,etaSeconds:120,speedBytesPerSecond:2000000,transferState:'active'}});
 const p=f.progress.read(f.requestId,{availableEpisodeIds:[1002]});assert.equal(p.activeAttempts,1);assert.equal(p.state,'download_unverified');assert.equal(p.transfer.progressBasisPoints,3750);const shown=requestPresentation(p,'series',{nowMs:700000});assert.equal(shown.stage,'Downloading');assert.equal(shown.progressPercent,37.5);
});
