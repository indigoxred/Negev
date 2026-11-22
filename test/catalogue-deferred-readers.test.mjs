import assert from 'node:assert/strict';import test from 'node:test';
import {createCatalogueFetch} from '../src/catalogue/catalogue-fetch.mjs';
import {createAniDbDisplayReader} from '../src/catalogue/anidb-display-reader.mjs';
import {createAniDbMapFactsReader} from '../src/catalogue/anidb-map-facts.mjs';
import {createPosterReader} from '../src/catalogue/poster-reader.mjs';
import {createAniDbGroupReader} from '../src/catalogue/anidb-group-reader.mjs';
import {openMappedScoreCache} from '../src/catalogue/mapped-score-cache.mjs';
import {openAniListRankingCache} from '../src/catalogue/anilist-ranking-cache.mjs';
const reply=x=>new Response(JSON.stringify(x));
const rank={data:Object.fromEntries(['s1','s2','s3','p1','p2','p3'].map(k=>[k,{media:k.endsWith('1')?[{idMal:11,averageScore:90,popularity:1000}]:[]}]))};

test('real display, facts, poster and group readers recover after a brief shared deferral',async()=>{
 let time=1000,fail=true;const fetchImpl=createCatalogueFetch({now:()=>time,fetchImpl:async u=>{if(fail){fail=false;return new Response('',{status:503,headers:{'Retry-After':'2'}});}if(String(u).includes('cdn.anidb.net'))return new Response(Buffer.from([255,216,255]),{headers:{'content-type':'image/jpeg'}});if(String(u).endsWith('/groups'))return reply([{anidb_group_id:1,name:'Group',short_name:'G'}]);if(String(u).includes('/v1/map/anidb/'))return reply({sources:['https://anidb.net/anime/1'],animeSeason:{year:2026,season:'FALL'},studios:[]});return reply({anidb_id:1,title:'Title',type:'TV Series',restricted:false,tags:[],picture:'1.jpg'});}});
 const display=createAniDbDisplayReader({fetchImpl,now:()=>time}),facts=createAniDbMapFactsReader({fetchImpl,now:()=>time}),poster=createPosterReader({fetchImpl,now:()=>time}),groups=createAniDbGroupReader({fetchImpl,now:()=>time});
 await fetchImpl('https://animap.id/api/anidb/999');assert.equal((await display.read({anidbId:1})).state,'unavailable');assert.equal((await facts.read({anidbId:1})).state,'unavailable');assert.equal((await poster.read({anidbId:1})).state,'unavailable');assert.equal((await groups.read()).match('Group'),null);
 time+=2001;assert.equal((await display.read({anidbId:1})).state,'display');assert.equal((await facts.read({anidbId:1})).state,'facts');assert.equal((await poster.read({anidbId:1})).state,'image');assert.equal((await groups.read()).match('Group')?.state,'listed');
});

test('a shared cooldown cannot erase a usable score and does not delay its next refresh by an hour',async()=>{
 let time=1000,fail=false,calls=0;const fetchImpl=createCatalogueFetch({now:()=>time,fetchImpl:async u=>{calls++;if(fail){fail=false;return new Response('',{status:503,headers:{'Retry-After':'2'}});}return reply({mal_id:11,score:8.2,scored_by:100,members:1000});}});
 const cache=openMappedScoreCache({dbPath:':memory:',fetchImpl,now:()=>time,minGapMs:0});try{const entries=[{anidbId:1,malId:11}];cache.prime(entries);await cache.whenIdle();assert.equal(cache.get(1,11)?.score,8.2);time+=8*86400000;fail=true;await fetchImpl('https://animap.id/api/anidb/999');cache.prime(entries);await cache.whenIdle();assert.equal(cache.get(1,11)?.score,8.2);const before=calls;time+=2001;cache.prime(entries);await cache.whenIdle();assert.ok(calls>before);assert.equal(cache.get(1,11)?.score,8.2);}finally{cache.close();}
});

test('cold ranking retries at the shared deadline instead of adding a fifteen-minute delay',async()=>{
 let time=1000,calls=0;const fetchImpl=createCatalogueFetch({now:()=>time,fetchImpl:async()=>++calls===1?new Response('',{status:503,headers:{'Retry-After':'2'}}):reply(rank)});const cache=openAniListRankingCache({dbPath:':memory:',fetchImpl,now:()=>time});try{assert.equal((await cache.read('all')).state,'unavailable');time+=2001;assert.equal((await cache.read('all')).state,'ready');assert.equal(calls,2);}finally{cache.close();}
});

test('a group reader timing out in the shared queue retries shortly after capacity returns',async()=>{
 let time=1000,release;const fetchImpl=createCatalogueFetch({concurrency:1,now:()=>time,fetchImpl:async u=>String(u).endsWith('/999')?new Promise(resolve=>{release=resolve;}):reply([{anidb_group_id:1,name:'Group',short_name:'G'}])});const busy=fetchImpl('https://animap.id/api/anidb/999');await new Promise(r=>setImmediate(r));const groups=createAniDbGroupReader({fetchImpl,now:()=>time,timeoutMs:20});assert.equal((await groups.read()).match('Group'),null);release(reply({ok:true}));await busy;time+=1001;assert.equal((await groups.read()).match('Group')?.state,'listed');
});
