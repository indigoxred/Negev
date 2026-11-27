import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pollAiringWatches } from '../src/requests/airing-watch-poll.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';

const details = (anidbId, extra = {}) => ({ state: 'details', anidbId,
  kind: 'series', airDate: '2026-01-01', endDate: null, episodeCount: 12,
  restricted: false,
  complete: true, total: 2, episodes: [
    { id: 1001, type: 'Episode', airDate: '2026-01-01' },
    { id: 1002, type: 'Episode', airDate: '2026-02-01' },
  ], ...extra });

test('successful far-future observation records a weekly metadata due time', async () => {
  const recorded = [];
  const nowMs = Date.parse('2026-11-15T00:00:00Z');
  await pollAiringWatches({ today: '2026-11-15', nowMs, intervalMs: 0,
    ledger: { listActiveAirings: () => [{ requestId: 1, anidbId: 42 }],
      advanceAiring: () => ({ state: 'advanced', addedEpisodeIds: [] }),
      recordAiringTiming: (value) => recorded.push(value) },
    loadDetail: async () => details(42, { airDate: '2028-01-01',
      total: 0, episodes: [] }) });
  assert.equal(recorded[0].nextMetadataMs, nowMs + 7 * 86_400_000);
  assert.equal(recorded[0].feedIntervalMs, 86_400_000);
});

test('an 18+ watch adds no episodes for an owner without 18+ access', async () => {
  const advanced = [];
  const result = await pollAiringWatches({ today: '2026-01-20', intervalMs: 0,
    ledger: { listActiveAirings: () => [
      { requestId: 1, anidbId: 41, requesterId: 7 }, { requestId: 2, anidbId: 42, requesterId: 8 }],
      advanceAiring: (value) => { advanced.push(value.requestId); return { state: 'advanced' }; } },
    loadDetail: async ({ anidbId }) => details(anidbId, { restricted: true }),
    adultAllowed: ({ requesterId }) => requesterId === 8 });
  assert.deepEqual(advanced, [2], 'only the owner with 18+ access gets new episodes');
  assert.deepEqual(result.results.map((item) => item.reason ?? item.state),
    ['adult_access_disabled', 'advanced']);
});

test('the real ledger reports who owns each active airing watch', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-airing-owner-'));
  const requests = openRequestLedger(path.join(dir, 'requests.sqlite'));
  try {
    const db = new DatabaseSync(path.join(dir, 'requests.sqlite'));
    db.prepare(`INSERT INTO requests (requester_id,request_key,anidb_id,kind,episode_key,
      monitor_future,created_ms,status,reason) VALUES (9,'k',42,'series','all',1,1,'held','saved')`).run();
    db.close();
    assert.deepEqual(requests.listActiveAirings({ nowMs: 10 }), [{ requestId: 1, anidbId: 42, requesterId: 9 }]);
    assert.deepEqual(requests.listActiveAirings({ requestId: 1, nowMs: 10 }),
      [{ requestId: 1, anidbId: 42, requesterId: 9 }]);
  } finally { requests.close(); await rm(dir, { recursive: true, force: true }); }
});

