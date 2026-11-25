import test from 'node:test';import assert from 'node:assert/strict';
import {createAcquisitionRequestProcessor} from '../src/acquisition/acquisition-request-processor.mjs';
const request={id:4,anidbId:42,kind:'series',status:'held',episodeIds:[1001]};
const detail={state:'details',complete:true,total:1,anidbId:42,title:'Example',kind:'series',restricted:false,episodes:[{id:1001,number:1,type:'Episode'}]};
const high={indexerId:7,guid:'high',title:'[Group] Example - 01 WEB 1080p',size:400000000,seeders:20,evidence:'unverified'},low={...high,guid:'low',title:'[Group] Example - 01 WEB 720p'};
const preflight={state:'preflight',requestId:4,anidbId:42,torrentHash:'a'.repeat(40),episodeIds:[1001],files:[{name:'Example - 01.mkv',size:400000000,episodeIds:[1001]}]};
function fixture(options={}){let clock=1000,fail=true;const submitted=[];const deps={requireReleasePolicy:true,readRequest:()=>request,discoverCandidates:async()=>({state:'candidates',requestId:4,anidbId:42,releaseState:'airing',items:[high,low]}),previewCandidate:async({candidate})=>candidate.guid==='high'&&fail?{state:'held',reason:'provider_unavailable'}:preflight,loadDetail:async()=>detail,submitCandidate:async({candidate})=>{submitted.push(candidate.guid);return{state:'stopped_observed',attemptId:1}},now:()=>clock,...options};return{deps,submitted,time:n=>clock=n,recover:()=>fail=false,process:createAcquisitionRequestProcessor(deps)}}
test('temporary stronger inspection failure does not immediately downgrade',async()=>{const x=fixture();const first=await x.process({requestId:4});assert.equal(first.state,'held');assert.deepEqual(x.submitted,[]);x.time(61000);x.recover();assert.equal((await x.process({requestId:4})).state,'stopped_observed');assert.deepEqual(x.submitted,['high'])});
test('equivalent quality can proceed despite failed candidate',async()=>{const x=fixture({discoverCandidates:async()=>({state:'candidates',requestId:4,anidbId:42,releaseState:'airing',items:[high,{...low,title:high.title}]})});assert.equal((await x.process({requestId:4})).state,'stopped_observed');assert.deepEqual(x.submitted,['low'])});
test('real older fallback proceeds after bounded spaced retries',async()=>{const x=fixture();assert.equal((await x.process({requestId:4})).state,'held');x.time(61000);assert.equal((await x.process({requestId:4})).state,'held');x.time(121000);assert.equal((await x.process({requestId:4})).state,'stopped_observed');assert.deepEqual(x.submitted,['low'])});

