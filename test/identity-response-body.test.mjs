import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {createPlexAvailabilityService} from '../src/availability/plex-availability-service.mjs';
import {cancelResponseBody} from '../src/http/bounded-response.mjs';
const bytes=new TextEncoder();
async function fixture(run){
 const root=await mkdtemp(path.join(os.tmpdir(),'identity-body-'));let service,response,reads=0,clock=1000,fetchResponse;
 try{
 service=createPlexAvailabilityService({dbPath:path.join(root,'state.sqlite'),shokoBaseUrl:'http://shoko:8111/',shokoApiKey:'synthetic',plexBaseUrl:'http://plex:32400/',plexToken:'synthetic',publicSections:{episode:[102],movie:[]},shokoMount:{appRoot:'/pure',localRoot:root},plexMount:{appRoot:'/plex',localRoot:root},enforceScope:true,now:()=>clock,fetchImpl:async(url,init)=>{assert.equal(url.pathname,'/identity');assert.equal(init.redirect,'manual');assert.equal(init.headers['X-Plex-Token'],'synthetic');assert.ok(init.signal instanceof AbortSignal);reads++;response=await fetchResponse(init);return response;}});
 await run({service,setResponse(fn){fetchResponse=fn;},response:()=>response,reads:()=>reads,advance(ms){clock+=ms;}});
 }finally{service?.close();if(response?.body&&!response.bodyUsed)await cancelResponseBody(response);await rm(root,{recursive:true,force:true});}
}
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise(resolve=>timer=setTimeout(()=>resolve('blocked'),500))]);}finally{clearTimeout(timer);}}

for(const [status,mode]of [[503,'normal'],[401,'normal'],[302,'normal'],[503,'reject'],[503,'pending'],[503,'throw']])test(`rejected identity ${status} disposes its open body without waiting on ${mode} cancellation`,()=>fixture(async f=>{
 let cancels=0;
 f.setResponse(()=>{const response=new Response(new ReadableStream({start(c){c.enqueue(bytes.encode('rejected body'));},cancel(){cancels++;if(mode==='reject')return Promise.reject(Error('synthetic cancel rejection'));if(mode==='pending')return new Promise(()=>{});}}),{status});if(mode==='throw')response.body.cancel=()=>{cancels++;throw Error('synthetic synchronous cancellation failure');};return response;});
 const outcomes=await bounded(Promise.all([f.service.ensureScope(),f.service.ensureScope()]));assert.notEqual(outcomes,'blocked','body disposal must not hold the identity failure path');assert.deepEqual(outcomes,[{state:'held',reason:'public_scope_unverified'},{state:'held',reason:'public_scope_unverified'}]);assert.equal(f.service.isScopeCurrent(),false);assert.equal(f.service.getScopeGeneration(),null);assert.equal(f.reads(),1);assert.equal(cancels,1,'the rejected response body must be cancelled once');
 await f.service.ensureScope();assert.equal(f.reads(),1,'scope failure cooldown remains active');assert.equal(cancels,1);
 await new Promise(resolve=>setImmediate(resolve)); // Surface an unhandled cancellation rejection, if any.
}));

for(const [label,payload,ready]of [['valid',{MediaContainer:{machineIdentifier:'synthetic-machine'}},true],['invalid identity',{MediaContainer:{machineIdentifier:'bad identity'}},false],['invalid JSON','bad-json',false]])test(`identity 200 ${label} consumes its body before ${ready?'trusting':'rejecting'} scope`,()=>fixture(async f=>{
 let cancels=0;
 f.setResponse(()=>new Response(new ReadableStream({start(c){c.enqueue(bytes.encode(typeof payload==='string'?payload:JSON.stringify(payload)));c.close();},cancel(){cancels++;}})));
 const outcomes=await Promise.all([f.service.ensureScope(),f.service.ensureScope()]);assert.equal(f.reads(),1);assert.equal(outcomes[0].state,ready?'ready':'held');assert.deepEqual(outcomes[0],outcomes[1]);assert.equal(f.service.isScopeCurrent(),ready);assert.equal(f.response().bodyUsed,true);assert.equal(f.response().body.locked,false);assert.equal(cancels,0,'a fully consumed body needs no cleanup cancellation');
}));

for(const declared of [false,true])test(`oversized identity 200 ${declared?'declared':'streamed'} body retains bounded-reader cleanup`,()=>fixture(async f=>{
 let cancels=0;
 f.setResponse(()=>new Response(new ReadableStream({start(c){c.enqueue(bytes.encode('x'.repeat(100001)));},cancel(){cancels++;}}),{headers:declared?{'Content-Length':'100001'}:{}}));
 assert.equal((await f.service.ensureScope()).state,'held');assert.equal(f.service.isScopeCurrent(),false);assert.equal(cancels,1);assert.equal(f.reads(),1);
}));

test('identity transport and body errors remain fail-closed',()=>fixture(async f=>{
 f.setResponse(()=>{throw Error('synthetic transport failure');});assert.equal((await f.service.ensureScope()).state,'held');assert.equal(f.service.isScopeCurrent(),false);assert.equal(f.reads(),1);
 f.advance(30001);f.setResponse(()=>new Response(new ReadableStream({start(c){c.error(Error('synthetic body failure'));}})));assert.equal((await f.service.ensureScope()).state,'held');assert.equal(f.service.isScopeCurrent(),false);assert.equal(f.reads(),2);
}));

test('an open identity 200 body still obeys the existing ten-second request deadline',{timeout:12000},()=>fixture(async f=>{
 let signal;f.setResponse(init=>{signal=init.signal;return new Response(new ReadableStream({start(c){c.enqueue(bytes.encode('{'));signal.addEventListener('abort',()=>c.error(signal.reason),{once:true});}}));});
 const keepAlive=setTimeout(()=>{},11000),start=performance.now();let outcomes;try{outcomes=await Promise.all([f.service.ensureScope(),f.service.ensureScope()]);}finally{clearTimeout(keepAlive);}
 assert.equal(signal.aborted,true);assert.ok(performance.now()-start>=9900,'the existing deadline must not be shortened');assert.deepEqual(outcomes.map(result=>result.state),['held','held']);assert.equal(f.service.isScopeCurrent(),false);assert.equal(f.reads(),1);
}));
