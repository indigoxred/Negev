import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogueFetch } from '../src/catalogue/catalogue-fetch.mjs';
const url=id=>`https://animap.id/api/anidb/${id}`;
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const tick=()=>new Promise(r=>setImmediate(r));

test('shared catalogue slots include body reads and identical lookups share one independent response',async()=>{
 let calls=0,active=0,peak=0;const releases=[];
 const read=createCatalogueFetch({concurrency:4,fetchImpl:async()=>{calls++;active++;peak=Math.max(peak,active);return new Response(new ReadableStream({start(c){releases.push(()=>{active--;c.enqueue(new TextEncoder().encode('{"ok":true}'));c.close();});}}));}});
 const reads=Array.from({length:8},(_,i)=>read(url(i+1)));const duplicate=read(url(1));await tick();assert.equal(calls,4);assert.equal(peak,4);
 releases.splice(0).forEach(r=>r());await tick();assert.equal(calls,8);releases.splice(0).forEach(r=>r());
 const responses=await Promise.all([...reads,duplicate]);assert.equal(calls,8);for(const r of responses)assert.deepEqual(await r.json(),{ok:true});assert.equal(peak,4);
});

test('detail cache is shared by readers, bounded and expires',async()=>{
 let time=1000,calls=0;const read=createCatalogueFetch({now:()=>time,cacheMs:100,maxEntries:2,fetchImpl:async()=>{calls++;return json({calls});}});
 await read(url(1));await read(url(1));assert.equal(calls,1);await read(url(2));await read(url(3));await read(url(1));assert.equal(calls,4);time+=101;await read(url(1));assert.equal(calls,5);
});

test('network, malformed and HTTP failures are cached briefly then can recover',async()=>{
 for(const mode of ['network','invalid','http']){let time=1000,calls=0;const read=createCatalogueFetch({now:()=>time,failureMs:100,fetchImpl:async()=>{calls++;if(calls>1)return json({ok:true});if(mode==='network')throw Error('offline');return mode==='invalid'?new Response('not json'):new Response('',{status:500});}});
 for(let i=0;i<2;i++)await read(url(1)).catch(()=>null);assert.equal(calls,1,mode);time+=101;assert.deepEqual(await (await read(url(1))).json(),{ok:true});assert.equal(calls,2);}
});

test('Retry-After applies to different AniMap paths and the large streamed map without affecting other providers',async()=>{
 let time=1000,calls=[];const read=createCatalogueFetch({now:()=>time,failureMs:10,fetchImpl:async u=>{calls.push(String(u));return calls.length===1?new Response('',{status:429,headers:{'Retry-After':'120'}}):json({ok:true});}});
 assert.equal((await read(url(1))).status,429);assert.equal((await read(url(2))).status,429);assert.equal((await read('https://animap.id/api/v1/map')).status,429);assert.equal(calls.length,1);
 await read('https://graphql.anilist.co',{method:'POST',body:'{"query":"x"}'});assert.equal(calls.length,2);time+=120001;assert.equal((await read(url(2))).status,200);assert.equal(calls.length,3);
});

test('HTTP-date cooldown is shared and the longest outstanding provider deadline wins',async()=>{
 let time=Date.parse('2026-11-22T01:00:00Z'),calls=0;const read=createCatalogueFetch({now:()=>time,fetchImpl:async()=>{calls++;return new Response('',{status:503,headers:{'Retry-After':new Date(time+90000).toUTCString()}});}});
 await read(url(1));time+=60001;assert.equal((await read(url(2))).status,503);assert.equal(calls,1);time+=30000;await read(url(2));assert.equal(calls,2);
});

test('one aborted viewer does not cancel the shared lookup needed by another viewer',async()=>{
 let resolve,calls=0;const controller=new AbortController();const read=createCatalogueFetch({fetchImpl:()=>{calls++;return new Promise(r=>{resolve=r;});}});
 const a=read(url(1),{signal:controller.signal});const b=read(url(1));await tick();controller.abort();await assert.rejects(a,{name:'AbortError'});resolve(json({ok:true}));assert.deepEqual(await (await b).json(),{ok:true});assert.equal(calls,1);
});

