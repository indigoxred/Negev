import test from 'node:test';
import assert from 'node:assert/strict';
import {requestPresentation} from '../src/web/public/request-progress-text.mjs';
import {createWatchingScheduleReader} from '../src/web/watching-schedule.mjs';
const nowMs=Date.UTC(2026,10,23,6);
const watch={id:72,anidbId:42,status:'held',kind:'series',monitorFuture:true,episodeIds:[1,2,3,4,5,6,7,8]};
const episodes=watch.episodeIds.map((id,i)=>({id,type:'Episode',number:i+1,airDate:i===7?'2026-11-23':'2026-11-16'}));
const progress={state:'saved',targetCount:8,publicAvailability:'verified_recently',publicVerifiedTargets:7,waitingForRelease:true,scheduledToday:{asOf:'2026-11-23',targetCount:8,verifiedTargets:7,pendingEpisodeNumbers:[8]}};
const options={monitorFuture:true,nowMs};
test('all earlier episodes available and today pending is a schedule wait, not partial failure',()=>{
 const result=requestPresentation(progress,'series',options);
 assert.equal(result.stage,"Waiting for today's episode");assert.equal(result.group,'watching');
 assert.match(result.detail,/7 requested episodes.*playable.*Episode 8.*scheduled for today/);
 assert.equal(progress.targetCount,8);
});
test('earlier gaps, downloading, review, stale schedule and non-watches retain their real status',()=>{
 for(const changed of [
  {publicVerifiedTargets:6},{state:'download_unverified'}, {state:'review_needed'},
  {scheduledToday:{...progress.scheduledToday,asOf:'2026-11-22'}},
  {scheduledToday:{...progress.scheduledToday,pendingEpisodeNumbers:[8,8]}},
  {waitingForRelease:false},
 ])assert.notEqual(requestPresentation({...progress,...changed},'series',options).stage,"Waiting for today's episode");
 assert.equal(requestPresentation(progress,'series',{...options,monitorFuture:false}).stage,'Partly available');
});
test('cached schedule evidence is exact to requested ids and cannot conceal an earlier missing episode',()=>{
 const reader=createWatchingScheduleReader({cachedIndex:()=>({regularEpisodes:episodes}),readDetail:()=>{throw Error('must not fetch');},today:()=> '2026-11-23'});
 assert.deepEqual(reader.pendingToday(watch,[1,2,3,4,5,6,7]),progress.scheduledToday);
 assert.equal(reader.pendingToday(watch,[1,2,3,4,5,6]),null);
 assert.equal(reader.pendingToday({...watch,monitorFuture:false},[1,2,3,4,5,6,7]),null);
 assert.equal(reader.pendingToday({...watch,episodeIds:[...watch.episodeIds,99]},[1,2,3,4,5,6,7]),null);
 assert.equal(reader.pendingToday(watch,[1,2,3,4,5,6,7,8]),null);
});
test('unknown, future and Special dates do not establish a pending-today regular request',()=>{
 for(const modified of [episodes.map(e=>e.id===8?{...e,airDate:null}:e),episodes.map(e=>e.id===8?{...e,airDate:'2026-11-24'}:e),episodes.map(e=>e.id===8?{...e,type:'Special'}:e)]){
 const reader=createWatchingScheduleReader({cachedIndex:()=>({regularEpisodes:modified}),readDetail:async()=>{},today:()=> '2026-11-23'});
 assert.equal(reader.pendingToday(watch,[1,2,3,4,5,6,7]),null);
 }
});
