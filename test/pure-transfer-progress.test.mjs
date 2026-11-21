import test from'node:test';import assert from'node:assert/strict';
import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';
import{openRequestLedger}from'../src/requests/request-ledger.mjs';
import{openAcquisitionLedger}from'../src/acquisition/acquisition-ledger.mjs';
import{openPureMoveLedger}from'../src/acquisition/pure-move-ledger.mjs';
import{openHandoffLedger}from'../src/acquisition/handoff-ledger.mjs';
import{openCompletionQueue,createCompletionWorker}from'../src/acquisition/completion-queue.mjs';
import{createAcquisitionStageProcessors}from'../src/acquisition/acquisition-stage-processors.mjs';
import{openRequestProgress}from'../src/requests/request-progress.mjs';
import{requestPresentation}from'../src/web/public/request-progress-text.mjs';

async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'negev-pure-transfer-')),dbPath=path.join(root,'db.sqlite');
 const requests=openRequestLedger(dbPath),acquisitions=openAcquisitionLedger(dbPath),handoffs=openHandoffLedger(dbPath),pureMoves=openPureMoveLedger(dbPath);
 let queue=openCompletionQueue(dbPath,{pureMode:true}),clock=1000;
 const requestId=requests.submit({requesterId:1,requestKey:'desired',nowMs:100,intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:false,episodeIds:[99]}}).requestId;
 const hash='a'.repeat(40),savePath='/NegevPure/'+hash,candidate={guid:'r',indexerId:1};
 const attemptId=acquisitions.reserve({requestId,candidate,episodeIds:[99],preparedHash:hash,nowMs:101}).attemptId;
 acquisitions.bindPreparedTorrent({attemptId,candidate,hash,nowMs:102});acquisitions.recordFilePlan({attemptId,hash,plannedFiles:[{name:'01.mkv',size:1000,episodeIds:[99]}],nowMs:103});acquisitions.beginDispatch({attemptId,nowMs:104});acquisitions.recordTorrent({attemptId,hash,nowMs:105});acquisitions.beginStart({attemptId,hash,manifestDigest:'b'.repeat(64),nowMs:106});
 let state='downloading',fraction=.375,mode='ok',category='negev',pathOverride=null,posts=0;
 const fetchImpl=async(url,init)=>{
  const u=new URL(url);assert.equal(u.origin,'http://qbit.internal:8080');assert.equal(init.method,'GET','incomplete downloads must never be stopped or moved');
  assert.equal(u.searchParams.get(u.pathname.endsWith('/info')?'hashes':'hash'),hash);
  if(mode==='403'||mode==='renew'&&init.headers.Cookie==='SID=syntheticSID')return Response.json({}, {status:403});
  assert.equal(init.headers.Cookie,mode==='renew'?'SID=renewedSID':'SID=syntheticSID');
  if(u.pathname.endsWith('/info'))return Response.json([{hash,category,save_path:pathOverride??savePath,state,progress:fraction,amount_left:Math.ceil(1000*(1-fraction)),auto_tmm:false,force_start:false,eta:120,dlspeed:512}]);
  if(u.pathname.endsWith('/properties'))return Response.json({save_path:pathOverride??savePath,download_path:''});
  if(u.pathname.endsWith('/files'))return Response.json([{index:0,name:'01.mkv',size:1000,progress:fraction,priority:1,is_seed:false}]);throw Error('Unexpected qbit endpoint');
 };
 const unused=async()=>{throw Error('No acquisition search, video read, or Shoko lookup expected');};
 const stages=createAcquisitionStageProcessors({requests,acquisitions,handoffs,pureMoves,pureMode:true,
  discoverCandidates:unused,previewCandidate:unused,loadDetail:unused,releaseQueries:unused,readEvidence:unused,readPublicCoverage:unused,
  publicSections:{episode:[1],movie:[2]},prowlarr:{baseUrl:'http://prowlarr',apiKey:'synthetic',indexerIds:[1]},shoko:{baseUrl:'http://shoko',apiKey:'synthetic',providerId:'AniDB'},
  stagingHostPath:'/handoff/staging',qbitStagingRoot:'/NegevPure',holdingRoot:'/handoff/holding',importRoot:'/handoff/source',realpathImpl:unused,providerFetchImpl:unused,now:()=>clock,
  verifyStagingRoot:async()=>({state:'verified_staging_root'}),verifyShokoSource:async()=>({state:'verified_shoko_source'}),ensureImportRoot:async()=>({state:'import_child_ready'}),verifyHandoffMounts:async()=>({state:'mounted_handoff_roots'})});
 const progress=openRequestProgress(dbPath,{pureMode:true,now:()=>clock});let renewals=0;
 const tick=async(renew=false)=>{const worker=createCompletionWorker({queue,now:()=>clock,processAttempt:input=>stages.processCompletion({...input,qbittorrent:{baseUrl:'http://qbit.internal:8080',sessionId:'syntheticSID'},fetchImpl,
  ...(renew?{renewQbittorrent:async()=>{renewals++;return{state:'authenticated',sessionId:'renewedSID',fetchImpl};}}:{})})});let result=await worker.runOnce();if(result.state==='pass_complete')result=await worker.runOnce();return result;};
 t.after(async()=>{progress.close();queue.close();pureMoves.close();handoffs.close();acquisitions.close();requests.close();await rm(root,{recursive:true,force:true});});
 return{requestId,attemptId,tick,progress,requests,queue:()=>queue,pureMoves,renewals:()=>renewals,advance:()=>clock+=60000,restart:()=>{queue.close();queue=openCompletionQueue(dbPath,{pureMode:true});},set:(next)=>{state=next.state??state;fraction=next.fraction??fraction;mode=next.mode??mode;category=next.category??category;pathOverride=next.path??pathOverride;},clock:()=>clock};
}

