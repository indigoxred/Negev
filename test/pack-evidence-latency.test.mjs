import assert from'node:assert/strict';import test from'node:test';
import{collectTargetScopedUncertain}from'../src/acquisition/collect-target-scoped-uncertain.mjs';
import{confirmMissingTargets}from'../src/acquisition/confirm-missing-targets.mjs';
import{readShokoEpisodeFiles}from'../src/availability/shoko-episode-files.mjs';
function scheduler(){let clock=1000,scheduled=false;const pending=[];const tick=()=>{scheduled=false;if(!pending.length)return;clock=Math.min(...pending.map(x=>x.at));const ready=pending.filter(x=>x.at===clock);for(const x of ready)pending.splice(pending.indexOf(x),1);for(const x of ready)x.resolve();};return{now:()=>clock,wait:ms=>new Promise(resolve=>{pending.push({at:clock+ms,resolve});if(!scheduled){scheduled=true;setImmediate(tick);}})};}
for(const count of[24,50])test('successful750ms providers produce fresh '+count+' episode pack evidence with bounded work',async()=>{
 const time=scheduler(),ids=Array.from({length:count},(_,i)=>1001+i),metadataCache=new Map();let calls=0,active=0,peak=0;
 const fetchImpl=async url=>{calls++;active++;peak=Math.max(peak,active);await time.wait(750);active--;const id=Number(url.pathname.match(/(\d+)(?:\/Episode)?$/)[1]);return url.pathname.endsWith('/Episode')?new Response(null,{status:404}):Response.json({ID:id,AnimeID:42});};
 const scope={anidbId:42,episodeIds:ids,kind:'series',publicLibraryIds:[102]};
 const result=await collectTargetScopedUncertain({...scope,now:time.now,readEpisode:target=>readShokoEpisodeFiles({baseUrl:'http://fixture.invalid',apiKey:'fixture',...target,purpose:'first_time',metadataCache,fetchImpl}),probePublic:async()=>({state:'healthy_unconfirmed',libraryIds:[102],parts:[],complete:false,probeCoverage:'health_only',sourceVerified:true})});
 const final=await confirmMissingTargets({request:{id:1,status:'held',...scope},episodeIds:ids,publicLibraryIds:[102],firstTimePolicy:'single_uncertain_attempt',now:time.now,readEvidence:async()=>result});
 assert.equal(final.state,'missing_confirmed',JSON.stringify(result));assert.equal(calls,count*3);assert.ok(peak<=4);assert.ok(time.now()-1000<30000);
});