test('an abandoned queued lookup does not dispatch and queue overflow fails promptly',async()=>{
 let calls=0,resolve;const read=createCatalogueFetch({concurrency:1,maxPending:1,fetchImpl:()=>{calls++;return new Promise(r=>{resolve=r;});}});
 const first=read(url(1));await tick();const c=new AbortController();const second=read(url(2),{signal:c.signal});const overflow=await read(url(3));assert.equal(overflow.status,503);c.abort();await assert.rejects(second,{name:'AbortError'});resolve(json({ok:true}));await first;await tick();assert.equal(calls,1);
});

test('positive cache byte budget and malformed/oversized bodies cannot grow without bound',async()=>{
 let calls=0;const read=createCatalogueFetch({maxCacheBytes:16,fetchImpl:async()=>{calls++;return json({payload:'longer than sixteen bytes'});}});await read(url(1));await read(url(1));assert.equal(calls,2);
 const oversized=createCatalogueFetch({fetchImpl:async()=>new Response('x'.repeat(128001))});await assert.rejects(oversized(url(1)));
});

test('GraphQL requests deduplicate only identical bodies and full map stays streamed rather than buffered',async()=>{
 let calls=0;const read=createCatalogueFetch({fetchImpl:async u=>{calls++;return json({data:{value:calls}});}});const gql='https://graphql.anilist.co';await read(gql,{method:'POST',body:'a'});await read(gql,{method:'POST',body:'a'});await read(gql,{method:'POST',body:'b'});assert.equal(calls,2);
 await read('https://animap.id/api/v1/map');await read('https://animap.id/api/v1/map');assert.equal(calls,4,'map ownership/single-flight remains with the existing streamed reader');
});

test('acquisition, authenticated endpoints and artwork bytes bypass the public metadata cache',async()=>{
 let calls=0;const read=createCatalogueFetch({fetchImpl:async()=>{calls++;return json({calls});}});
 for(const u of ['http://shoko/api/v3/AniDB/1','https://animap.id/api/v1/file/abc','https://cdn.anidb.net/images/main/1.jpg']){await read(u);await read(u);}assert.equal(calls,6);
 await read(url(1),{headers:{Authorization:'private'}});await read(url(1),{headers:{Authorization:'private'}});assert.equal(calls,8);
});

test('seasonal and title/poster readers reuse the same bounded exact AniDB payload',async()=>{
 const {createSeasonalCatalogue}=await import('../src/catalogue/seasonal-catalogue.mjs');
 const {createAniDbDisplayReader}=await import('../src/catalogue/anidb-display-reader.mjs');
 const calls=[];let active=0,peak=0;
 const fetchImpl=createCatalogueFetch({fetchImpl:async u=>{calls.push(String(u));if(String(u).endsWith('/api/v1/map'))return json({lastUpdate:'2026-11-22',data:Array.from({length:6},(_,i)=>({title:'Title '+i,type:'TV',animeSeason:{year:2026,season:'FALL'},sources:['https://anidb.net/anime/'+(i+1)]}))});active++;peak=Math.max(peak,active);await tick();active--;return json({anidb_id:Number(String(u).split('/').at(-1)),title:'Title',type:'TV Series',restricted:false,tags:[]});}});
 const catalogue=createSeasonalCatalogue({fetchImpl});const display=createAniDbDisplayReader({fetchImpl});
 const [a,b,c]=await Promise.all([catalogue.read({year:2026,season:'FALL',limit:4}),catalogue.read({year:2026,season:'FALL',limit:4,after:2}),display.read({anidbId:1})]);
 assert.equal(a.items.length,4);assert.equal(b.items.length,4);assert.equal(c.state,'display');assert.equal(calls.filter(u=>u.endsWith('/api/v1/map')).length,1);assert.equal(calls.filter(u=>u===url(1)).length,1);assert.equal(calls.length,7);assert.ok(peak<=4);
});