test('active Pure stage journals real qBittorrent measurements through restart into request presentation',async t=>{
 const x=await fixture(t);assert.equal((await x.tick()).state,'processed');
 assert.deepEqual(x.progress.read(x.requestId).transfer,{progressBasisPoints:3750,etaSeconds:120,speedBytesPerSecond:512,transferState:'active',observedMs:1000});
 assert.equal(requestPresentation(x.progress.read(x.requestId),'series',{nowMs:x.clock()}).progressPercent,37.5);assert.equal(x.pureMoves.getIntent(x.attemptId),null);
 x.advance();x.restart();x.set({fraction:.625});await x.tick();assert.equal(x.progress.read(x.requestId).transfer.progressBasisPoints,6250);
 assert.equal(requestPresentation(x.progress.read(x.requestId),'series',{nowMs:x.clock()}).progressPercent,62.5);
 x.advance();x.set({mode:'403'});await x.tick();assert.equal(x.progress.read(x.requestId).transfer,undefined);assert.equal(x.progress.read(x.requestId).connectionRetrying,true);
});

for(const[state,want]of[['queuedDL','queued'],['stalledDL','stalled'],['pausedDL','paused'],['stoppedDL','paused']])test('Pure progress preserves '+state+' without suggesting an active transfer',async t=>{
 const x=await fixture(t);x.set({state});await x.tick();assert.equal(x.progress.read(x.requestId).transfer?.transferState,want);assert.equal(x.pureMoves.getIntent(x.attemptId),null);
});

test('Pure observation renews once after403 and retains only the new measured sample',async t=>{
 const x=await fixture(t);x.set({mode:'renew'});await x.tick(true);assert.equal(x.renewals(),1);assert.equal(x.progress.read(x.requestId).transfer?.progressBasisPoints,3750);
});

for(const change of[{category:'sonarr'},{path:'/unrelated'}])test('wrong ownership or staging cannot show another torrent progress '+JSON.stringify(change),async t=>{
 const x=await fixture(t);x.set(change);await x.tick();assert.equal(x.progress.read(x.requestId).transfer,undefined);assert.equal(x.pureMoves.getIntent(x.attemptId),null);
});
