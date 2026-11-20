import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { createAcquisitionRequestProcessor } from '../src/acquisition/acquisition-request-processor.mjs';
async function fixture(run){
 const dir=await mkdtemp(path.join(tmpdir(),'negev-group-processor-')),dbPath=path.join(dir,'state.sqlite');
 const requests=openRequestLedger(dbPath);requests.submit({requesterId:1,requestKey:'watch',nowMs:100,
   intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:true,episodeIds:[101,102]}});
 requests.updateReleasePreference(1,0,{group:'SubsPlease',audio:'japanese',knownEpisodeIds:[101],createdMs:100},100);
 let clock=1000,fail=false,preferred=false,allMissing=false,includeHistorical=false,many=false,preferredPatch={};const submitted=[];
 const candidate={guid:'other',indexerId:1,title:'[Other] Example - 02 WEB 1080p',size:1000,seeders:20,evidence:'unverified'};
 const preview={state:'preflight',requestId:1,anidbId:42,torrentHash:'a'.repeat(40),shokoPreview:'uncertain',episodeIds:[102],files:[{name:'Example - 02.mkv',size:1000,episodeIds:[102]}]};
 const detail={state:'details',anidbId:42,complete:true,total:2,kind:'series',title:'Example',restricted:false,
   episodes:[{id:101,type:'Episode',number:1},{id:102,type:'Episode',number:2}]};
 const make=()=>createAcquisitionRequestProcessor({now:()=>clock,readRequest:id=>requests.getRequest(id),
   readReleaseControl:requests.getReleaseControl.bind(requests),checkPreferredRelease:requests.checkPreferredRelease.bind(requests),
   getPreferredFallback:requests.getPreferredFallback.bind(requests),closePreferredWaits:requests.closePreferredWaits.bind(requests),
   requireReleasePolicy:true,preferShokoPreview:true,preferRegisteredCorrespondence:true,
   readPublicCoverage:async()=>({targetCount:2,verifiedTargets:allMissing?0:1,availableEpisodeIds:allMissing?[]:[101]}),
   discoverCandidates:async()=>fail?{state:'held',reason:'release_search_unavailable'}:{state:'candidates',requestId:1,anidbId:42,releaseState:'airing',
     items:many?[candidate,{...candidate,guid:'other2'},{...candidate,guid:'other3'},{...candidate,guid:'preferred',title:'[SubsPlease] Example - 02 WEB 720p'}]:includeHistorical?[candidate,{...candidate,guid:'historical',title:'[Other] Example WEB 1080p',seeders:10}]:preferred?[candidate,{...candidate,guid:'preferred',title:'[SubsPlease] Example - 02 WEB 1080p',...preferredPatch}]:[candidate]},
   previewCandidate:async({candidate:c})=>c.guid==='historical'?{...preview,episodeIds:[101],files:[{name:'Example - 01.mkv',size:1000,episodeIds:[101]}]}:{...preview,correspondence:{files:preview.files.map(f=>({...f,state:c.guid==='other'?'likely':'unknown'}))}},
   loadDetail:async()=>detail,submitCandidate:async input=>{submitted.push(input);return {state:'stopped_observed',attemptId:77};}});
 try{await run({requests,make,submitted,setClock:v=>{clock=v},fail:()=>{fail=true},prefer:(patch={})=>{preferred=true;preferredPatch=patch},many:()=>{many=true},missing:()=>{allMissing=true},historical:()=>{allMissing=true;includeHistorical=true}});}
 finally{requests.close();await rm(dir,{recursive:true,force:true});}
}
test('a new airing alternative waits once, then a restart can use its exact fallback during provider failure',()=>fixture(async({make,setClock,fail,submitted})=>{
 const waiting=await make()({requestId:1});assert.equal(waiting.reason,'preferred_group_wait');assert.equal(waiting.retryAtMs,7_201_000);assert.equal(submitted.length,0);
 setClock(7_201_000);fail();const result=await make()({requestId:1});assert.equal(result.state,'stopped_observed');
 assert.equal(submitted[0].expectedHash,'a'.repeat(40));
}));
test('a suitable preferred group is selected without waiting despite unknown registration',()=>fixture(async({make,prefer,submitted})=>{
 prefer();const result=await make()({requestId:1});assert.equal(result.state,'stopped_observed');assert.equal(submitted[0].candidate.guid,'preferred');
}));
test('a waiting future episode does not postpone independently missing historical episodes for two hours',()=>fixture(async({make,missing})=>{
 missing();const waiting=await make()({requestId:1});assert.equal(waiting.reason,'preferred_group_wait');assert.equal(waiting.retryAtMs,61_000);
}));

test('a higher-ranked waiting release is skipped so an independent historical episode is submitted in the same pass',()=>fixture(async({make,historical,submitted})=>{
 historical();const result=await make()({requestId:1});assert.equal(result.state,'stopped_observed');
 assert.equal(submitted[0].candidate.guid,'historical');assert.deepEqual(submitted[0].episodeIds,[101]);
}));

for(const [name,patch]of [['720p',{title:'[SubsPlease] Example - 02 WEB 720p'}],['unhealthy peers',{seeders:1}]])
 test(`a preferred group cannot override a stronger alternative's ${name} tier`,()=>fixture(async({make,prefer,submitted})=>{
   prefer(patch);assert.equal((await make()({requestId:1})).reason,'preferred_group_wait');assert.equal(submitted.length,0);
 }));

test('stronger observed tiers survive the preview-page cursor and expiry reuses the1080p alternative',()=>fixture(async({make,many,setClock,submitted})=>{
 many();const first=await make()({requestId:1});assert.equal(first.nextCandidateOffset,3);
 const second=await make()({requestId:1,pass:2,candidateOffset:first.nextCandidateOffset,candidateFingerprint:first.nextCandidateFingerprint});
 assert.equal(second.reason,'preferred_group_wait');assert.equal(submitted.length,0);
 setClock(7_201_000);const expired=await make()({requestId:1,pass:3,candidateOffset:3,candidateFingerprint:first.nextCandidateFingerprint});
 assert.equal(expired.state,'stopped_observed');assert.equal(submitted[0].candidate.title.includes('1080p'),true);
}));
