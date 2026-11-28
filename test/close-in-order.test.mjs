import test from 'node:test';
import assert from 'node:assert/strict';
import { closeInOrder, createShutdownListener } from '../src/runtime/close-in-order.mjs';

for(const failed of [0,1,2,3])test(`ordered cleanup continues after step ${failed} fails`,async()=>{
 const calls=[];
 const steps=['stop downloads','stop events','wait observations','close database'].map((name,index)=>[name,async()=>{calls.push(name);if(index===failed)throw Error(`failure ${index}`);}]);
 await assert.rejects(()=>closeInOrder(steps),error=>error instanceof AggregateError && error.errors.length===1 && error.errors[0].cause.message===`failure ${failed}`);
 assert.deepEqual(calls,steps.map(([name])=>name));
});

test('cleanup waits for in-flight work before closing databases, even after another stop fails',async()=>{
 let release,closed=false;const pending=new Promise(resolve=>release=resolve);
 const result=closeInOrder([['first worker',()=>{throw Error('stop failure');}],['running worker',()=>pending],['database',()=>closed=true]]);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
 release();await assert.rejects(result,AggregateError);assert.equal(closed,true);
});

test('a signal listener handles one shutdown rejection without an unhandled promise',async()=>{
 let stops=0,reports=0;
 const listener=createShutdownListener(async()=>{stops++;throw Error('close failure');},error=>{reports++;assert.equal(error.message,'close failure');});
 await Promise.all([listener(),listener()]);assert.equal(stops,1);assert.equal(reports,1);
 const brokenLog=createShutdownListener(async()=>{throw Error('close failure');},()=>{throw Error('log failure');});
 await assert.doesNotReject(brokenLog());
});
