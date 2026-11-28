import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openShokoRecentLedger } from '../src/availability/shoko-recent-ledger.mjs';
import { createShokoRecentWorker } from '../src/availability/shoko-recent-worker.mjs';

const cursor = (fileId) => ({ fileId,
  importedNs: String(1_800_000_000_000_000_000n + BigInt(fileId)) });

async function withLedger(run, options) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-recent-worker-'));
  const ledger = openShokoRecentLedger(path.join(dir, 'negev.sqlite'), options);
  try { await run(ledger); }
  finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
}

test('one bounded scan journals new IDs before moving the cursor', async () => {
  await withLedger(async (ledger) => {
    ledger.bootstrap(cursor(10));
    const pages = [];
    const worker = createShokoRecentWorker({ ledger, now: () => 100,
      readPage: async ({ page }) => {
        pages.push(page);
        return { state: 'page', page, total: 3,
          items: [cursor(13), cursor(12), cursor(11)] };
      },
      refreshFile: async () => ({ state: 'recorded_file', recognition: 'linked' }) });
    assert.deepEqual(await worker.scan(), { state: 'caught_up', added: 3 });
    assert.deepEqual(pages, [1, 1]);
    assert.deepEqual(ledger.getCursor(), cursor(13));
    assert.deepEqual(ledger.nextDue(100), { fileId: 11 });
  });
});

test('file-ID scan recovers a linked Shoko file absent from inventory despite null Imported', async () => {
  await withLedger(async (ledger) => {
    ledger.bootstrap(cursor(10));
    const refreshed = [];
    const worker = createShokoRecentWorker({ ledger, now: () => 100,
      readPage: async () => ({ state: 'page', page: 1, total: 1,
        items: [cursor(10)] }),
      readFileIdPage: async () => ({ state: 'page', page: 1, total: 2,
        fileIds: [12, 11] }),
      isKnownFileId: (id) => id === 12,
      refreshFile: async (id) => { refreshed.push(id);
        return { state: 'recorded_file', recognition: 'linked' }; },
    });
    assert.deepEqual(await worker.scan(), { state: 'caught_up', added: 1 });
    assert.equal(ledger.getFileIdCursor(), 12);
    assert.deepEqual(ledger.nextDue(100), { fileId: 11 });
    assert.deepEqual(await worker.drainOne(), { state: 'acknowledged', fileId: 11 });
    assert.deepEqual(refreshed, [11]);
  });
});

test('first file after an empty baseline reaches the same durable refresh queue', async () => {
  await withLedger(async (ledger) => {
    ledger.bootstrap({ fileId: 1, importedNs: '0' });
    const refreshed = [];
    const worker = createShokoRecentWorker({ ledger, now: () => 100,
      readPage: async () => ({ state: 'page', page: 1,
        total: 1, items: [cursor(1)] }),
      refreshFile: async (fileId) => { refreshed.push(fileId);
        return { state: 'recorded_file', recognition: 'linked' }; } });
    assert.deepEqual(await worker.scan(), { state: 'caught_up', added: 1 });
    assert.deepEqual(ledger.getCursor(), cursor(1));
    assert.deepEqual(await worker.drainOne(), { state: 'acknowledged', fileId: 1 });
    assert.deepEqual(refreshed, [1]);
    assert.equal(ledger.nextDue(100), null);
  });
});

test('a full durable queue holds before any expensive Shoko page read', async () => {
  await withLedger(async (ledger) => {
    ledger.bootstrap(cursor(10));
    ledger.recordBatch({ state: 'complete', fileIds: [11], newest: cursor(11) });
    let reads = 0;
    const worker = createShokoRecentWorker({ ledger, now: () => 100,
      readPage: async ({ page }) => {
        reads++;
        return { state: 'page', page, total: 3,
          items: [cursor(12), cursor(11), cursor(10)] };
      },
      refreshFile: async () => ({ state: 'recorded_file', recognition: 'linked' }) });
    assert.deepEqual(await worker.scan(),
      { state: 'held', reason: 'recent_backlog_full' });
    assert.equal(reads, 0);
    assert.deepEqual(ledger.getCursor(), cursor(11));
    assert.deepEqual(await worker.drainOne(),
      { state: 'acknowledged', fileId: 11 });
    assert.deepEqual(await worker.scan(), { state: 'caught_up', added: 1 });
    assert.equal(reads, 2);
    assert.deepEqual(ledger.getCursor(), cursor(12));
  }, { maxPending: 1 });
});

