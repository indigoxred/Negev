import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyCachedPositiveCoverage } from
  '../src/acquisition/verify-cached-positive-coverage.mjs';

const request = { anidbId: 42, kind: 'series',
  episodeIds: [1001, 1002] };
const cached = { verifiedTargets: 2, targetCount: 2,
  availableEpisodeIds: [1001, 1002] };

test('a deleted Shoko target loses its stale positive before search', async () => {
  const checked = await verifyCachedPositiveCoverage({ request, cached,
    readShoko: async ({ episodeId }) => episodeId === 1001
      ? { state: 'not_imported', anidbId: 42, episodeId }
      : { state: 'ok', complete: true, files: [{ fileId: 9 }] },
    readPublic: async () => ({ state: 'available' }) });
  assert.deepEqual(checked, { verifiedTargets: 1, targetCount: 2,
    availableEpisodeIds: [1002] });
});

test('a live Shoko file also needs current Plex availability', async () => {
  const checked = await verifyCachedPositiveCoverage({ request,
    cached: { verifiedTargets: 1, targetCount: 2,
      availableEpisodeIds: [1001] },
    readShoko: async () => ({ state: 'ok', complete: true,
      files: [{ fileId: 9 }] }),
    readPublic: async () => ({ state: 'available' }) });
  assert.deepEqual(checked, { verifiedTargets: 1, targetCount: 2,
    availableEpisodeIds: [1001] });
});

test('provider uncertainty cannot turn an old proof into permission to reacquire', async () => {
  const checked = await verifyCachedPositiveCoverage({ request, cached,
    readShoko: async () => ({ state: 'unavailable' }),
    readPublic: async () => ({ state: 'available' }) });
  assert.deepEqual(checked, { verifiedTargets: 0, targetCount: 2,
    availableEpisodeIds: [], uncertainEpisodeIds: [1001, 1002] });
});

test('one uncertain owned episode preserves other verified and independently missing targets', async () => {
  const checked = await verifyCachedPositiveCoverage({
    request: { ...request, episodeIds: [1001, 1002, 1003] },
    cached: { ...cached, targetCount: 3 },
    readShoko: async ({ episodeId }) => episodeId === 1001
      ? { state: 'unavailable' } : { state: 'ok', complete: true, files: [{ fileId: 9 }] },
    readPublic: async () => ({ state: 'available' }) });
  assert.deepEqual(checked, { verifiedTargets: 1, targetCount: 3,
    availableEpisodeIds: [1002], uncertainEpisodeIds: [1001] });
});

test('bounded positive checks reuse unchanged targets and invalidate only a changed episode', async () => {
  const cache = new Map(), calls = [];
  let changed = false;
  const options = { request, cached, cache, maxChecks: 1,
    now: () => 100,
    readRevision: ({ episodeId }) => changed && episodeId === 1001 ? 'new' : 'old',
    readShoko: async ({ episodeId }) => { calls.push(episodeId);
      return { state: 'ok', complete: true, files: [{ fileId: episodeId }] }; },
    readPublic: async () => ({ state: 'available' }) };
  const first = await verifyCachedPositiveCoverage(options);
  assert.deepEqual(first.uncertainEpisodeIds, [1002]);
  assert.equal(first.verifiedTargets, 1);
  assert.equal((await verifyCachedPositiveCoverage(options)).verifiedTargets, 2);
  assert.equal((await verifyCachedPositiveCoverage(options)).verifiedTargets, 2);
  assert.deepEqual(calls, [1001, 1002]);
  changed = true;
  await verifyCachedPositiveCoverage(options);
  assert.deepEqual(calls, [1001, 1002, 1001]);
});

test('known Shoko ownership without a saved playable proof is protected when Plex is uncertain', async () => {
  const result = await verifyCachedPositiveCoverage({ request,
    cached: { targetCount: 2, verifiedTargets: 0, availableEpisodeIds: [] },
    ownedEpisodeIds: [1001],
    readShoko: async () => ({ state: 'ok', complete: true, files: [{ fileId: 9 }] }),
    readPublic: async () => ({ state: 'unknown' }) });
  assert.deepEqual(result.uncertainEpisodeIds, [1001]);
  assert.equal(result.verifiedTargets, 0);
});

test('a repeatedly unavailable target cannot starve uninspected owned episodes', async () => {
  let nowMs = 100;
  const calls = [], cache = new Map();
  const options = { request, cached, cache, maxChecks: 1, now: () => nowMs,
    readShoko: async ({ episodeId }) => { calls.push(episodeId);
      return episodeId === 1001 ? { state: 'unavailable' } :
        { state: 'ok', complete: true, files: [{ fileId: 9 }] }; },
    readPublic: async () => ({ state: 'available' }) };
  await verifyCachedPositiveCoverage(options);
  nowMs += 10_000;
  const result = await verifyCachedPositiveCoverage(options);
  assert.deepEqual(calls, [1001, 1002]);
  assert.deepEqual(result.availableEpisodeIds, [1002]);
  assert.deepEqual(result.uncertainEpisodeIds, [1001]);
});

