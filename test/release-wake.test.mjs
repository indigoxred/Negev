import assert from 'node:assert/strict';
import test from 'node:test';
import {createReleaseWake} from '../src/acquisition/release-wake.mjs';

test('RSS wakes acquisition before and after targeted metadata, coalescing overlapping feeds',async()=>{
 const calls=[];let finish;const wake=createReleaseWake({wakeRequest:id=>calls.push(['wake',id]),pollWatch:async id=>{calls.push(['metadata',id]);await new Promise(r=>finish=r);}});
 const first=wake(7);const second=wake(7);assert.equal(first,second);assert.deepEqual(calls,[['wake',7],['metadata',7]]);
 finish();await first;assert.deepEqual(calls,[['wake',7],['metadata',7],['wake',7]]);
});

test('metadata failure cannot prevent the guarded request worker from waking',async()=>{
 const calls=[];const wake=createReleaseWake({wakeRequest:id=>calls.push(id),pollWatch:async()=>{throw Error('provider offline')}});await wake(7);assert.deepEqual(calls,[7,7]);
});


test('an RSS metadata refresh gets bounded prompt follow-up checks',async()=>{
 let polls=0,pauses=0;const wake=createReleaseWake({wakeRequest:()=>{},pause:async()=>{pauses++},pollWatch:async()=>({results:[{reason:++polls<3?'episode_metadata_pending':null}]})});await wake(7);assert.equal(polls,3);assert.equal(pauses,2);await wake.close();
});

test('RSS episode hints are metadata prompts, not arbitrary numeric title matches',async()=>{
 const {observedReleaseEpisodes}=await import('../src/acquisition/release-wake.mjs');assert.deepEqual(observedReleaseEpisodes(['[Group] Example - 08 (1080p) [1234ABCD]','Example S02E08 1080p','Example - 01-12 [Batch]','Example 1080p 2026']),[8]);
});


test('a later indexer episode hint is retained during an in-flight watch read',async()=>{
 let finish;const calls=[];const wake=createReleaseWake({wakeRequest:()=>{},pollWatch:async(id,notice)=>{calls.push(notice.releaseTitles);if(calls.length===1)await new Promise(r=>finish=r);return{results:[]}}});
 const first=wake(7,{releaseTitles:['Example - 07 (1080p)']});const second=wake(7,{releaseTitles:['Example - 08 (1080p)']});assert.equal(first,second);finish();await first;
 assert.equal(calls.length,2);assert.deepEqual(calls[1],['Example - 07 (1080p)','Example - 08 (1080p)']);await wake.close();
});
