import test from 'node:test';import assert from 'node:assert/strict';
import {readBoundedText,cancelResponseBody} from '../src/http/bounded-response.mjs';
async function beforeCleanup(promise,cleanup){
 let timer;const result=promise.then(value=>({value}),error=>({error}));let first;
 try{first=await Promise.race([result,new Promise(resolve=>timer=setTimeout(()=>resolve({pending:true}),100))])}
 finally{clearTimeout(timer);await cleanup();await result}
 return first;
}
for(const [label,headers,bytes] of [
 ['declared overflow',{'content-length':'999'},null],
 ['stream overflow',{},new TextEncoder().encode('a'.repeat(20))],
 ['invalid UTF-8',{},new Uint8Array([255])],
])test(`rejected cloned response does not await an unrelated unread branch: ${label}`,async()=>{
 let cancelled=false;const original=new Response(new ReadableStream({start(c){if(bytes)c.enqueue(bytes)},cancel(){cancelled=true}}),{headers});
 const clone=original.clone(),result=await beforeCleanup(readBoundedText(clone,10),()=>original.body.cancel());
 assert.equal(result.pending,undefined,'rejection must be actionable before the other branch is disposed');
 assert.ok(result.error instanceof Error);assert.equal(clone.bodyUsed,true);assert.equal(cancelled,true);
});
test('declared rejection initiates cleanup but never waits for unbounded cancellation',async()=>{
 let finish,cancelled=false;const response=new Response(new ReadableStream({cancel(){cancelled=true;return new Promise(resolve=>finish=resolve)}}),{headers:{'content-length':'999'}});
 const result=await beforeCleanup(readBoundedText(response,10),async()=>finish());
 assert.equal(cancelled,true);assert.equal(result.pending,undefined);assert.match(result.error?.message??'',/byte limit/);
});
test('body cleanup catches a late asynchronous cancellation rejection',async()=>{
 let reject,cancelled=false;const response=new Response(new ReadableStream({cancel(){cancelled=true;return new Promise((resolve,no)=>reject=no)}}));
 const result=await beforeCleanup(Promise.resolve(cancelResponseBody(response)),async()=>{reject(Error('cleanup failed'));await new Promise(resolve=>setImmediate(resolve))});
 assert.equal(cancelled,true);assert.equal(result.pending,undefined);
});
