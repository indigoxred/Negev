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