test('failed targeted recheck waits while a later file is processed', async () => {
  await withLedger(async (ledger) => {
    ledger.bootstrap(cursor(10));
    ledger.recordBatch({ state: 'complete', fileIds: [11, 12],
      newest: cursor(12) });
    const seen = [];
    const worker = createShokoRecentWorker({ ledger, now: () => 100,
      readPage: async () => { throw new Error('scan not used'); },
      refreshFile: async (fileId) => {
        seen.push(fileId);
        return fileId === 11 ? { state: 'held' } :
          { state: 'recorded_file', recognition: 'linked' };
      } });
    assert.deepEqual(await worker.drainOne(), { state: 'retry_scheduled', fileId: 11 });
    assert.deepEqual(await worker.drainOne(), { state: 'acknowledged', fileId: 12 });
    assert.deepEqual(seen, [11, 12]);
    assert.deepEqual(ledger.nextDue(100), null);
  });
});

test('a Shoko file observed before recognition stays pending for later recheck', async () => {
  await withLedger(async (ledger) => {
    ledger.bootstrap(cursor(10));
    ledger.recordBatch({ state: 'complete', fileIds: [11, 12],
      newest: cursor(12) });
    const seen = [];
    let nowMs = 100;
    let recognized = false;
    const worker = createShokoRecentWorker({ ledger, now: () => nowMs,
      readPage: async () => { throw new Error('scan not used'); },
      refreshFile: async (fileId) => {
        seen.push(fileId);
        return { state: 'recorded_file', recognition:
          fileId !== 11 || recognized ? 'linked' : 'provisional' };
      } });
    assert.deepEqual(await worker.drainOne(),
      { state: 'retry_scheduled', fileId: 11 });
    assert.deepEqual(await worker.drainOne(),
      { state: 'acknowledged', fileId: 12 });
    assert.deepEqual(seen, [11, 12]);
    assert.deepEqual(ledger.nextDue(300_100), { fileId: 11 });
    nowMs = 300_100;
    recognized = true;
    assert.deepEqual(await worker.drainOne(),
      { state: 'acknowledged', fileId: 11 });
    assert.equal(ledger.nextDue(nowMs), null);
  });
});

test('a missing baseline and an active operation cannot start a second scan', async () => {
  await withLedger(async (ledger) => {
    let reads = 0;
    let release;
    const firstPage = new Promise((resolve) => { release = resolve; });
    const page = { state: 'page', page: 1, total: 1, items: [cursor(10)] };
    const worker = createShokoRecentWorker({ ledger, now: () => 100,
      readPage: () => ++reads === 1 ? firstPage : page,
      refreshFile: async () => ({ state: 'recorded_file', recognition: 'linked' }) });
    assert.deepEqual(await worker.scan(), { state: 'held',
      reason: 'recent_baseline_required' });
    assert.equal(reads, 0);
    ledger.bootstrap(cursor(10));
    const running = worker.scan();
    assert.deepEqual(await worker.scan(), { state: 'held', reason: 'recent_worker_busy' });
    assert.equal(reads, 1);
    release(page);
    assert.equal((await running).state, 'caught_up');
  });
});

