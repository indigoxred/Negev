import test from 'node:test';
import assert from 'node:assert/strict';
import {planTorrentTargets} from '../src/acquisition/plan-torrent-targets.mjs';
import {previewRequestCandidate} from '../src/acquisition/request-candidate-preflight.mjs';
import {collectTargetScopedUncertain} from '../src/acquisition/collect-target-scoped-uncertain.mjs';
import {confirmMissingTargets} from '../src/acquisition/confirm-missing-targets.mjs';
const make=count=>{
 const episodes=Array.from({length:count},(_,i)=>({id:1001+i,number:i+1,type:'Episode',title:'Episode '+(i+1),airDate:'2025-01-01'}));
 const request={id:1,anidbId:42,status:'held',kind:'series',episodeIds:episodes.map(e=>e.id)};
 const detail={state:'details',anidbId:42,title:'Example',kind:'series',restricted:false,page:1,complete:true,nextPage:null,total:count,airDate:'2025-01-01',endDate:'2025-06-01',episodeCount:count,episodes};
 const files=episodes.map(e=>({name:'Example - '+String(e.number).padStart(2,'0')+'.mkv',size:1000}));
 const prepared={state:'prepared_stopped',expected:{hash:'a'.repeat(40)},version:'v1',totalBytes:files.length*1000,files,form:new FormData()};
 return {request,detail,prepared,releaseTitle:'Example Complete 1080p',trustedTitle:'Example',today:'2026-11-23'};
};
test('large capacity does not admit unknown or Airing rosters, oversized videos, mixed installments or duplicates',()=>{
 const f=make(52);assert.equal(planTorrentTargets(f).state,'planned_targets');
 assert.equal(planTorrentTargets({...f,detail:{...f.detail,endDate:null,episodeCount:100}}).reason,'large_pack_requires_completed_series');
 assert.equal(planTorrentTargets({...f,detail:{...f.detail,airDate:null,endDate:null}}).reason,'large_pack_requires_completed_series');
 assert.equal(planTorrentTargets({...f,prepared:{...f.prepared,files:f.prepared.files.map((x,i)=>i===0?{...x,size:65*1024**3}:x)}}).reason,'video_budget_exceeded');
 assert.equal(planTorrentTargets({...f,prepared:{...f.prepared,files:[...f.prepared.files.slice(0,-1),f.prepared.files[0]]}}).state,'held');
 assert.equal(planTorrentTargets({...f,prepared:{...f.prepared,files:f.prepared.files.map((x,i)=>i===0?{...x,name:'Example - 53.mkv'}:x)}}).state,'held');
 assert.equal(planTorrentTargets(make(501)).state,'held');
});
test('a large provider-stalled filename preview is bounded without blocking a strong ordinary title',async()=>{
 const f=make(52);let calls=0,late;const waiting=new Promise(resolve=>late=resolve);
 const result=await previewRequestCandidate({requestId:1,candidate:{indexerId:1,guid:'batch',title:'Example Complete 1080p',size:52000},readRequest:()=>f.request,loadDetail:async()=>f.detail,prepare:async()=>f.prepared,maxFilenamePreviewMs:20,offlineLookup:async()=>{calls++;return waiting}});
 assert.equal(result.state,'preflight');assert.equal(result.shokoPreview,'uncertain');assert.equal(calls,1);
 late({status:200});await new Promise(setImmediate);assert.equal(result.shokoPreview,'uncertain');assert.equal(calls,1);
});
test('500 absent targets traverse the real first-time collector with at most four simultaneous reads and full confirmation',async()=>{
 const f=make(500);let active=0,max=0,reads=0;
 const evidence=await collectTargetScopedUncertain({anidbId:42,episodeIds:f.request.episodeIds,kind:'series',publicLibraryIds:[102],now:()=>1000,readEpisode:async({episodeId})=>{reads++;active++;max=Math.max(max,active);await new Promise(setImmediate);active--;return {state:'not_imported',anidbId:42,episodeId}},probePublic:async()=>({state:'healthy_unconfirmed',probeCoverage:'health_only',sourceVerified:true,complete:false,libraryIds:[102],parts:[]})});
 assert.equal(evidence.shoko.state,'unimported_targets');assert.equal(reads,1000);assert.equal(max,4);
 const confirmed=await confirmMissingTargets({request:f.request,episodeIds:f.request.episodeIds,publicLibraryIds:[102],readEvidence:async()=>evidence,firstTimePolicy:'single_uncertain_attempt',now:()=>1000});assert.equal(confirmed.state,'missing_confirmed');
});


test('a weak title cannot convert large-preview timeout into either acquisition or a six-hour identity rejection',async()=>{
 const f=make(52);let calls=0;
 const result=await previewRequestCandidate({requestId:1,candidate:{indexerId:1,guid:'batch',title:'[G] Distinctive Journey Across Alternate Spacing Complete 1080p',size:52000},readRequest:()=>f.request,loadDetail:async()=>({...f.detail,title:'Distinctive Journey Across the Faraway Kingdom with Companions and Unexpected Adventures'}),prepare:async()=>f.prepared,maxFilenamePreviewMs:20,offlineLookup:async()=>{calls++;return new Promise(()=>{})}});
 assert.equal(result.state,'held');assert.equal(result.reason,'metadata_reader_busy');assert.equal(calls,1);
});