import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {openQualityInspectionRetry} from '../src/acquisition/quality-inspection-retry.mjs';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {openAcquisitionRequestQueue,createAcquisitionPageWorker} from '../src/acquisition/acquisition-request-queue.mjs';
test('actual queue short retry retains stronger failure across database reopen and worker recreation',async t=>{const dir=await mkdtemp(path.join(tmpdir(),'negev-quality-')),db=path.join(dir,'db.sqlite');let requests=openRequestLedger(db),queue=openAcquisitionRequestQueue(db),retry=openQualityInspectionRetry(db);t.after(async()=>{retry.close();queue.close();requests.close();await rm(dir,{recursive:true,force:true})});const saved=requests.submit({requesterId:1,requestKey:'desired',intent:{state:'ready',anidbId:42,kind:'series',title:'Example',episodeIds:[1001],monitorFuture:false},nowMs:1000});const id=saved.requestId;let clock=1000,failed=true;const submitted=[];const run=()=>createAcquisitionPageWorker({queue,now:()=>clock,limit:1,processRequest:createAcquisitionRequestProcessor({qualityInspectionRetry:retry,requireReleasePolicy:true,readRequest:id=>requests.getRequest(id),discoverCandidates:async()=>({state:'candidates',requestId:id,anidbId:42,releaseState:'airing',items:[high,low]}),previewCandidate:async({candidate})=>failed&&candidate.guid==='high'?{state:'held',reason:'provider_unavailable'}:{...preflight,requestId:id},loadDetail:async()=>detail,submitCandidate:async({candidate})=>{submitted.push(candidate.guid);return{state:'stopped_observed',attemptId:1}},now:()=>clock})}).runOnce({priorityRequestId:id});assert.equal((await run()).results[0].reason,'release_preflight_unavailable');retry.close();queue.close();requests.close();requests=openRequestLedger(db);queue=openAcquisitionRequestQueue(db);retry=openQualityInspectionRetry(db);clock=61000;assert.equal((await run()).results[0].state,'held');clock=121000;assert.equal((await run()).results[0].state,'stopped_observed');assert.deepEqual(submitted,['low']);});
test('deterministic rejection permits fallback without artificial retry',async()=>{const x=fixture({previewCandidate:async({candidate})=>candidate.guid==='high'?{state:'held',reason:'related_installment_mismatch'}:preflight});assert.equal((await x.process({requestId:4})).state,'stopped_observed')});
test('time cap releases fallback without requiring three checks',async()=>{const x=fixture();assert.equal((await x.process({requestId:4})).state,'held');x.time(181000);assert.equal((await x.process({requestId:4})).state,'stopped_observed')});
test('unchanged repeated immediate calls cannot spend spaced retry allowance',async()=>{const x=fixture();for(let i=0;i<5;i++)assert.equal((await x.process({requestId:4})).state,'held');assert.deepEqual(x.submitted,[])});
test('stronger failure for an explicitly different episode cannot block independent fallback',async()=>{const req={...request,episodeIds:[1001,1002]};const x=fixture({readRequest:()=>req,discoverCandidates:async()=>({state:'candidates',requestId:4,anidbId:42,releaseState:'airing',items:[{...high,targetEpisodeId:1002,targetedEpisode:true},low]}),loadDetail:async()=>({...detail,total:2,episodes:[...detail.episodes,{id:1002,number:2,type:'Episode'}]})});assert.equal((await x.process({requestId:4})).state,'stopped_observed')});
import {createReleaseSelection} from '../src/acquisition/release-selection.mjs';
test('interactive Auto selection does not pin a downgrade after failed stronger inspection',async t=>{const dir=await mkdtemp(path.join(tmpdir(),'negev-auto-quality-')),db=path.join(dir,'db.sqlite'),requests=openRequestLedger(db);t.after(async()=>{requests.close();await rm(dir,{recursive:true,force:true})});const saved=requests.submit({requesterId:1,requestKey:'desired',intent:{state:'ready',anidbId:42,kind:'series',title:'Example',episodeIds:[1001],monitorFuture:false},nowMs:1000,initialReleaseControl:{mode:'auto',phase:'selecting',expiresMs:301000}}),id=saved.requestId;const selection=createReleaseSelection({requests,now:()=>1000,readPublicCoverage:async()=>({availableEpisodeIds:[],uncertainEpisodeIds:[]}),discoverCandidates:async()=>({state:'candidates',requestId:id,anidbId:42,releaseState:'airing',items:[high,low]}),previewCandidate:async({candidate})=>candidate.guid==='high'?{state:'held',reason:'provider_unavailable'}:{...preflight,requestId:id}});await selection.auto(id,requests.getReleaseControl(id,1000).revision);assert.equal(requests.getReleaseControl(id,1000).phase,'consumed');});
test('malformed stronger response cannot clear protected hint or immediately downgrade',async()=>{let calls=0;const x=fixture({previewCandidate:async({candidate})=>candidate.guid==='high'?(calls++===0?{state:'held',reason:'provider_unavailable'}:undefined):preflight});assert.equal((await x.process({requestId:4})).state,'held');x.time(61000);assert.equal((await x.process({requestId:4})).state,'held');assert.deepEqual(x.submitted,[])});
test('malformed first stronger response uses same bounded guard',async()=>{const x=fixture({previewCandidate:async({candidate})=>candidate.guid==='high'?{state:'preflight',episodeIds:[]}:preflight});assert.equal((await x.process({requestId:4})).state,'held');assert.deepEqual(x.submitted,[])});
test('older 480p remains a usable fallback once the temporary stronger check budget is spent',async()=>{const x=fixture({discoverCandidates:async()=>({state:'candidates',requestId:4,anidbId:42,releaseState:'airing',items:[high,{...low,title:'[Group] Example - 01 DVD 480p'}]})});assert.equal((await x.process({requestId:4})).state,'held');x.time(181000);assert.equal((await x.process({requestId:4})).state,'stopped_observed');assert.deepEqual(x.submitted,['low'])});
import {createHash} from 'node:crypto';
test('saved pre-fix cursor cannot skip unresolved stronger candidate after upgrade',async()=>{const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');const x=fixture();const candidateFingerprint=hash(['quality-policy-v5',1001])+':'+[high,low].map(c=>hash([c.indexerId,c.guid])).join(',')+'|';assert.equal((await x.process({requestId:4,candidateOffset:1,candidateFingerprint})).state,'held');assert.deepEqual(x.submitted,[])});

test('failed inspection pages advance without starving a later healthy 1080p release',async()=>{
  const candidates=Array.from({length:7},(_,i)=>({...high,guid:`high-${i}`,seeders:30-i}));
  const inspected=[];
  const x=fixture({discoverCandidates:async()=>({state:'candidates',requestId:4,anidbId:42,releaseState:'airing',items:[...candidates,low]}),previewCandidate:async({candidate})=>{
    inspected.push(candidate.guid);
    return candidate.guid==='high-6'?preflight:{state:'held',reason:'provider_unavailable'};
  }});
  let cursor={requestId:4};
  for(let page=0;page<2;page++){
    const result=await x.process(cursor);
    assert.equal(result.state,'held');
    assert.equal(result.nextCandidateOffset,(page+1)*3);
    cursor={requestId:4,candidateOffset:result.nextCandidateOffset,candidateFingerprint:result.nextCandidateFingerprint};
  }
  assert.equal((await x.process(cursor)).state,'stopped_observed');
  assert.deepEqual(inspected,candidates.map(c=>c.guid));
  assert.deepEqual(x.submitted,['high-6']);
});

test('maximum candidate sweep and restart retain fair pages and bounded older fallback',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'negev-quality-pages-')),db=path.join(dir,'db.sqlite');
  let requests=openRequestLedger(db),queue=openAcquisitionRequestQueue(db),retry=openQualityInspectionRetry(db);
  t.after(async()=>{retry.close();queue.close();requests.close();await rm(dir,{recursive:true,force:true})});
  const saved=requests.submit({requesterId:1,requestKey:'desired',intent:{state:'ready',anidbId:42,kind:'series',title:'Example',episodeIds:[1001],monitorFuture:false},nowMs:1000});
  const id=saved.requestId,candidates=Array.from({length:49},(_,i)=>({...high,guid:`high-${i}`,seeders:100-i}));
  let clock=1000;const inspected=[],submitted=[];
  const run=()=>createAcquisitionPageWorker({queue,now:()=>clock,limit:1,processRequest:createAcquisitionRequestProcessor({
    qualityInspectionRetry:retry,requireReleasePolicy:true,readRequest:id=>requests.getRequest(id),
    discoverCandidates:async()=>({state:'candidates',requestId:id,anidbId:42,releaseState:'airing',items:[...candidates,low]}),
    previewCandidate:async({candidate})=>{inspected.push(candidate.guid);return candidate.guid==='low'?{...preflight,requestId:id}:{state:'held',reason:'provider_unavailable'}},
    loadDetail:async()=>detail,submitCandidate:async({candidate})=>{submitted.push(candidate.guid);return{state:'stopped_observed',attemptId:1}},now:()=>clock,
  })}).runOnce({priorityRequestId:id});
  for(let page=0;page<100&&submitted.length===0;page++){
    const result=await run();assert.equal(result.results.length,1);
    const recorded=queue.getResult(id);
    if(page===5){retry.close();queue.close();requests.close();requests=openRequestLedger(db);queue=openAcquisitionRequestQueue(db);retry=openQualityInspectionRetry(db)}
    if(submitted.length===0)clock=Math.max(clock+1000,recorded.nextDueMs);
  }
  assert.deepEqual(inspected.slice(0,49),candidates.map(c=>c.guid));
  assert.deepEqual(submitted,['low']);
  assert.ok(clock-1000<=900000,`fallback took ${clock-1000}ms`);
  assert.equal(queue.getScanStartedMs(id),1000);
});

