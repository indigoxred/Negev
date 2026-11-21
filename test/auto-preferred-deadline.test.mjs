import test from'node:test';import assert from'node:assert/strict';
import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';
import{openRequestLedger}from'../src/requests/request-ledger.mjs';
import{openAcquisitionLedger}from'../src/acquisition/acquisition-ledger.mjs';
import{createReleasePreviews}from'../src/requests/release-previews.mjs';
import{createReleaseSelection}from'../src/acquisition/release-selection.mjs';
import{createAcquisitionRequestProcessor}from'../src/acquisition/acquisition-request-processor.mjs';
const start=Date.UTC(2026,10,21);
async function fixture(run){
 const dir=await mkdtemp(path.join(tmpdir(),'negev-auto-group-')),dbPath=path.join(dir,'state.sqlite');
 let requests=openRequestLedger(dbPath),acquisitions=openAcquisitionLedger(dbPath),clock=start;
 const id=requests.submit({requesterId:1,requestKey:'watch',nowMs:clock,intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:true,episodeIds:[101,102]}}).requestId;
 requests.updateReleasePreference(id,0,{group:'SubsPlease',audio:'japanese',knownEpisodeIds:[101],createdMs:clock},clock);
 let preferred=false,partial=false,outage=false,lower=false,changed=false,unknownState=false,available=[101];const submitted=[];let wakes=0;
 const detail=()=>({state:'details',anidbId:42,kind:'series',title:'Example',restricted:false,complete:true,page:1,total:2,nextPage:null,
  airDate:'2026-10-01',endDate:'2027-01-01',episodeCount:2,episodes:[{id:101,type:'Episode',number:1,title:'First',airDate:'2026-10-01'},{id:102,type:'Episode',number:2,title:'Second',airDate:'2026-11-21'}]});
 const other=()=>({guid:'other',indexerId:1,title:'[Other] Example - 02 WEB '+(lower?'720p':'1080p'),size:1000,seeders:20,evidence:'unverified'});
 const preferredItem=()=>({...other(),guid:'preferred',title:'[SubsPlease] Example - 02 WEB 1080p'});
 const discover=async()=>outage?{state:'held',reason:'release_search_unavailable'}:{state:'candidates',requestId:id,anidbId:42,...(unknownState?{}:{releaseState:'airing'}),searchIncomplete:partial,items:preferred?[other(),preferredItem()]:[other()]};
 const preview=async({candidate:c})=>({state:'preflight',requestId:id,anidbId:42,torrentHash:(changed?'c':c.guid==='preferred'?'b':'a').repeat(40),episodeIds:[102],files:[{name:'Example - 02.mkv',size:1000,episodeIds:[102]}],correspondence:{files:[{name:'Example - 02.mkv',size:1000,state:'unknown'}]}});
 const coverage=async request=>{const ids=request.episodeIds.filter(id=>available.includes(id));return{targetCount:request.episodeIds.length,verifiedTargets:ids.length,availableEpisodeIds:ids,uncertainEpisodeIds:[]};};
 const makeSelection=()=>createReleaseSelection({requests,now:()=>clock,discoverCandidates:discover,previewCandidate:preview,readPublicCoverage:coverage,loadDetail:async()=>detail(),wake:()=>wakes++});
 const auto=async()=>{const service=makeSelection();const begun=service.begin(id,'auto',service.snapshot(id).revision);assert.equal(begun.state,'updated');return service.auto(id,begun.control.revision);};
 const worker=()=>createAcquisitionRequestProcessor({now:()=>clock,readRequest:x=>requests.getRequest(x),readReleaseControl:(...a)=>requests.getReleaseControl(...a),
  consumeReleaseChoice:(...a)=>requests.consumeReleaseChoice(...a),checkPreferredRelease:(...a)=>requests.checkPreferredRelease(...a),getPreferredFallback:(...a)=>requests.getPreferredFallback(...a),closePreferredWaits:(...a)=>requests.closePreferredWaits(...a),
  requireReleasePolicy:true,preferShokoPreview:true,preferRegisteredCorrespondence:true,readPublicCoverage:coverage,
  inspectCandidateTargets:input=>acquisitions.inspectCandidateTargets(input),discoverCandidates:discover,previewCandidate:preview,loadDetail:async()=>detail(),
  submitCandidate:async input=>{const reservation=acquisitions.reserve({...input,requestId:input.request.id,preparedHash:input.expectedHash,nowMs:clock});assert.equal(reservation.state,'reserved');
   const attemptId=reservation.attemptId,hash=input.expectedHash,candidate=input.candidate;
   assert.equal(acquisitions.bindPreparedTorrent({attemptId,hash,candidate,nowMs:clock}).state,'prepared');
   acquisitions.recordFilePlan({attemptId,hash,plannedFiles:input.plannedFiles,nowMs:clock});
   acquisitions.beginDispatch({attemptId,nowMs:clock});acquisitions.recordTorrent({attemptId,hash,nowMs:clock});
   submitted.push(input);return{state:'stopped_observed',attemptId};}});
 const restart=()=>{acquisitions.close();requests.close();requests=openRequestLedger(dbPath);acquisitions=openAcquisitionLedger(dbPath);};
 try{await run({id,auto,worker,submitted,requests:()=>requests,restart,setClock:n=>clock=n,clock:()=>clock,prefer:()=>preferred=true,
  unknown:()=>unknownState=true,partial:()=>partial=true,outage:()=>outage=true,lower:()=>lower=true,change:()=>changed=true,wakes:()=>wakes,
  historical:()=>requests.updateReleasePreference(id,requests.getReleaseControl(id,clock).revision,{group:'SubsPlease',audio:'japanese',knownEpisodeIds:[101,102],createdMs:start},clock),
  complete:()=>available=[101,102]});}finally{acquisitions.close();requests.close();await rm(dir,{recursive:true,force:true});}
}

