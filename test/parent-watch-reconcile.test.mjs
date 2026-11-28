import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openParentWatchLedger } from '../src/requests/parent-watch-ledger.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { reconcileParentWatch } from '../src/requests/parent-watch-reconcile.mjs';

const map = { version: 2, anime: [{ anidb_id: 11, tvdb_id: 100 }] };
const detail = (anidbId, extra = {}) => ({ state: 'details', anidbId,
  kind: 'series', title: `Anime ${anidbId}`, airDate: '2026-11-01',
  endDate: null, episodeCount: 12, restricted: false,
  complete: true, total: 1,
  episodes: [{ id: anidbId * 100, type: 'Episode', airDate: '2026-11-01' }],
  ...extra });
async function withLedgers(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-watch-reconcile-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const requests = openRequestLedger(dbPath);
  const parents = openParentWatchLedger(dbPath);
  try {
    parents.adopt({ tvdbId: 100, requesterId: 7,
      sourceSeriesId: 42, nowMs: 1000 });
    await run({ requests, parents });
  } finally {
    parents.close(); requests.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const noRelations = async (id) => ({ state: 'related_titles',
  anidbId: id, items: [] });

test('creates one durable Airing watch for an exact mapped installment', async () =>
  withLedgers(async ({ requests, parents }) => {
    const input = { parent: parents.listActive({ limit: 10 })[0], map,
      parents, requests, loadDetail: async ({ anidbId }) => detail(anidbId),
      readRelations: noRelations, today: '2026-11-12', nowMs: 2000 };
    const first = await reconcileParentWatch(input);
    assert.deepEqual(first, { state: 'reconciled', created: [11], existing: [],
      skipped: [] });
    const record = parents.listInstallments({ tvdbId: 100 });
    assert.equal(record.length, 1);
    assert.equal(requests.getRequest(record[0].requestId).monitorFuture, true);
    assert.deepEqual((await reconcileParentWatch(input)).created, []);
    assert.equal(requests.countRequests(), 1);
  }));

test('an 18+ installment gets no watch for an owner without 18+ access', async () =>
  withLedgers(async ({ requests, parents }) => {
    const asked = [];
    const result = await reconcileParentWatch({ parent: parents.listActive({ limit: 10 })[0],
      map, parents, requests,
      loadDetail: async ({ anidbId }) => detail(anidbId, { restricted: true }),
      readRelations: noRelations, today: '2026-11-12', nowMs: 2000,
      adultAllowed: async ({ requesterId }) => { asked.push(requesterId); return false; } });
    assert.deepEqual(result.created, []);
    assert.equal(requests.countRequests(), 0, 'no request is created behind the account check');
    assert.deepEqual(asked, [7]);
    assert.deepEqual(result.heldCandidates, [11], 'it is retried later, in case access returns');
  }));

test('an 18+ installment is watched for an owner with 18+ access', async () =>
  withLedgers(async ({ requests, parents }) => {
    const result = await reconcileParentWatch({ parent: parents.listActive({ limit: 10 })[0],
      map, parents, requests,
      loadDetail: async ({ anidbId }) => detail(anidbId, { restricted: true }),
      readRelations: noRelations, today: '2026-11-12', nowMs: 2000,
      adultAllowed: async () => true });
    assert.deepEqual(result.created, [11]);
  }));

test('a completed mapped installment is skipped without a download target', async () =>
  withLedgers(async ({ requests, parents }) => {
    const result = await reconcileParentWatch({
      parent: parents.listActive({ limit: 10 })[0], map, parents, requests,
      loadDetail: async ({ anidbId }) => detail(anidbId, {
        endDate: '2026-11-02' }), readRelations: noRelations,
      today: '2026-11-12', nowMs: 2000 });
    assert.deepEqual(result.created, []);
    assert.equal(requests.countRequests(), 0);
  }));

test('a reciprocal sequel absent from AniMap becomes a separate watch', async () =>
  withLedgers(async ({ requests, parents }) => {
    const relations = async (id) => ({ state: 'related_titles', anidbId: id,
      items: id === 11 ? [{ anidbId: 12, relation: 'Sequel' }] :
        [{ anidbId: 11, relation: 'Prequel' }] });
    const result = await reconcileParentWatch({
      parent: parents.listActive({ limit: 10 })[0], map, parents, requests,
      loadDetail: async ({ anidbId }) => detail(anidbId, anidbId === 11
        ? { endDate: '2026-11-02' } : {}), readRelations: relations,
      today: '2026-11-12', nowMs: 2000 });
    assert.deepEqual(result.created, [12]);
    assert.deepEqual(parents.listInstallments({ tvdbId: 100 })
      .map((item) => item.anidbId), [12]);
  }));

test('a later reciprocal sequel is found through a completed intermediary', async () =>
  withLedgers(async ({ requests, parents }) => {
    const relations = async (id) => ({ state: 'related_titles', anidbId: id,
      items: id === 11 ? [{ anidbId: 12, relation: 'Sequel' }] :
        id === 12 ? [{ anidbId: 11, relation: 'Prequel' },
          { anidbId: 13, relation: 'Sequel' }] :
          [{ anidbId: 12, relation: 'Prequel' }] });
    const parent = parents.listActive({ limit: 10 })[0];
    const input = { parent, map, parents, requests,
      loadDetail: async ({ anidbId }) => detail(anidbId,
        anidbId !== 13 ? { endDate: '2026-11-02' } : {}),
      readRelations: relations, today: '2026-11-12', nowMs: 2000 };
    const first = await reconcileParentWatch(input);
    assert.deepEqual(first.created, [13]);
    const second = await reconcileParentWatch(input);
    assert.deepEqual(second.created, []);
    assert.equal(requests.countRequests(), 1);
  }));

test('a long reciprocal chain stays within a read budget and records a hold', async () =>
  withLedgers(async ({ requests, parents }) => {
    const reads = [];
    const result = await reconcileParentWatch({
      parent: parents.listActive({ limit: 10 })[0], map, parents, requests,
      loadDetail: async ({ anidbId }) => detail(anidbId,
        { endDate: '2026-11-02' }),
      readRelations: async (id) => {
        reads.push(id);
        return { state: 'related_titles', anidbId: id,
          items: [
            ...(id > 11 ? [{ anidbId: id - 1, relation: 'Prequel' }] : []),
            ...(id < 30 ? [{ anidbId: id + 1, relation: 'Sequel' }] : []),
          ] };
      }, today: '2026-11-12', nowMs: 2000 });
    assert.equal(result.state, 'reconciled');
    assert.equal(result.relationBudgetExhausted, true);
    assert.equal(reads.length, 12);
    assert.deepEqual(result.created, []);
    assert.equal(requests.countRequests(), 0);
  }));

test('incomplete detail holds a candidate and does not create a watch', async () =>
  withLedgers(async ({ requests, parents }) => {
    const result = await reconcileParentWatch({
      parent: parents.listActive({ limit: 10 })[0], map, parents, requests,
      loadDetail: async () => ({ state: 'unavailable' }),
      readRelations: noRelations, today: '2026-11-12', nowMs: 2000 });
    assert.equal(result.state, 'reconciled');
    assert.deepEqual(result.heldCandidates, [11]);
    assert.equal(requests.countRequests(), 0);
  }));

test('one old missing detail does not block a later active mapped installment', async () =>
  withLedgers(async ({ requests, parents }) => {
    const result = await reconcileParentWatch({
      parent: parents.listActive({ limit: 10 })[0],
      map: { version: 2, anime: [
        { anidb_id: 11, tvdb_id: 100 }, { anidb_id: 12, tvdb_id: 100 }] },
      parents, requests,
      loadDetail: async ({ anidbId }) => anidbId === 11
        ? { state: 'unavailable' } : detail(anidbId),
      readRelations: noRelations, today: '2026-11-12', nowMs: 2000 });
    assert.deepEqual(result.created, [12]);
    assert.deepEqual(result.heldCandidates, [11]);
  }));

test('an old undated incomplete season is held, not misread as airing', async () =>
  withLedgers(async ({ requests, parents }) => {
    const result = await reconcileParentWatch({
      parent: parents.listActive({ limit: 10 })[0], map, parents, requests,
      loadDetail: async ({ anidbId }) => detail(anidbId, {
        airDate: '2012-01-01', episodeCount: 12, total: 1,
        episodes: [{ id: 1001, type: 'Episode', airDate: '2012-01-01' }],
      }), readRelations: noRelations,
      today: '2026-11-12', nowMs: 2000 });
    assert.deepEqual(result.heldCandidates, [11]);
    assert.equal(requests.countRequests(), 0);
  }));

test('a claimed installment retries a failed submit without duplicate requests', async () =>
  withLedgers(async ({ requests, parents }) => {
    const parent = parents.listActive({ limit: 10 })[0];
    const input = { parent, map, parents, requests,
      loadDetail: async ({ anidbId }) => detail(anidbId),
      readRelations: noRelations, today: '2026-11-12', nowMs: 2000 };
    let failed = false;
    const flakyRequests = { submit(args) {
      const result = requests.submit(args);
      if (!failed) { failed = true; throw new Error('crashed after submit'); }
      return result;
    } };
    await assert.rejects(reconcileParentWatch({ ...input, requests: flakyRequests }),
      /crashed after submit/);
    assert.deepEqual(parents.listInstallments({ tvdbId: 100 }),
      [{ anidbId: 11, requestId: null }]);
    assert.deepEqual((await reconcileParentWatch(input)).existing, [11]);
    assert.equal(requests.countRequests(), 1);
    assert.equal(parents.listInstallments({ tvdbId: 100 })[0].requestId, 1);
  }));

test('reciprocal traversal continues beyond its budget after ledger restart without unrelated acquisition', async () => {
 const dir=await mkdtemp(path.join(tmpdir(),'negev-frontier-')); const dbPath=path.join(dir,'db.sqlite');
 let parents=openParentWatchLedger(dbPath); const requests=openRequestLedger(dbPath); const batches=[];
 try {
  parents.adopt({tvdbId:100,requesterId:7,sourceSeriesId:42,nowMs:1000});
  for(let tick=0;tick<4;tick++) {
   const reads=[];
   await reconcileParentWatch({parent:parents.listActive()[0],map,parents,requests,
    loadDetail:async({anidbId})=>detail(anidbId,anidbId===30?{}:{endDate:'2026-11-02'}),
    readRelations:async id=>{reads.push(id);return {state:'related_titles',anidbId:id,items:[
     ...(id>11?[{anidbId:id-1,relation:'Prequel'}]:[]),
     ...(id<30?[{anidbId:id+1,relation:'Sequel'}]:[]),
     {anidbId:999,relation:'Other'}]};},today:'2026-11-12',nowMs:2000+tick});
   batches.push(reads);parents.close();parents=openParentWatchLedger(dbPath);
  }
  assert.ok(batches.every(reads=>reads.length<=12));
  assert.deepEqual(parents.listInstallments({tvdbId:100}).map(x=>x.anidbId),[30]);
 } finally {parents.close();requests.close();await rm(dir,{recursive:true,force:true});}
});

test('an unavailable first sequel cannot block a healthy reciprocal sibling', async () => withLedgers(async ({parents,requests})=>{
 const result=await reconcileParentWatch({parent:parents.listActive()[0],map,parents,requests,
  readRelations:async id=>id===12?{state:'unavailable'}:{state:'related_titles',anidbId:id,items:id===11?
   [{anidbId:12,relation:'Sequel'},{anidbId:13,relation:'Sequel'}]:[{anidbId:11,relation:'Prequel'}]},
  loadDetail:async({anidbId})=>detail(anidbId,anidbId===11?{endDate:'2026-11-02'}:{}),today:'2026-11-12',nowMs:2000});
 assert.deepEqual(result.created,[13]);assert.ok(result.relationHolds.includes(11));
}));

test('expired persisted reciprocal evidence cannot create a new watch during an outage', async () => withLedgers(async ({parents,requests})=>{
 const input={parent:parents.listActive()[0],map,parents,requests,today:'2026-11-12',
  readRelations:async id=>({state:'related_titles',anidbId:id,items:[...(id>11?[{anidbId:id-1,relation:'Prequel'}]:[]),...(id<30?[{anidbId:id+1,relation:'Sequel'}]:[])]})};
 await reconcileParentWatch({...input,loadDetail:async()=>({state:'unavailable'}),nowMs:2000});
 const result=await reconcileParentWatch({...input,readRelations:async()=>({state:'unavailable'}),
  loadDetail:async({anidbId})=>detail(anidbId,anidbId===11?{endDate:'2026-11-02'}:{}),nowMs:2000+86400001});
 assert.deepEqual(result.created,[]);assert.equal(requests.countRequests(),0);
}));

test('a graph larger than old cache and candidate limits reaches its final exact sequel', async () => withLedgers(async ({parents,requests})=>{
 let maxReads=0,maxDetails=0;
 for(let tick=0;tick<30;tick++){
  let reads=0,details=0;
  await reconcileParentWatch({parent:parents.listActive()[0],map,parents,requests,today:'2026-11-12',nowMs:2000+tick,
   readRelations:async id=>{reads++;return {state:'related_titles',anidbId:id,items:[
    ...(id>11?[{anidbId:id-1,relation:'Prequel'}]:[]),...(id<250?[{anidbId:id+1,relation:'Sequel'}]:[])]}},
   loadDetail:async({anidbId})=>{details++;return detail(anidbId,anidbId===250?{}:{endDate:'2026-11-02'})}});
  maxReads=Math.max(maxReads,reads);maxDetails=Math.max(maxDetails,details);
 }
 assert.ok(maxReads<=12);assert.ok(maxDetails<=100);
 assert.deepEqual(parents.listInstallments({tvdbId:100}).map(x=>x.anidbId),[250]);
}));

test('provider outage alone leaves budget continuation at daily pacing', async () => withLedgers(async ({parents,requests}) => {
  await reconcileParentWatch({parent:parents.listActive()[0],map,parents,requests,
    today:'2026-11-12',nowMs:2000,readRelations:async()=>({state:'unavailable'}),
    loadDetail:async()=>({state:'unavailable'})});
  assert.equal(parents.hasPendingContinuation(),false);
}));

test('large candidate traversal eventually clears expedited continuation', async () => withLedgers(async ({parents,requests}) => {
  for (let tick=0;tick<40;tick++) {
    await reconcileParentWatch({parent:parents.listActive()[0],map,parents,requests,
      today:'2026-11-12',nowMs:2000+tick*60_000,
      readRelations:async id=>({state:'related_titles',anidbId:id,items:[
        ...(id>11?[{anidbId:id-1,relation:'Prequel'}]:[]),
        ...(id<250?[{anidbId:id+1,relation:'Sequel'}]:[])]}),
      loadDetail:async({anidbId})=>detail(anidbId,anidbId===250?{}:{endDate:'2026-11-02'})});
    if(!parents.hasPendingContinuation())break;
  }
  assert.equal(parents.hasPendingContinuation(),false);
  assert.deepEqual(parents.listInstallments({tvdbId:100}).map(x=>x.anidbId),[250]);
}));

test('a paused other-owner installment cannot block later parent installments',()=>withLedgers(async({parents,requests})=>{
 const attempted=[];
 const result=await reconcileParentWatch({parent:parents.listActive()[0],map:{version:2,anime:[{anidb_id:11,tvdb_id:100},{anidb_id:12,tvdb_id:100}]},parents,
  requests:{submit:input=>{attempted.push(input.intent.anidbId);return input.intent.anidbId===11?{state:'held',reason:'watch_paused_elsewhere'}:requests.submit(input)}},
  loadDetail:async({anidbId})=>detail(anidbId),readRelations:noRelations,today:'2026-11-12',nowMs:2000});
 assert.equal(result.state,'reconciled');assert.deepEqual(attempted,[11,12]);assert.deepEqual(result.created,[12]);assert.deepEqual(result.heldCandidates,[11]);
}));
