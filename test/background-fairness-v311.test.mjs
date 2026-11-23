import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readPlexSectionKeys } from '../src/availability/plex-section-keys.mjs';
import { createPlexCardPageWorker } from '../src/availability/plex-card-page-worker.mjs';
import { openPlexCardIndex } from '../src/availability/plex-card-index.mjs';
import { createPlexIndexScheduler } from '../src/availability/plex-index-scheduler.mjs';
import { openShokoRecentLedger } from '../src/availability/shoko-recent-ledger.mjs';
import { createShokoRecentWorker } from '../src/availability/shoko-recent-worker.mjs';
const cursor = (fileId) => ({ fileId, importedNs: String(1800000000000000000n + BigInt(fileId)) });
async function temp(run) {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-fairness-'));
 try { await run(path.join(dir, 'test.sqlite')); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('validated shrunken Plex page resets durable cursor', async () => temp(async (dbPath) => {
 const index = openPlexCardIndex(dbPath);
 try {
 index.advanceCursor({ libraryId: 102, kind: 'episode', expectedOffset: 0, nextOffset: 100 });
 const worker = createPlexCardPageWorker({ libraryId: 102, kind: 'episode', index,
 readCard: async () => { throw new Error('empty'); },
 readPage: (input) => readPlexSectionKeys({ ...input, baseUrl: 'http://plex:32400', token: 'synthetic',
 fetchImpl: async (url) => Response.json({ MediaContainer: url.pathname === '/library/sections/102'
 ? { librarySectionID: 102, Directory: [{ type: '4', key: '/library/sections/102/all?type=4' }] }
 : { librarySectionID: 102, offset: 100, totalSize: 50, size: 0 } }) }) });
 assert.equal((await worker.tick()).state, 'page_indexed');
 assert.equal(index.getCursor({ libraryId: 102, kind: 'episode' }), 0);
 } finally { index.close(); }
}));
test('continuous bursts reserve full and retry turns', async () => {
 let full = 0;
 const scheduler = createPlexIndexScheduler({ sections: { episode: [102], movie: [] }, hasRecentArrival: () => true,
 tickPage: async () => { full++; return { state: 'page_indexed' }; }, tickRecent: async () => ({ state: 'page_indexed', nextOffset: 5 }) });
 try { for (let cycle = 0; cycle < 20; cycle++) {
 const before = full; for (let i = 0; i < 4; i++) await scheduler.runOnce();
 assert.ok(full > before, 'sweep/retry progresses');
 } } finally { await scheduler.close(); }
});
test('persistent retry failures cannot starve 31st pending file after restart', async () => temp(async (dbPath) => {
 let ledger = openShokoRecentLedger(dbPath); ledger.bootstrap(cursor(1));
 ledger.recordBatch({ state: 'complete', newest: cursor(32), fileIds: Array.from({ length: 31 }, (_, i) => i + 2) });
 let now = 0; const seen = new Set();
 try { for (let tick = 0; tick < 180; tick++) {
 if (tick === 20) { ledger.close(); ledger = openShokoRecentLedger(dbPath); }
 const worker = createShokoRecentWorker({ ledger, now: () => now, readPage: async () => ({ state: 'unavailable' }),
 refreshFile: async (id) => { seen.add(id); return { state: 'unavailable' }; } });
 await worker.drainOne(); now += 10000;
 } assert.ok(seen.has(32), 'last pending ID served'); } finally { ledger.close(); }
}));
for (const mode of ['timestamp', 'fileid']) test(`${mode} crosses 501 file gap with bounded durable continuation`, async () => temp(async (dbPath) => {
 let ledger = openShokoRecentLedger(dbPath); ledger.bootstrap(cursor(1));
 if (mode === 'fileid') ledger.recordFileIdBatch({ state: 'complete', newestId: 1, fileIds: [1], pendingFileIds: [] });
 const items = Array.from({ length: 502 }, (_, i) => cursor(502 - i)); let reads = 0;
 const readPage = async ({ page, pageSize }) => { reads++; return { state: 'page', page, total: items.length, items: items.slice((page - 1) * pageSize, page * pageSize) }; };
 const readFileIdPage = async (input) => { const result = await readPage(input); return { ...result, fileIds: result.items.map((row) => row.fileId) }; };
 try { let completed = false;
 for (let tick = 0; tick < 4; tick++) {
 const worker = createShokoRecentWorker({ ledger, readPage: mode === 'timestamp' ? readPage : async () => ({ state: 'page', page: 1, total: 1, items: [cursor(1)] }),
 ...(mode === 'fileid' ? { readFileIdPage } : {}), refreshFile: async () => ({ state: 'unavailable' }) });
 const before = reads; await worker.scan(); assert.ok(reads - before <= 7, 'bounded reads');
 ledger.close(); ledger = openShokoRecentLedger(dbPath);
 if (mode === 'timestamp' ? ledger.getCursor().fileId === 502 : ledger.getFileIdCursor() === 502) { completed = true; break; }
 }
 assert.ok(completed, 'watermark eventually advances'); assert.equal(ledger.getCapacity().pending, 501);
 } finally { ledger.close(); }
}));
test('invalid sweep generations retire incrementally', async () => temp(async (dbPath) => {
 const index = openPlexCardIndex(dbPath);
 try {
 index.recordCard({libraryId:102,ratingKey:999,kind:'episode',observedMs:0,
 parts:[{libraryId:102,partId:1001,plexPath:'/source-pure/999.mkv',size:123}]});
 index.deferCard({libraryId:102,ratingKey:999,kind:'episode',nowMs:0});
 for (let pass = 0; pass < 40; pass++) {
 index.advanceCursor({ libraryId: 102, kind: 'episode', expectedOffset: 0, nextOffset: 5, pageKeys: [1,2,3,4,5], totalSize: 10, observedMs: pass * 10 });
 index.advanceCursor({ libraryId: 102, kind: 'episode', expectedOffset: 5, nextOffset: 0, pageKeys: [6], totalSize: 6, observedMs: pass * 10 + 1 });
 }
 assert.deepEqual(index.lookupCards({sizes:[123],libraryIds:[102],kind:'episode'}),
 {state:'candidates',cards:[{libraryId:102,ratingKey:999}]});
 assert.equal(index.nextRetry({libraryId:102,kind:'episode',nowMs:999999}).ratingKey,999);
 const db = new DatabaseSync(dbPath);
 try { assert.ok(db.prepare('SELECT COUNT(*) AS total FROM plex_sweep_passes').get().total <= 3, 'invalid passes bounded'); } finally { db.close(); }
 } finally { index.close(); }
}));
for (const mode of ['timestamp', 'fileid']) test(`${mode} changed continuation head preserves queued debt and watermark`, async () => temp(async (dbPath) => {
 const ledger = openShokoRecentLedger(dbPath);
 ledger.bootstrap(cursor(1));
 if (mode === 'fileid') ledger.recordFileIdBatch({ state: 'complete', newestId: 1, fileIds: [1], pendingFileIds: [] });
 let newest = 4;
 const read = async ({page, pageSize}) => {
 const rows = Array.from({length:newest},(_,i)=>cursor(newest-i));
 return {state:'page',page,total:rows.length,items:rows.slice((page-1)*pageSize,page*pageSize)};
 };
 const worker = createShokoRecentWorker({ledger,pageSize:2,maxPages:1,
 readPage: mode === 'timestamp' ? read : async()=>({state:'page',page:1,total:1,items:[cursor(1)]}),
 ...(mode === 'fileid' ? {readFileIdPage: async input=>{const page=await read(input);return {...page,fileIds:page.items.map(row=>row.fileId)};}} : {}),
 refreshFile:async()=>({state:'unavailable'})});
 try {
 assert.equal((await worker.scan()).state,'continuing');
 assert.equal(ledger.getCapacity().pending,2);
 newest=5;
 assert.equal((await worker.scan()).state,'held');
 assert.equal(ledger.getContinuation(mode),null);
 assert.equal(mode==='timestamp'?ledger.getCursor().fileId:ledger.getFileIdCursor(),1);
 assert.equal(ledger.getCapacity().pending,2);
 for(let tick=0;tick<4;tick++) await worker.scan();
 assert.equal(mode==='timestamp'?ledger.getCursor().fileId:ledger.getFileIdCursor(),5);
 assert.equal(ledger.getCapacity().pending,4);
 } finally {ledger.close();}
}));

test('partial catchup capacity failure preserves cursor and continuation atomically', async()=>temp(async dbPath=>{
 const ledger=openShokoRecentLedger(dbPath,{maxPending:1});ledger.bootstrap(cursor(1));
 try {
 const worker=createShokoRecentWorker({ledger,pageSize:2,maxPages:1,
 readPage:async({page})=>({state:'page',page,total:4,items:[cursor(4),cursor(3)]}),refreshFile:async()=>({state:'unavailable'})});
 assert.equal((await worker.scan()).reason,'recent_backlog_full');
 assert.equal(ledger.getCapacity().pending,0);
 assert.equal(ledger.getContinuation('timestamp'),null);
 assert.equal(ledger.getCursor().fileId,1);
 }finally{ledger.close();}
}));
test('continuation completion cannot advance past a head never durably journalled', async()=>temp(async dbPath=>{
 const ledger=openShokoRecentLedger(dbPath);ledger.bootstrap(cursor(1));
 try {
 const result=ledger.recordScanBatch('timestamp',{state:'complete',resumed:true,since:cursor(1),newest:cursor(999),fileIds:[2]});
 assert.equal(result.state,'held');assert.equal(ledger.getCursor().fileId,1);assert.equal(ledger.getCapacity().pending,0);
 }finally{ledger.close();}
}));
for (const mode of ['timestamp','fileid']) test(`${mode} temporary head-read outage retains durable continuation`,async()=>temp(async dbPath=>{
 const ledger=openShokoRecentLedger(dbPath);ledger.bootstrap(cursor(1));
 if(mode==='fileid') ledger.recordFileIdBatch({state:'complete',newestId:1,fileIds:[1],pendingFileIds:[]});
 let failed=false;
 const read=async({page,pageSize})=>failed?{state:'unavailable'}:{state:'page',page,total:4,items:[4,3,2,1].slice((page-1)*pageSize,page*pageSize).map(cursor)};
 const worker=createShokoRecentWorker({ledger,pageSize:2,maxPages:1,
 readPage:mode==='timestamp'?read:async()=>({state:'page',page:1,total:1,items:[cursor(1)]}),
 ...(mode==='fileid'?{readFileIdPage:async input=>{const result=await read(input);return result.state==='page'?{...result,fileIds:result.items.map(item=>item.fileId)}:result;}}:{}),
 refreshFile:async()=>({state:'unavailable'})});
 try{
 await worker.scan();const frontier=ledger.getContinuation(mode);assert.ok(frontier);
 failed=true;await worker.scan();assert.deepEqual(ledger.getContinuation(mode),frontier);
 failed=false;await worker.scan();assert.equal(mode==='timestamp'?ledger.getCursor().fileId:ledger.getFileIdCursor(),4);
 }finally{ledger.close();}
}));
