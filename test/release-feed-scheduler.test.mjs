import assert from 'node:assert/strict';
import test from 'node:test';
import { createReleaseFeedScheduler } from '../src/acquisition/release-feed-scheduler.mjs';

test('one hourly cycle reads each installed indexer once and never downloads', async () => {
  const calls = [];
  const timers = [];
  const scheduler = createReleaseFeedScheduler({ indexerIds: [5, 6],
    now: () => 60_000,
    feedLedger: { getPollIntervalMs: () => 3_600_000,
      accept: (value) => { calls.push(['accept', value.indexerId]);
        return { state: 'processed', newItems: 1, wokenRequests: 1 }; } },
    readFeed: async (indexerId) => { calls.push(['read', indexerId]);
      return { state: 'feed', items: [] }; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {} });
  scheduler.start();
  assert.equal(timers[0].ms, 60_000);
  await timers.shift().fn();
  assert.deepEqual(calls, [['read', 5], ['accept', 5],
    ['read', 6], ['accept', 6]]);
  assert.equal(timers.at(-1).ms, 3_600_000);
  await scheduler.stop();
});

test('no active watches cause no feed request and rate limits back off', async () => {
  const timers = [];
  let interval = null;
  let reads = 0;
  const scheduler = createReleaseFeedScheduler({ indexerIds: [5],
    now: () => 60_000,
    feedLedger: { getPollIntervalMs: () => interval,
      accept: () => { throw Error('must not accept failed feed'); } },
    readFeed: async () => { reads++; return { state: 'unavailable',
      retryAfterMs: 120_000 }; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {} });
  scheduler.start();
  await timers.shift().fn();
  assert.equal(reads, 0);
  assert.equal(timers.at(-1).ms, 60_000);
  interval = 3_600_000;
  await timers.shift().fn();
  assert.equal(reads, 1);
  assert.equal(timers.at(-1).ms, 300_000);
  await scheduler.stop();
});

test('a new airing watch shortens an existing far-future feed schedule', async () => {
  const timers = [];
  let clock = 60_000;
  let interval = 86_400_000;
  let reads = 0;
  const scheduler = createReleaseFeedScheduler({ indexerIds: [5],
    now: () => clock,
    feedLedger: { getPollIntervalMs: () => interval,
      accept: () => ({ state: 'processed', newItems: 0, wokenRequests: 0 }) },
    readFeed: async () => { reads++; return { state: 'feed', items: [] }; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {} });
  scheduler.start();
  await timers.shift().fn();
  assert.equal(reads, 1);
  assert.ok(timers.at(-1).ms <= 3_600_000);
  interval = 3_600_000;
  clock += 3_600_000;
  await timers.shift().fn();
  assert.equal(reads, 2);
  await scheduler.stop();
});

test('a failing indexer never stretches healthy hourly feeds across repeated backoffs',async()=>{
 let clock=0,bad=0;const timers=[],healthy=[];
 const scheduler=createReleaseFeedScheduler({indexerIds:[1,2],now:()=>clock,
  feedLedger:{getPollIntervalMs:()=>3600000,accept:()=>({wokenRequests:0})},
  readFeed:async id=>{if(id===2){bad++;return {state:'unavailable'}}healthy.push(clock);return {state:'feed',items:[]}},
  setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length},clearTimer:()=>{}});
 try{scheduler.start();for(let i=0;bad<9&&i<150;i++){const timer=timers.shift();assert.ok(timer);clock+=timer.ms;await timer.fn()}assert.equal(bad,9);assert.ok(healthy.length>9);assert.ok(healthy.slice(1).every((ms,i)=>ms-healthy[i]===3600000),JSON.stringify(healthy));}
 finally{await scheduler.stop()}
});

test('one feed Retry-After is respected without blocking another feed, and recovery resets its backoff',async()=>{
 let clock=0;const timers=[],calls=new Map([[1,[]],[2,[]]]);
 const scheduler=createReleaseFeedScheduler({indexerIds:[1,2],now:()=>clock,
  feedLedger:{getPollIntervalMs:()=>3600000,accept:()=>({wokenRequests:0})},
  readFeed:async id=>{calls.get(id).push(clock);return id===2&&calls.get(2).length===1?{state:'unavailable',retryAfterMs:14400000}:{state:'feed',items:[]}},
  setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length},clearTimer:()=>{}});
 try{scheduler.start();for(let i=0;calls.get(2).length<3&&i<30;i++){const timer=timers.shift();clock+=timer.ms;await timer.fn()}assert.equal(calls.get(2)[1]-calls.get(2)[0],14400000);assert.equal(calls.get(2)[2]-calls.get(2)[1],3600000);assert.ok(calls.get(1).slice(1).every((ms,i)=>ms-calls.get(1)[i]===3600000));}
 finally{await scheduler.stop()}
});

test('a provider refusing every feed with Retry-After cannot be polled early',async()=>{
 let clock=0;const timers=[],calls=new Map([[1,[]],[2,[]]]);
 const scheduler=createReleaseFeedScheduler({indexerIds:[1,2],now:()=>clock,
  feedLedger:{getPollIntervalMs:()=>3600000,accept:()=>({wokenRequests:0})},
  readFeed:async id=>{calls.get(id).push(clock);return {state:'unavailable',retryAfterMs:7200000}},
  setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length},clearTimer:()=>{}});
 try{scheduler.start();for(let i=0;calls.get(1).length<2&&i<10;i++){const timer=timers.shift();clock+=timer.ms;await timer.fn()}for(const times of calls.values())assert.equal(times[1]-times[0],7200000);}
 finally{await scheduler.stop()}
});

test('failed read or acceptance in the first indexer cannot stop later feeds',async()=>{
 let clock=0;const timers=[],read=[],accepted=[];
 const scheduler=createReleaseFeedScheduler({indexerIds:[1,2,3],now:()=>clock,
  feedLedger:{getPollIntervalMs:()=>3600000,accept:({indexerId})=>{accepted.push(indexerId);if(indexerId===2)throw Error('temporary ledger failure');return {wokenRequests:1}}},
  readFeed:async id=>{read.push(id);if(id===1)throw Error('temporary feed failure');return {state:'feed',items:[]}},
  setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length},clearTimer:()=>{}});
 try{scheduler.start();const timer=timers.shift();clock+=timer.ms;await timer.fn();assert.deepEqual(read,[1,2,3]);assert.deepEqual(accepted,[2,3]);assert.equal(scheduler.getLastResult().wokenRequests,1)}finally{await scheduler.stop()}
});

test('durable watch pages drain promptly between feed polls', async () => {
 const timers=[];let drains=0,pending=true,reads=0;
 const scheduler=createReleaseFeedScheduler({indexerIds:[5],now:()=>60000,
  feedLedger:{getPollIntervalMs:()=>3600000,accept:()=>({wokenRequests:0}),
   drainPendingWatches:()=>{drains++;return {wokenRequests:0}},hasPendingWatches:()=>pending},
  readFeed:async()=>{reads++;return {state:'feed',items:[]}},
  setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length},clearTimer:()=>{}});
 scheduler.start();await timers.shift().fn();
 assert.equal(drains,1);assert.equal(timers.at(-1).ms,1000);
 pending=false;await timers.shift().fn();assert.equal(drains,2);assert.equal(reads,1);
 await scheduler.stop();
});