test('due retries progress during 180 sustained arrivals over 36 minutes and restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-recent-fair-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  let ledger = openShokoRecentLedger(dbPath);
  let nowMs = 100;
  let healthy = false;
  const seen = [];
  const makeWorker = () => createShokoRecentWorker({ ledger, now: () => nowMs,
    readPage: async () => { throw new Error('drain-only test'); },
    refreshFile: async fileId => {
      seen.push({ fileId, nowMs });
      return fileId === 11 && !healthy ? { state: 'held' } :
        { state: 'recorded_file', recognition: 'linked' };
    } });
  try {
    ledger.bootstrap(cursor(10));
    ledger.recordBatch({ state: 'complete', fileIds: [11], newest: cursor(11) });
    let worker = makeWorker();
    assert.equal((await worker.drainOne()).state, 'retry_scheduled');
    healthy = true;
    let retryAt;
    for (let i = 0; i < 180; i++) {
      nowMs = 100 + (i + 1) * 12_000;
      if (i === 24) { ledger.close(); ledger = openShokoRecentLedger(dbPath); worker = makeWorker(); }
      const id = 12 + i;
      ledger.recordBatch({ state: 'complete', fileIds: [id], newest: cursor(id) });
      const result = await worker.drainOne();
      if (result.fileId === 11 && result.state === 'acknowledged') retryAt = nowMs;
    }
    assert.ok(retryAt >= 300_100 && retryAt <= 312_100,
      `healthy retry must run on first due drain, got ${retryAt}`);
    assert.ok(seen.some(x => x.fileId === 12 && x.nowMs < 300_100));
    assert.ok(seen.some(x => x.fileId > 100));
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a large failing due prefix cannot consume the new-file drain share after restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-recent-prefix-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  let ledger = openShokoRecentLedger(dbPath);
  let nowMs = 100;
  const makeWorker = () => createShokoRecentWorker({ ledger, now: () => nowMs,
    readPage: async () => { throw new Error('drain-only'); },
    refreshFile: async fileId => fileId < 200 ? { state: 'held' } :
      { state: 'recorded_file', recognition: 'linked' } });
  try {
    ledger.bootstrap(cursor(10));
    const ids = Array.from({ length: 100 }, (_, i) => i + 11);
    ledger.recordBatch({ state: 'complete', fileIds: ids, newest: cursor(110) });
    let worker = makeWorker();
    for (let i = 0; i < 100; i++) await worker.drainOne();
    nowMs = 300_100;
    ledger.recordBatch({ state: 'complete', fileIds: [200], newest: cursor(200) });
    assert.equal((await worker.drainOne()).state, 'retry_scheduled');
    ledger.close(); ledger = openShokoRecentLedger(dbPath); worker = makeWorker();
    assert.deepEqual(await worker.drainOne(), { state: 'acknowledged', fileId: 200 });
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

for(const condition of ['removed','unsupported','provisional','outage','revived','changed','revived_linked'])test(`recent drain retires only authoritative ${condition} outcomes`,async()=>withLedger(async ledger=>{
 ledger.bootstrap(cursor(10),[10]);let reads=0;
 const worker=createShokoRecentWorker({ledger,now:()=>100,readPage:async()=>{throw Error('not scanning')},
  isRetirementCurrent:()=>condition!=='changed',
  refreshFile:async fileId=>{
   reads++;
   if(condition==='unsupported')return{state:'recorded_file',fileId,recognition:'unverified'};
   if(condition==='provisional')return{state:'recorded_file',recognition:'provisional'};
   if(condition==='outage'&&reads>1)return{state:'unavailable'};
   if(condition==='revived_linked'&&reads>1)return{state:'recorded_file',fileId,recognition:'linked'};
   if(condition==='revived'&&reads>1)return{state:'recorded_file',recognition:'provisional'};
   return{state:'missing_file',fileId,observedRevision:null,generation:0};
  }});
 const result=await worker.drainOne();
 assert.equal(result.state,['removed','unsupported'].includes(condition)?'retired':condition==='revived_linked'?'acknowledged':'retry_scheduled',JSON.stringify(result));
 assert.equal(ledger.getCapacity().pending,['removed','unsupported','revived_linked'].includes(condition)?0:1);
 if(condition==='removed')assert.equal(reads,2,'one missing read cannot retire a queued file');
}));

test('two missing reads from different generations cannot retire the pending file',async()=>withLedger(async ledger=>{
 ledger.bootstrap(cursor(10),[10]);let reads=0;
 const worker=createShokoRecentWorker({ledger,now:()=>100,readPage:async()=>{},isRetirementCurrent:()=>true,
  refreshFile:async fileId=>({state:'missing_file',fileId,observedRevision:5,generation:reads++})});
 assert.equal((await worker.drainOne()).state,'retry_scheduled');assert.equal(ledger.getCapacity().pending,1);
}));