test('one unavailable show holds while the next airing show advances', async () => {
  const calls = [];
  const result = await pollAiringWatches({ today: '2026-01-20',
    ledger: { listActiveAirings: () => [
      { requestId: 1, anidbId: 41 }, { requestId: 2, anidbId: 42 }],
      advanceAiring: (value) => { calls.push(value); return { state: 'advanced' }; } },
    loadDetail: async ({ anidbId }) => anidbId === 41
      ? { state: 'unavailable' } : details(anidbId),
    intervalMs: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requestId, 2);
  assert.equal(calls[0].releaseState, 'airing');
  assert.deepEqual(result.results.map((item) => item.state), ['held', 'advanced']);
  assert.equal(result.nextAfterId, null);
});

test('an upcoming watch stays open until its first episode airs', async () => {
  const calls = [];
  const result = await pollAiringWatches({ today: '2026-11-09', intervalMs: 0,
    ledger: { listActiveAirings: () => [{ requestId: 1, anidbId: 42 }],
      advanceAiring: (value) => { calls.push(value); return { state: 'advanced',
        addedEpisodeIds: [], watchClosed: false }; } },
    loadDetail: async () => details(42, { airDate: '2027-01-01',
      total: 0, episodes: [] }) });
  assert.equal(result.results[0].state, 'advanced');
  assert.equal(calls[0].releaseState, 'airing');
});

test('one failed watch write holds while the next watch advances', async () => {
  const advanced = [];
  const result = await pollAiringWatches({ today: '2026-01-20',
    intervalMs: 0, ledger: { listActiveAirings: () => [
      { requestId: 1, anidbId: 41 }, { requestId: 2, anidbId: 42 }],
    advanceAiring: ({ requestId }) => {
      if (requestId === 1) throw new Error('one watch write failed');
      advanced.push(requestId);
      return { state: 'advanced' };
    } },
    loadDetail: async ({ anidbId }) => details(anidbId) });
  assert.deepEqual(advanced, [2]);
  assert.deepEqual(result.results.map((item) => [item.state, item.reason]),
    [['held', 'watch_write_unavailable'], ['advanced', undefined]]);
});

test('an unknown age flag holds without blocking the next watch', async () => {
  const advanced = [];
  const result = await pollAiringWatches({ today: '2026-02-20', intervalMs: 0,
    ledger: { listActiveAirings: () => [
      { requestId: 1, anidbId: 42 }, { requestId: 2, anidbId: 43 }],
    advanceAiring: ({ requestId }) => { advanced.push(requestId);
      return { state: 'advanced' }; } },
    loadDetail: async ({ anidbId }) => details(anidbId,
      { restricted: anidbId === 42 ? null : false }) });
  assert.deepEqual(advanced, [2]);
  assert.deepEqual(result.results.map((item) => [item.state, item.reason]),
    [['held', 'restricted_or_unverified'], ['advanced', undefined]]);
});

test('an adult title with a verified age flag keeps its Airing watch', async () => {
  const advanced = [];
  const result = await pollAiringWatches({ today: '2026-02-20', intervalMs: 0,
    ledger: { listActiveAirings: () => [{ requestId: 1, anidbId: 42 }],
      advanceAiring: ({ requestId }) => { advanced.push(requestId);
        return { state: 'advanced' }; } },
    loadDetail: async () => details(42, { restricted: true }) });
  assert.deepEqual(advanced, [1]);
  assert.equal(result.results[0].state, 'advanced');
});

test('episode-count inference alone cannot close a watch; explicit past end date can', async () => {
  const endings = [details(42, { episodeCount: 2,
    episodes: [{ id: 1001, type: 'Episode', airDate: '2026-01-01' },
      { id: 1002, type: 'Episode', airDate: '2026-01-10' }] }),
  details(43, { endDate: '2026-02-15' })];
  const calls = [];
  const result = await pollAiringWatches({ today: '2026-02-20',
    ledger: { listActiveAirings: () => [
      { requestId: 1, anidbId: 42 }, { requestId: 2, anidbId: 43 }],
      advanceAiring: (value) => { calls.push(value); return { state: 'advanced' }; } },
    loadDetail: async ({ anidbId }) => endings.find((item) => item.anidbId === anidbId),
    intervalMs: 0 });
  assert.deepEqual(result.results.map((item) => item.state), ['advanced', 'advanced']);
  assert.equal(result.results[0].reason, 'completion_unconfirmed');
  assert.deepEqual(calls.map((item) => item.releaseState), ['airing', 'completed']);
});

test('a poll is bounded, serial, and pages by request ID', async () => {
  let active = 0;
  let peak = 0;
  const seen = [];
  const result = await pollAiringWatches({ today: '2026-01-20', afterId: 9,
    limit: 2, intervalMs: 0,
    ledger: { listActiveAirings: ({ afterId, limit }) => {
      assert.deepEqual([afterId, limit], [9, 2]);
      return [{ requestId: 10, anidbId: 42 }, { requestId: 11, anidbId: 43 }];
    }, advanceAiring: ({ requestId }) => { seen.push(requestId); return { state: 'advanced' }; } },
    loadDetail: async ({ anidbId }) => { active++; peak = Math.max(peak, active);
      await Promise.resolve(); active--; return details(anidbId); } });
  assert.equal(peak, 1);
  assert.deepEqual(seen, [10, 11]);
  assert.equal(result.nextAfterId, 11);
});

test('two users watching one installment share one catalogue read per page', async () => {
  let reads = 0;
  const advances = [];
  const result = await pollAiringWatches({ today: '2026-01-20', intervalMs: 0,
    ledger: { listActiveAirings: () => [
      { requestId: 1, anidbId: 42 }, { requestId: 2, anidbId: 42 }],
      advanceAiring: ({ requestId }) => { advances.push(requestId);
        return { state: 'advanced' }; } },
    loadDetail: async () => { reads++; return details(42); } });
  assert.equal(reads, 1);
  assert.deepEqual(advances, [1, 2]);
  assert.deepEqual(result.results.map((item) => item.state), ['advanced', 'advanced']);
});

test('one catalogue poll still advances historical duplicate watches without duplicate targets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'negev-airing-poll-'));
  const dbPath = path.join(root, 'requests.sqlite');
  const ledger = openRequestLedger(dbPath);
  try {
    const intent = { state: 'ready', anidbId: 42, kind: 'series',
      monitorFuture: true, episodeIds: [1001] };
    const first = ledger.submit({ requesterId: 1, requestKey: 'first',
      intent, nowMs: 1 });
    // Older releases allowed two accounts to save the same watch. Their
    // existing rows still need polling after new submissions are guarded.
    const db = new DatabaseSync(dbPath);
    const secondId = Number(db.prepare(`INSERT INTO requests
      (requester_id,request_key,anidb_id,kind,episode_key,monitor_future,
        created_ms,status,reason) VALUES
      (2,'second',42,'series','1001',1,2,'held','awaiting_availability_evidence')`)
      .run().lastInsertRowid);
    const targetId = db.prepare('SELECT id FROM targets WHERE anidb_id=42 AND episode_id=1001')
      .get().id;
    db.prepare('INSERT INTO request_targets(request_id,target_id) VALUES (?,?)')
      .run(secondId, targetId);
    db.close();
    let reads = 0;
    const result = await pollAiringWatches({ ledger, today: '2026-02-20',
      intervalMs: 0, loadDetail: async () => { reads++; return details(42); } });
    assert.equal(result.state, 'page');
    assert.equal(reads, 1);
    assert.deepEqual(ledger.getRequest(first.requestId).episodeIds, [1001, 1002]);
    assert.deepEqual(ledger.getRequest(secondId).episodeIds, [1001, 1002]);
    assert.equal(ledger.countTargets(), 2);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an ended series stays watched until its expected final episode appears', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'negev-airing-late-'));
  const ledger = openRequestLedger(path.join(root, 'requests.sqlite'));
  try {
    const saved = ledger.submit({ requesterId: 1, requestKey: 'late-final',
      intent: { state: 'ready', anidbId: 42, kind: 'series',
        monitorFuture: true, episodeIds: [1001] }, nowMs: 1 });
    const ended = details(42, { endDate: '2026-02-15', episodeCount: 3 });
    const first = await pollAiringWatches({ ledger, today: '2026-02-20',
      nowMs: Date.parse('2026-02-20T00:00:00Z'),
      intervalMs: 0, loadDetail: async () => ended });
    assert.equal(first.results[0].watchClosed, false);
    assert.deepEqual(ledger.getRequest(saved.requestId).episodeIds, [1001, 1002]);
    assert.equal(ledger.listActiveAirings().length, 1);

    const complete = { ...ended, total: 3, episodes: [...ended.episodes,
      { id: 1003, type: 'Episode', airDate: '2026-02-15' }] };
    const second = await pollAiringWatches({ ledger, today: '2026-02-21',
      nowMs: Date.parse('2026-02-21T00:00:00Z'),
      intervalMs: 0, loadDetail: async () => complete });
    assert.deepEqual(second.results[0].addedEpisodeIds, [1003]);
    assert.equal(second.results[0].watchClosed, true);
    assert.deepEqual(ledger.getRequest(saved.requestId).episodeIds,
      [1001, 1002, 1003]);
  } finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
});


test('an exact RSS watch refresh does not advance a different next watch',async()=>{
 const calls=[];const result=await pollAiringWatches({requestId:7,today:'2026-01-20',intervalMs:0,
 ledger:{listActiveAirings:options=>{calls.push(options);return[{requestId:8,anidbId:42}]},advanceAiring:()=>{throw Error('wrong watch')}},loadDetail:async()=>{throw Error('wrong read')}});
 assert.equal(result.state,'page');assert.equal(result.results.length,0);assert.equal(calls[0].afterId,6);assert.equal(calls[0].limit,1);
});


test('RSS with a not-yet-cached episode number requests bounded metadata hydration',async()=>{
 const calls=[];const result=await pollAiringWatches({requestId:7,expectedEpisodeNumbers:[3],today:'2026-03-01',intervalMs:0,
 ledger:{listActiveAirings:()=>[{requestId:7,anidbId:42}],advanceAiring:()=>{throw Error('new target metadata not present')}},
 loadDetail:async()=>details(42,{episodes:[{id:1001,number:1,type:'Episode',airDate:'2026-01-01'},{id:1002,number:2,type:'Episode',airDate:'2026-02-01'}]}),hydrateMetadata:async input=>calls.push(input)});
 assert.deepEqual(calls,[{anidbId:42,missingEpisodeNumber:3}]);assert.equal(result.results[0].reason,'episode_metadata_pending');
});


test('an exact RSS follow-up bypasses only its metadata deadline and retains cancellation guards',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'negev-rss-followup-'));const dbPath=path.join(root,'requests.sqlite');const ledger=openRequestLedger(dbPath);const hydrated=[];let reads=0;
 try{const saved=ledger.submit({requesterId:1,requestKey:'rss',nowMs:1,intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:true,episodeIds:[1001]}});const options={ledger,requestId:saved.requestId,today:'2026-03-01',nowMs:10000,intervalMs:0,loadDetail:async()=>{reads++;return details(42,{total:1,episodes:[{id:1001,number:1,type:'Episode',airDate:'2026-01-01'}]})},hydrateMetadata:async input=>hydrated.push(input)};
 await pollAiringWatches({...options,expectedEpisodeNumbers:[1]});assert.equal(ledger.listActiveAirings({nowMs:10001}).length,0);hydrated.length=0;
 const second=await pollAiringWatches({...options,nowMs:10001,expectedEpisodeNumbers:[1,2]});assert.equal(second.results[0]?.reason,'episode_metadata_pending');assert.deepEqual(hydrated,[{anidbId:42,missingEpisodeNumber:2}]);
 const db=new DatabaseSync(dbPath);db.prepare('UPDATE requests SET cancelled_ms=10002 WHERE id=?').run(saved.requestId);db.close();const before=reads;await pollAiringWatches({...options,nowMs:10003,expectedEpisodeNumbers:[2]});assert.equal(reads,before);
 }finally{ledger.close();await rm(root,{recursive:true,force:true});}
});