test('only budget-deferred episodes request a continuation; actual uncertainty remains protected',async()=>{
 const cache=new Map();let clock=100;const options={request,cached,cache,maxChecks:1,now:()=>clock,readShoko:async({episodeId})=>episodeId===1001?{state:'unavailable'}:{state:'ok',complete:true,files:[{fileId:9}]},readPublic:async()=>({state:'available'})};
 const first=await verifyCachedPositiveCoverage(options);assert.deepEqual(first.pendingEpisodeIds,[1002]);assert.deepEqual(first.uncertainEpisodeIds,[1001,1002]);clock+=1000;
 const second=await verifyCachedPositiveCoverage(options);assert.equal(second.pendingEpisodeIds,undefined);assert.deepEqual(second.availableEpisodeIds,[1002]);assert.deepEqual(second.uncertainEpisodeIds,[1001]);
});

test('expired uncertainty is visited work, never usable availability or a fresh continuation',async()=>{
 const cache=new Map();let clock=100;const ids=Array.from({length:32},(_,i)=>1001+i),r={anidbId:42,kind:'series',episodeIds:ids},calls=[];const options={request:r,cached:{targetCount:32,verifiedTargets:32,availableEpisodeIds:ids},cache,maxChecks:1,now:()=>clock,readShoko:async({episodeId})=>{calls.push(episodeId);return {state:'unavailable'}},readPublic:async()=>{throw Error('no positive proof')}};
 let result;for(let i=0;i<32;i++){result=await verifyCachedPositiveCoverage(options);clock+=1000;}
 assert.equal(calls.length,32);assert.equal(result.pendingEpisodeIds,undefined);assert.equal(result.verifiedTargets,0);assert.equal(result.uncertainEpisodeIds.length,32);
 clock+=1800000;await verifyCachedPositiveCoverage(options);assert.equal(calls.length,33,'a later scheduled pass obtains fresh evidence');
});

test('changed revisions and scope are revisited without extending expired proof',async()=>{
 const cache=new Map();let clock=100,revision=0;const calls=[];const options={request,cached,cache,maxChecks:1,now:()=>clock,readRevision:({episodeId})=>episodeId===1001?revision:0,readShoko:async({episodeId})=>{calls.push(episodeId);return {state:'unavailable'}},readPublic:async()=>({state:'unknown'})};
 await verifyCachedPositiveCoverage(options);clock+=6000;revision++;await verifyCachedPositiveCoverage(options);assert.ok(calls.includes(1001));const end=await verifyCachedPositiveCoverage(options);assert.equal(end.pendingEpisodeIds,undefined);assert.equal(end.verifiedTargets,0);
 const extra={...request,episodeIds:[...request.episodeIds,1003]};await verifyCachedPositiveCoverage({...options,request:extra,cached:{targetCount:3,verifiedTargets:3,availableEpisodeIds:extra.episodeIds}});assert.ok(calls.includes(1003));
});

test('a slow coverage pass stops rapid continuation at its bounded deadline while retaining uncertainty',async()=>{
 const cache=new Map();let clock=100;const calls=[];const options={request,cached,cache,maxChecks:1,now:()=>clock,readShoko:async({episodeId})=>{calls.push(episodeId);return {state:'unavailable'}},readPublic:async()=>({state:'unknown'})};await verifyCachedPositiveCoverage(options);clock+=900001;const r=await verifyCachedPositiveCoverage(options);assert.equal(r.pendingEpisodeIds,undefined);assert.equal(r.uncertainEpisodeIds.length,2);assert.equal(calls.length,1);
});

test('sweep capacity cannot discard active progress and restart provider reads forever',async()=>{
 const cache=new Map();let calls=0;const options={request,cached,cache,maxChecks:1,now:()=>100,readShoko:async()=>{calls++;return {state:'unavailable'}},readPublic:async()=>({state:'unknown'})};
 for(let id=1;id<=64;id++)await verifyCachedPositiveCoverage({...options,request:{...request,id,anidbId:42+id}});
 const overflow=await verifyCachedPositiveCoverage({...options,request:{...request,id:65,anidbId:107}});assert.equal(overflow.pendingEpisodeIds,undefined);assert.equal(overflow.uncertainEpisodeIds.length,2);assert.equal(calls,64);
 const first=await verifyCachedPositiveCoverage({...options,request:{...request,id:1,anidbId:43}});assert.equal(first.pendingEpisodeIds,undefined);assert.equal(calls,65);
});

test('incomplete Shoko siblings permit exact public proof but never absence', async()=>{
 for(const state of ['available','unknown']){
 const result=await verifyCachedPositiveCoverage({request,cached,readShoko:async()=>({state:'ok',complete:false,files:[{fileId:9}]}),readPublic:async()=>({state})});
 assert.equal(result.verifiedTargets,state==='available'?2:0);assert.deepEqual(result.uncertainEpisodeIds??[],state==='available'?[]:[1001,1002]);
 }
 const result=await verifyCachedPositiveCoverage({request,cached,readShoko:async()=>({state:'ok',complete:false,files:[]}),readPublic:async()=>{throw Error('empty response cannot prove availability')}});
 assert.deepEqual(result.uncertainEpisodeIds,[1001,1002]);
});