test('active admission and aborted queued jobs leave capacity for a healthy replacement',async()=>{
 let resolve;const seen=[];const read=createCatalogueFetch({concurrency:1,maxPending:1,fetchImpl:async u=>{seen.push(String(u));if(String(u)===url(1))return new Promise(r=>{resolve=r;});return json({ok:true});}});
 const a=read(url(1)),c=new AbortController(),b=read(url(2),{signal:c.signal});await tick();assert.deepEqual(seen,[url(1)]);c.abort();await assert.rejects(b,{name:'AbortError'});const replacement=read(url(3));resolve(json({ok:true}));assert.equal((await a).status,200);assert.equal((await replacement).status,200);assert.deepEqual(seen,[url(1),url(3)]);
});

test('an early rejected body is cancelled before another queued lookup uses its slot',async()=>{
 let cancelled=false,observed=false;const read=createCatalogueFetch({concurrency:1,fetchImpl:async u=>{if(String(u)===url(1))return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':'128001'}});observed=cancelled;return json({ok:true});}});
 const a=read(url(1)).catch(()=>null),b=read(url(2));await a;await b;assert.equal(cancelled,true);assert.equal(observed,true);
});

test('same-key cooldown responses count down and do not outlive their absolute deadline',async()=>{
 let time=1000,calls=0;const read=createCatalogueFetch({now:()=>time,fetchImpl:async()=>++calls===1?new Response('',{status:503,headers:{'Retry-After':'2'}}):json({ok:true})});
 assert.equal((await read(url(1))).headers.get('retry-after'),'2');time+=1000;assert.equal((await read(url(1))).headers.get('retry-after'),'1');time+=2001;assert.equal((await read(url(1))).status,200);assert.equal(calls,2);
});

test('zero and elapsed Retry-After do not create a new provider blackout',async()=>{
 for(const retry of ['0','Sun, 22 Nov 2026 00:00:00 GMT']){let calls=0;const read=createCatalogueFetch({now:()=>Date.parse('2026-11-22T01:00:00Z'),fetchImpl:async()=>++calls===1?new Response('',{status:503,headers:{'Retry-After':retry}}):json({ok:true})});await read(url(1));assert.equal((await read(url(2))).status,200);assert.equal(calls,2);}
});

test('a later viewer can join existing work during a different-path provider cooldown',async()=>{
 let resolve,calls=0;const read=createCatalogueFetch({fetchImpl:async u=>{calls++;if(String(u)===url(1))return new Promise(r=>{resolve=r;});return new Response('',{status:503,headers:{'Retry-After':'60'}});}});
 const a=read(url(1));await tick();await read(url(2));const b=read(url(1));resolve(json({ok:true}));assert.equal((await a).status,200);assert.equal((await b).status,200);assert.equal(calls,2);
});

test('stalled body timeout cancels the reader and frees its shared slot',async()=>{
 let cancelled=false;const read=createCatalogueFetch({concurrency:1,timeoutMs:20,fetchImpl:async u=>String(u)===url(1)?new Response(new ReadableStream({cancel(){cancelled=true;}})):json({ok:true})});
 const a=read(url(1)).catch(()=>null),b=read(url(2));await a;assert.equal((await b).status,200);assert.equal(cancelled,true);
});

test('overlapping provider failures preserve the later absolute deadline for both keys',async()=>{
 let time=1000;const replies=new Map();const read=createCatalogueFetch({now:()=>time,fetchImpl:u=>new Promise(resolve=>replies.set(String(u),resolve))});
 const a=read(url(1)),b=read(url(2));await tick();replies.get(url(1))(new Response('',{status:503,headers:{'Retry-After':'120'}}));await a;time+=1000;replies.get(url(2))(new Response('',{status:429,headers:{'Retry-After':'2'}}));assert.equal((await b).headers.get('retry-after'),'119');assert.equal((await read(url(2))).headers.get('retry-after'),'119');assert.equal((await read(url(1))).headers.get('retry-after'),'119');
});