test('Auto-Pick preserves the durable two-hour wait instead of pinning an early alternative',()=>fixture(async x=>{
 const selected=await x.auto();assert.equal(selected.control.phase,'consumed');assert.equal(selected.control.selection,undefined);assert.equal(selected.control.preference.group,'SubsPlease');
 const wait=await x.worker()({requestId:x.id});assert.equal(wait.reason,'preferred_group_wait');assert.equal(wait.retryAtMs,start+7_200_000);assert.equal(x.submitted.length,0);
 x.setClock(start+1000);await x.auto();x.restart();assert.equal((await x.worker()({requestId:x.id})).retryAtMs,wait.retryAtMs);
 x.setClock(wait.retryAtMs);x.outage();assert.equal((await x.worker()({requestId:x.id})).state,'stopped_observed');assert.equal(x.submitted[0].candidate.guid,'other');
 x.restart();x.prefer();assert.notEqual((await x.worker()({requestId:x.id})).state,'stopped_observed');assert.equal(x.submitted.length,1);
 x.complete();assert.equal((await x.worker()({requestId:x.id})).reason,'request_fully_available');
}));

test('a suitable preferred release before expiry is used and historical catch-up never waits',()=>fixture(async x=>{
 await x.auto();const wait=await x.worker()({requestId:x.id});assert.equal(wait.reason,'preferred_group_wait');
 x.setClock(start+60_000);x.prefer();assert.equal((await x.worker()({requestId:x.id})).state,'stopped_observed');assert.equal(x.submitted[0].candidate.guid,'preferred');
}));
test('Auto-Pick historical targets stay immediately eligible',()=>fixture(async x=>{
 x.historical();await x.auto();assert.equal((await x.worker()({requestId:x.id})).state,'stopped_observed');
}));
test('an exact saved fallback reaches its deadline despite partial provider results',()=>fixture(async x=>{
 x.lower();await x.auto();const wait=await x.worker()({requestId:x.id});assert.equal(wait.reason,'preferred_group_wait');
 x.setClock(wait.retryAtMs);x.partial();assert.equal((await x.worker()({requestId:x.id})).state,'stopped_observed');assert.equal(x.submitted.length,1);
}));
test('deadline expiry cannot use changed metainfo from a saved fallback',()=>fixture(async x=>{
 await x.auto();const wait=await x.worker()({requestId:x.id});x.setClock(wait.retryAtMs);x.change();
 assert.equal((await x.worker()({requestId:x.id})).reason,'release_preflight_unavailable');assert.equal(x.submitted.length,0);
}));

test('unknown release dates cannot bypass an established Airing group preference',()=>fixture(async x=>{
 x.unknown();await x.auto();const wait=await x.worker()({requestId:x.id});
 assert.equal(wait.reason,'preferred_group_wait');assert.equal(wait.retryAtMs,start+7_200_000);assert.equal(x.submitted.length,0);
}));

test('a fresh unsaved preview keeps its group preference through Auto-Pick commit',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'negev-preview-group-'));const requests=openRequestLedger(path.join(dir,'db.sqlite'));
 const input={requesterId:1,anidbId:42,scope:'installment',requestKey:'new'};
 const intent={state:'ready',anidbId:42,kind:'series',monitorFuture:true,episodeIds:[101,102]};let wakes=0;
 const sessions=createReleasePreviews({requests,now:()=>start,wake:()=>wakes++,prepare:async data=>({state:'prepared',submission:{...data,intent,nowMs:start}}),
  selectionOptions:{discoverCandidates:async()=>({state:'candidates',releaseState:'airing',items:[]}),previewCandidate:async()=>null,
   readPublicCoverage:async()=>({availableEpisodeIds:[],uncertainEpisodeIds:[]}),
   loadDetail:async()=>({state:'details',kind:'series',airDate:'2026-10-01',endDate:'2027-01-01',episodeCount:12,episodes:[{id:101,type:'Episode',airDate:'2026-10-01'}]})}});
 try{
  const opened=await sessions.open(input);const set=await sessions.command(opened.previewId,1,{action:'preference',group:'SubsPlease',audio:'japanese',revision:1});assert.equal(set.state,'updated');
  assert.equal(requests.listRequests({requesterId:1}).items.length,0);
  const begun=await sessions.command(opened.previewId,1,{action:'begin',mode:'auto',revision:set.control.revision});assert.equal(begun.control.preference?.group,'SubsPlease');
  const saved=await sessions.command(opened.previewId,1,{action:'auto',revision:begun.control.revision});assert.ok(saved.requestId);
  assert.equal(requests.getReleaseControl(saved.requestId,start).preference.group,'SubsPlease');assert.equal(wakes,1);
 }finally{requests.close();await rm(dir,{recursive:true,force:true});}
});

test('repeated partial searches and restart do not extend the original fallback deadline',()=>fixture(async x=>{
 x.lower();await x.auto();const initial=await x.worker()({requestId:x.id});assert.equal(initial.reason,'preferred_group_wait');assert.equal(initial.retryAtMs,start+7_200_000);
 x.partial();for(const elapsed of [60_000,3_600_000,7_199_999]){x.setClock(start+elapsed);x.restart();const wait=await x.worker()({requestId:x.id});assert.equal(wait.reason,'preferred_group_wait');assert.equal(wait.retryAtMs,start+7_200_000);assert.equal(x.submitted.length,0);}
 x.setClock(start+7_200_000);x.restart();assert.equal((await x.worker()({requestId:x.id})).state,'stopped_observed');assert.equal(x.submitted.length,1);
 x.setClock(start+7_260_000);x.restart();await x.worker()({requestId:x.id});assert.equal(x.submitted.length,1);
}));
