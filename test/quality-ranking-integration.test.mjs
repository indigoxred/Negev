import test from 'node:test';
import assert from 'node:assert/strict';
import {createAcquisitionRequestProcessor}from'../src/acquisition/acquisition-request-processor.mjs';
test('the worker retains1080p across preview correspondence and the seed threshold',async()=>{
 const low={guid:'low',indexerId:1,title:'Example - 01 WEB 480p',size:1000,seeders:3,evidence:'unverified'};
 const high={...low,guid:'high',title:'Example - 01 WEB 1080p',seeders:2};let submitted;
 const process=createAcquisitionRequestProcessor({requireReleasePolicy:true,preferShokoPreview:true,preferRegisteredCorrespondence:true,
  readRequest:()=>({id:1,status:'held',anidbId:42,kind:'series',episodeIds:[101]}),
  readPublicCoverage:async()=>({targetCount:1,verifiedTargets:0,availableEpisodeIds:[],uncertainEpisodeIds:[]}),
  discoverCandidates:async()=>({state:'candidates',requestId:1,anidbId:42,releaseState:'completed',items:[low,high]}),
  previewCandidate:async({candidate:c})=>({state:'preflight',requestId:1,anidbId:42,torrentHash:(c.guid==='high'?'a':'b').repeat(40),episodeIds:[101],
   files:[{name:'Example - 01.mkv',size:1000,episodeIds:[101]}],correspondence:{files:[{name:'Example - 01.mkv',size:1000,state:c.guid==='low'?'likely':'unknown'}]}}),
  loadDetail:async()=>({state:'details',anidbId:42,complete:true,total:1,kind:'series',title:'Example',restricted:false,episodes:[{id:101,type:'Episode',number:1}]}),
  submitCandidate:async input=>{submitted=input;return{state:'stopped_observed',attemptId:1};}});
 assert.equal((await process({requestId:1})).state,'stopped_observed');assert.equal(submitted.candidate.guid,'high');
});
