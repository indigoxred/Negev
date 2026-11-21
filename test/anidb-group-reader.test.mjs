import test from 'node:test';
import assert from 'node:assert/strict';
import { createAniDbGroupReader } from '../src/catalogue/anidb-group-reader.mjs';
const rows=[{anidb_group_id:16037,name:'EMBER',short_name:'EMBER'},{anidb_group_id:2,name:'Anime Time',short_name:'AT'},{anidb_group_id:3,name:'Joint & Other',short_name:'Joint-Other'},{anidb_group_id:4,name:'Duplicate',short_name:'DUP'},{anidb_group_id:5,name:'Another duplicate',short_name:'DUP'}];
test('global groups match exact full/short names, not substrings, split joint groups or ambiguous aliases',async()=>{
 let calls=0;const reader=createAniDbGroupReader({fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://animap.id/api/anidb/groups');assert.equal(options.headers.Authorization,undefined);return Response.json(rows);}});
 const registry=await reader.read();assert.equal(registry.match(' ember ').groupId,16037);assert.equal(registry.match('anime   time').groupId,2);assert.equal(registry.match('AT').groupId,2);assert.equal(registry.match('Joint-Other').groupId,3);for(const name of ['EMB','EMBER2','Joint','DUP','Unknown'])assert.equal(registry.match(name),null);
 assert.equal((await reader.read()).match('EMBER').scope,'global');assert.equal(calls,1);
});
test('concurrent searches share one global list and expired evidence refreshes',async()=>{
 let clock=0,calls=0,finish;const reader=createAniDbGroupReader({now:()=>clock,fetchImpl:()=>{calls++;return new Promise(resolve=>{finish=()=>resolve(Response.json(rows));});}});
 const a=reader.read(),b=reader.read();await new Promise(r=>setImmediate(r));assert.equal(calls,1);finish();assert.strictEqual(await a,await b);clock=6*60*60_000+1;const c=reader.read();await new Promise(r=>setImmediate(r));assert.equal(calls,2);finish();await c;
});
test('failed or invalid lists remain neutral and back off instead of retrying per release',async()=>{
 for(const data of [null,{},[{anidb_group_id:-1,name:'EMBER'}],Array(30001).fill(rows[0])]){let calls=0;const reader=createAniDbGroupReader({fetchImpl:async()=>{calls++;return Response.json(data)}});assert.equal((await reader.read()).match('EMBER'),null);await reader.read();assert.equal(calls,1);}
 let calls=0;const reader=createAniDbGroupReader({fetchImpl:async()=>{calls++;throw Error('down')}});assert.equal((await reader.read()).match('EMBER'),null);await reader.read();assert.equal(calls,1);
});
test('a stalled provider cannot delay the search beyond its metadata deadline',async()=>{
 const reader=createAniDbGroupReader({timeoutMs:25,fetchImpl:()=>new Promise(()=>{})});const start=Date.now();assert.equal((await reader.read()).match('EMBER'),null);assert.ok(Date.now()-start<500);
});
