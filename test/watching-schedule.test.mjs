import assert from 'node:assert/strict';
import test from 'node:test';
import { createWatchingScheduleReader } from '../src/web/watching-schedule.mjs';
import { watchingNextAirLabel } from '../src/web/public/episode-schedule.mjs';
const watch={anidbId:42,kind:'series',status:'held',monitorFuture:true,watchClosed:false};
const episodes=[{id:1,type:'Episode',number:1,airDate:'2026-11-22'},
 {id:2,type:'Episode',number:2,airDate:'2026-11-29'},
 {id:3,type:'Special',number:1,airDate:'2026-11-23'}];

test('Watching uses cached regular schedule and skips already available same-day episodes',()=>{
 const reader=createWatchingScheduleReader({cachedIndex:()=>({regularEpisodes:episodes}),readDetail:()=>{throw Error('unexpected lookup');},today:()=> '2026-11-22',verifiedIds:()=>new Set([1])});
 assert.deepEqual(reader.read(watch),{nextAirDate:'2026-11-29',nextEpisodeNumber:2});
 assert.equal(watchingNextAirLabel({...watch,nextAir:reader.read(watch)}),'Next: Episode 2 · 2026-11-29');
});

test('cold metadata never blocks Requests, reuses an in-flight lookup and later exposes its schedule',async()=>{
 let index=null,finish,reads=0;const pending=new Promise(r=>finish=r);
 const reader=createWatchingScheduleReader({cachedIndex:()=>index,readDetail:()=>{reads++;return pending;},today:()=> '2026-11-22'});
 assert.equal(reader.read(watch),null);assert.equal(reader.read(watch),null);assert.equal(reads,1);
 index={regularEpisodes:episodes};finish();await new Promise(r=>setImmediate(r));
 assert.equal(reader.read(watch).nextAirDate,'2026-11-22');assert.equal(reads,1);
});

test('metadata warmup is bounded and failures have a cooldown, without blocking status',async()=>{
 let clock=1000,reads=0;const reader=createWatchingScheduleReader({cachedIndex:()=>null,readDetail:async()=>{reads++;throw Error('provider down');},today:()=> '2026-11-22',now:()=>clock,maxPending:2});
 for(let i=1;i<=30;i++)assert.equal(reader.read({...watch,anidbId:i}),null);
 assert.equal(reads,2);await new Promise(r=>setImmediate(r));
 reader.read({...watch,anidbId:1});assert.equal(reads,2);
 clock+=60000;reader.read({...watch,anidbId:1});assert.equal(reads,3);await new Promise(r=>setImmediate(r));
});

test('closed, cancelled, one-time and movie requests do not fetch or display an air date',()=>{
 const reader=createWatchingScheduleReader({cachedIndex:()=>{throw Error('unexpected lookup');},readDetail:()=>{throw Error('unexpected lookup');},today:()=> '2026-11-22'});
 for(const changed of [{watchClosed:true},{status:'cancelled'},{monitorFuture:false},{kind:'movie'}]){
  const item={...watch,...changed,nextAir:{nextAirDate:'2026-11-29',nextEpisodeNumber:2}};
  assert.equal(reader.read(item),null);assert.equal(watchingNextAirLabel(item),null);
 }
});

test('unknown and invalid dates are explicit; no weekday recurrence is invented',()=>{
 assert.equal(watchingNextAirLabel(watch),'Next air date unknown');
 assert.equal(watchingNextAirLabel({...watch,nextAir:{nextAirDate:'2026-02-30'}}),'Next air date unknown');
 assert.equal(watchingNextAirLabel({...watch,nextAir:{nextAirDate:'2026-11-29',nextEpisodeNumber:null}}),'Next: 2026-11-29');
});