test('completed pack provider failures release the normal episode fallback after bounded retries and restart',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'negev-quality-pack-')),db=path.join(dir,'db.sqlite');
  let requests=openRequestLedger(db),queue=openAcquisitionRequestQueue(db),retry=openQualityInspectionRetry(db);
  t.after(async()=>{retry.close();queue.close();requests.close();await rm(dir,{recursive:true,force:true})});
  const saved=requests.submit({requesterId:1,requestKey:'desired',intent:{state:'ready',anidbId:42,kind:'series',title:'Example',episodeIds:[1001,1002],monitorFuture:false},nowMs:1000});
  const id=saved.requestId,pack={...high,guid:'pack',title:'[Group] Example Complete Batch 1080p'};
  let clock=1000;const submitted=[],inspected=[];
  const run=()=>createAcquisitionPageWorker({queue,now:()=>clock,limit:1,processRequest:createAcquisitionRequestProcessor({
    qualityInspectionRetry:retry,requireReleasePolicy:true,preferShokoPreview:true,readRequest:id=>requests.getRequest(id),
    discoverCandidates:async()=>({state:'candidates',requestId:id,anidbId:42,releaseState:'completed',items:[pack,low]}),
    previewCandidate:async({candidate})=>{inspected.push(candidate.guid);return candidate.guid==='pack'?{state:'held',reason:'provider_unavailable'}:{...preflight,requestId:id,shokoPreview:'exact'}},
    loadDetail:async()=>({...detail,total:2,episodes:[...detail.episodes,{id:1002,number:2,type:'Episode'}]}),
    submitCandidate:async({candidate})=>{submitted.push(candidate.guid);return{state:'stopped_observed',attemptId:1}},now:()=>clock,
  })}).runOnce({priorityRequestId:id});
  for(let page=0;page<20&&submitted.length===0;page++){
    await run();const recorded=queue.getResult(id);
    if(page===0){assert.deepEqual(submitted,[]);retry.close();queue.close();requests.close();requests=openRequestLedger(db);queue=openAcquisitionRequestQueue(db);retry=openQualityInspectionRetry(db)}
    if(submitted.length===0)clock=Math.max(clock+1000,recorded.nextDueMs);
  }
  assert.deepEqual(submitted,['low']);
  assert.ok(inspected.includes('pack'));
  assert.ok(clock-1000<=900000,`completed fallback took ${clock-1000}ms`);
});


test('v318 consumed quality cursor rechecks the stronger candidate under new policy',async()=>{
 const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
 const legacy=digest(['quality-policy-v7',1001])+':'+[high,low].map(c=>digest([c.indexerId,c.guid])).join(',')+'|';
 const x=fixture();x.recover();const result=await x.process({requestId:4,candidateOffset:1,candidateFingerprint:legacy});
 assert.equal(result.state,'stopped_observed');assert.deepEqual(x.submitted,['high']);
});
