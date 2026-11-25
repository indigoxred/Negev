import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openFileBackfillCursor, resetFileBackfillEvidence } from
  '../src/availability/file-backfill-cursor.mjs';
import { openFileProofLedger } from
  '../src/availability/file-proof-ledger.mjs';

test('explicit recovery rewind keeps recent proofs and revisits the first hint', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-backfill-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const inventory = { listFileHintIds: ({ afterFileId, limit }) =>
    [2, 5, 9].filter((id) => id > afterFileId).slice(0, limit) };
  const cursor = openFileBackfillCursor(dbPath);
  const proofs = openFileProofLedger(dbPath, {
    positiveLifetimeMs: 10_000, now: () => 1_000 });
  try {
    const first = cursor.claim({ inventory, nowMs: 100, limit: 2 });
    assert.deepEqual(first.fileIds, [2, 5]);
    assert.equal(cursor.record({ claim: first,
      outcomes: [{ fileId: 2, state: 'available' },
        { fileId: 5, state: 'unknown' }], nowMs: 101 }).state, 'recorded');
    assert.equal(proofs.observe({ anidbId: 42, episodeId: 1001,
      proof: { fileId: 2, libraryId: 102, ratingKey: 500, partId: 900 },
      checkedMs: 900 }).state, 'recorded');
    const pending = cursor.claim({ inventory, nowMs: 102, limit: 2 });
    assert.deepEqual(pending.fileIds, [9]);
    resetFileBackfillEvidence(dbPath);
    assert.equal(proofs.getCurrent({ anidbId: 42, episodeId: 1001 }).state,
      'available');
    assert.equal(cursor.record({ claim: pending,
      outcomes: [{ fileId: 9, state: 'unknown' }], nowMs: 103 }).state,
      'held');
    const restarted = cursor.claim({ inventory, nowMs: 104, limit: 2 });
    assert.deepEqual(restarted.fileIds, [2]);
    assert.equal(restarted.priority, true);
    assert.equal(restarted.pass, first.pass + 1);
    assert.equal(cursor.record({ claim: restarted,
      outcomes: [{ fileId: 2, state: 'available' }], nowMs: 105 }).state,
    'recorded');
    assert.deepEqual(cursor.claim({ inventory, nowMs: 106, limit: 2 }).fileIds,
      [2, 5]);
  } finally {
    proofs.close(); cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit recovery rechecks formerly proven file IDs first', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-priority-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const inventory = { listFileHintIds: ({ afterFileId, limit }) =>
    [2, 5, 9].filter((id) => id > afterFileId).slice(0, limit) };
  const cursor = openFileBackfillCursor(dbPath);
  const proofs = openFileProofLedger(dbPath, {
    positiveLifetimeMs: 10_000, now: () => 1_000 });
  try {
    assert.equal(proofs.observe({ anidbId: 42, episodeId: 1001,
      proof: { fileId: 9, libraryId: 102, ratingKey: 500, partId: 900 },
      checkedMs: 900 }).state, 'recorded');
    resetFileBackfillEvidence(dbPath);
    assert.equal(proofs.getCurrent({ anidbId: 42, episodeId: 1001 }).state,
      'available');
    const priority = cursor.claim({ inventory, nowMs: 1_001, limit: 1 });
    assert.deepEqual(priority.fileIds, [9]);
    assert.equal(priority.priority, true);
    resetFileBackfillEvidence(dbPath);
    const resumed = cursor.claim({ inventory, nowMs: 1_002, limit: 1 });
    assert.deepEqual(resumed.fileIds, [9]);
    assert.equal(resumed.priority, true);
    assert.equal(cursor.record({ claim: priority,
      outcomes: [{ fileId: 9, state: 'available' }], nowMs: 1_002 }).state,
    'held');
    assert.deepEqual(cursor.record({ claim: resumed,
      outcomes: [{ fileId: 9, state: 'unknown' }], nowMs: 1_003 }),
    { state: 'recorded', count: 1 });
    const ordinary = cursor.claim({ inventory, nowMs: 1_004, limit: 1 });
    assert.deepEqual(ordinary.fileIds, [2]);
    assert.equal(ordinary.priority, undefined);
  } finally {
    proofs.close(); cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a newly linked file can be queued once ahead of the historical pass', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-new-priority-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const inventory = { listFileHintIds: ({ afterFileId, limit }) =>
    [2, 5, 51].filter((id) => id > afterFileId).slice(0, limit) };
  let cursor = openFileBackfillCursor(dbPath);
  try {
    const ordinary = cursor.claim({ inventory, nowMs: 100, limit: 1 });
    assert.deepEqual(ordinary.fileIds, [2]);
    assert.equal(cursor.record({ claim: ordinary,
      outcomes: [{ fileId: 2, state: 'unknown' }], nowMs: 101 }).state,
    'recorded');
    assert.deepEqual(cursor.prioritizeFile({ fileId: 51, observedMs: 100 }),
      { state: 'queued' });
    assert.deepEqual(cursor.prioritizeFile({ fileId: 51, observedMs: 100 }),
      { state: 'unchanged' });
    cursor.close();
    cursor = openFileBackfillCursor(dbPath);
    const recent = cursor.claim({ inventory, nowMs: 102, limit: 1 });
    assert.deepEqual(recent.fileIds, [51]);
    assert.equal(recent.priority, true);
    assert.equal(cursor.record({ claim: recent,
      outcomes: [{ fileId: 51, state: 'unknown' }], nowMs: 103 }).state,
    'recorded');
    const resumedOrdinary = cursor.claim({ inventory, nowMs: 104, limit: 1 });
    assert.deepEqual(resumedOrdinary.fileIds, [5]);
    assert.equal(cursor.record({ claim: resumedOrdinary,
      outcomes: [{ fileId: 5, state: 'unknown' }], nowMs: 104 }).state,
    'recorded');
    assert.deepEqual(cursor.confirmRecentFile({ fileId: 51, nowMs: 105 }),
      { state: 'queued' });
    const afterCard = cursor.claim({ inventory, nowMs: 106, limit: 1 });
    assert.deepEqual(afterCard.fileIds, [51]);
    assert.equal(afterCard.priority, true);
    assert.equal(cursor.record({ claim: afterCard,
      outcomes: [{ fileId: 51, state: 'available' }], nowMs: 107 }).state,
    'recorded');
    assert.deepEqual(cursor.confirmRecentFile({ fileId: 51, nowMs: 108 }),
      { state: 'unchanged' });
  } finally {
    cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an expired positive-confirmation window cannot discard scheduled arrival retries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-priority-expiry-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  try {
    cursor.prioritizeFile({ fileId: 51, observedMs: 100 });
    const inventory = { listFileHintIds: () => [] };
    const claim = cursor.claim({ inventory, nowMs: 101 });
    cursor.record({ claim, outcomes: [{ fileId: 51, state: 'unknown' }],
      nowMs: 102 });
    assert.deepEqual(cursor.confirmRecentFile({ fileId: 51,
      nowMs: 100 + 30 * 60_000 + 1 }), { state: 'unchanged' });
    const retry=cursor.claim({inventory,nowMs:100+30*60_000+2});
    assert.deepEqual(retry.fileIds,[51]);
    cursor.record({claim:retry,outcomes:[{fileId:51,state:'unknown'}],nowMs:100+30*60_000+3});
    assert.equal(cursor.claim({inventory,nowMs:100+30*60_000+4}).state,'idle');
  } finally {
    cursor.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('a new file outranks recovery rechecks without increasing claim size', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-priority-rank-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const cursor = openFileBackfillCursor(dbPath);
  const proofs = openFileProofLedger(dbPath, {
    positiveLifetimeMs: 10_000, now: () => 100 });
  try {
    proofs.observe({ anidbId: 42, episodeId: 1001,
      proof: { fileId: 5, libraryId: 102, ratingKey: 500, partId: 900 },
      checkedMs: 99 });
    resetFileBackfillEvidence(dbPath);
    cursor.prioritizeFile({ fileId: 51, observedMs: 100 });
    const claim = cursor.claim({ inventory: { listFileHintIds: () => [] },
      nowMs: 101, limit: 1 });
    assert.deepEqual(claim.fileIds, [51]);
    assert.equal(claim.priority, true);
  } finally {
    proofs.close(); cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a bounded mixed-rank priority page survives replay and records in rank order', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-priority-page-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const cursor = openFileBackfillCursor(dbPath);
  const proofs = openFileProofLedger(dbPath, {
    positiveLifetimeMs: 10_000, now: () => 100 });
  try {
    proofs.observe({ anidbId: 42, episodeId: 1001,
      proof: { fileId: 5, libraryId: 102, ratingKey: 500, partId: 900 },
      checkedMs: 99 });
    resetFileBackfillEvidence(dbPath);
    cursor.prioritizeFile({ fileId: 51, observedMs: 100 });
    const inventory = { listFileHintIds: () => [] };
    const claim = cursor.claim({ inventory, nowMs: 101, limit: 2 });
    assert.equal(claim.state, 'claimed');
    assert.equal(claim.priority, true);
    assert.deepEqual(claim.fileIds, [51, 5]);
    assert.deepEqual(cursor.claim({ inventory, nowMs: 102, limit: 2 }).fileIds,
      [51, 5]);
    assert.equal(cursor.record({ claim, outcomes: [
      { fileId: 51, state: 'available' },
      { fileId: 5, state: 'unknown' },
    ], nowMs: 103 }).state, 'recorded');
    assert.equal(cursor.claim({ inventory, nowMs: 104, limit: 2 }).state, 'idle');
  } finally {
    proofs.close(); cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a positive during an in-flight early miss queues one later recheck', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-priority-race-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  try {
    cursor.prioritizeFile({ fileId: 51, observedMs: 100 });
    const inventory = { listFileHintIds: () => [] };
    const early = cursor.claim({ inventory, nowMs: 101, limit: 1 });
    assert.deepEqual(cursor.confirmRecentFile({ fileId: 51, nowMs: 102 }),
      { state: 'queued' });
    assert.equal(cursor.record({ claim: early,
      outcomes: [{ fileId: 51, state: 'unknown' }], nowMs: 103 }).state,
    'recorded');
    const retry = cursor.claim({ inventory, nowMs: 104, limit: 1 });
    assert.deepEqual(retry.fileIds, [51]);
    assert.equal(cursor.record({ claim: retry,
      outcomes: [{ fileId: 51, state: 'available' }], nowMs: 105 }).state,
    'recorded');
    assert.equal(cursor.claim({ inventory, nowMs: 106 }).state, 'idle');
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('v0.0.34 cursor schema migrates before queuing old proofs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-migrate-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE file_backfill_cursor (
    id INTEGER PRIMARY KEY, after_file_id INTEGER NOT NULL,
    pass INTEGER NOT NULL, receipt INTEGER NOT NULL,
    pending_json TEXT, claimed_ms INTEGER,
    pair_offset INTEGER NOT NULL DEFAULT 0, fingerprint TEXT) STRICT;
    INSERT INTO file_backfill_cursor (id,after_file_id,pass,receipt)
      VALUES (1,500,3,7);
    CREATE TABLE file_availability_proofs (
      anidb_id INTEGER NOT NULL, episode_id INTEGER NOT NULL,
      file_id INTEGER NOT NULL, library_id INTEGER NOT NULL,
      rating_key INTEGER NOT NULL, part_id INTEGER NOT NULL,
      verified_ms INTEGER NOT NULL,
      PRIMARY KEY(anidb_id,episode_id,file_id,library_id,rating_key,part_id)
    ) STRICT;
    INSERT INTO file_availability_proofs VALUES (42,1001,450,102,500,900,900);`);
  old.close();
  const cursor = openFileBackfillCursor(dbPath);
  try {
    resetFileBackfillEvidence(dbPath);
    const inventory = { listFileHintIds: () => [2] };
    const claim = cursor.claim({ inventory, nowMs: 1_000, limit: 1 });
    assert.deepEqual(claim.fileIds, [450]);
    assert.equal(claim.priority, true);
    assert.equal(claim.pass, 4);
  } finally {
    cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('partial priority claim resumes with its file and pair offset', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-partial-priority-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const proofs = openFileProofLedger(dbPath, {
    positiveLifetimeMs: 10_000, now: () => 1_000 });
  let cursor = openFileBackfillCursor(dbPath);
  const inventory = { listFileHintIds: ({ afterFileId, limit }) =>
    [2, 9].filter((id) => id > afterFileId).slice(0, limit) };
  try {
    proofs.observe({ anidbId: 42, episodeId: 1001,
      proof: { fileId: 9, libraryId: 102, ratingKey: 500, partId: 900 },
      checkedMs: 900 });
    resetFileBackfillEvidence(dbPath);
    const first = cursor.claim({ inventory, nowMs: 1_001, limit: 1 });
    const fingerprint = 'a'.repeat(64);
    assert.equal(cursor.record({ claim: first, outcomes: [{ fileId: 9,
      state: 'partial', nextPairOffset: 3, fingerprint }], nowMs: 1_002 }).state,
    'partial');
    cursor.close();
    cursor = openFileBackfillCursor(dbPath);
    const resumed = cursor.claim({ inventory, nowMs: 1_003, limit: 1 });
    assert.deepEqual(resumed.fileIds, [9]);
    assert.equal(resumed.priority, true);
    assert.equal(resumed.pairOffset, 3);
    assert.equal(resumed.fingerprint, fingerprint);
    assert.equal(cursor.record({ claim: resumed, outcomes: [{ fileId: 9,
      state: 'unknown' }], nowMs: 1_004 }).state, 'recorded');
    assert.deepEqual(cursor.claim({ inventory, nowMs: 1_005, limit: 1 }).fileIds,
      [2]);
  } finally {
    proofs.close(); cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('file backfill retries a pending claim after restart and wraps after a complete pass', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-backfill-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const inventory = { listFileHintIds: ({ afterFileId, limit }) =>
    [2, 5, 9].filter((id) => id > afterFileId).slice(0, limit) };
  let cursor = openFileBackfillCursor(dbPath);
  try {
    const first = cursor.claim({ inventory, nowMs: 100, limit: 2 });
    assert.equal(first.state, 'claimed');
    assert.deepEqual(first.fileIds, [2, 5]);
    cursor.close();
    cursor = openFileBackfillCursor(dbPath);
    assert.deepEqual(cursor.claim({ inventory, nowMs: 200, limit: 2 }), first);
    assert.deepEqual(cursor.record({ claim: first,
      outcomes: [{ fileId: 2, state: 'unknown' },
        { fileId: 5, state: 'available' }], nowMs: 210 }),
    { state: 'recorded', count: 2 });
    const second = cursor.claim({ inventory, nowMs: 220, limit: 2 });
    assert.deepEqual(second.fileIds, [9]);
    assert.deepEqual(cursor.record({ claim: second,
      outcomes: [{ fileId: 9, state: 'held' }], nowMs: 230 }),
    { state: 'recorded', count: 1 });
    const wrapped = cursor.claim({ inventory, nowMs: 240, limit: 2 });
    assert.equal(wrapped.pass, first.pass + 1);
    assert.deepEqual(wrapped.fileIds, [2, 5]);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('stale or malformed receipts cannot advance the file cursor', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-backfill-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const inventory = { listFileHintIds: ({ afterFileId }) =>
    [7, 8].filter((id) => id > afterFileId) };
  const cursor = openFileBackfillCursor(dbPath);
  try {
    const claim = cursor.claim({ inventory, nowMs: 100, limit: 2 });
    assert.equal(cursor.record({ claim: { ...claim, receipt: claim.receipt + 1 },
      outcomes: [{ fileId: 7, state: 'unknown' },
        { fileId: 8, state: 'unknown' }], nowMs: 101 }).state, 'held');
    assert.equal(cursor.record({ claim, outcomes: [{ fileId: 8,
      state: 'available' }], nowMs: 102 }).state, 'held');
    assert.deepEqual(cursor.claim({ inventory, nowMs: 103, limit: 2 }), claim);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an invalid inventory page holds without advancing or persisting a claim', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-backfill-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const cursor = openFileBackfillCursor(dbPath);
  try {
    const invalid = { listFileHintIds: () => [8, 7] };
    assert.deepEqual(cursor.claim({ inventory: invalid, nowMs: 100,
      limit: 2 }), { state: 'held', reason: 'invalid_file_hint_page' });
    const valid = { listFileHintIds: () => [7, 8] };
    const claim = cursor.claim({ inventory: valid, nowMs: 101, limit: 2 });
    assert.equal(claim.receipt, 1);
    assert.deepEqual(claim.fileIds, [7, 8]);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a large linked file resumes at its saved episode offset after restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-backfill-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const inventory = { listFileHintIds: ({ afterFileId }) =>
    [7, 8].filter((id) => id > afterFileId).slice(0, 1) };
  const fingerprint = 'a'.repeat(64);
  let cursor = openFileBackfillCursor(dbPath);
  try {
    const first = cursor.claim({ inventory, nowMs: 100, limit: 1 });
    assert.deepEqual(first.fileIds, [7]);
    assert.equal(first.pairOffset, 0);
    assert.equal(first.fingerprint, null);
    assert.deepEqual(cursor.record({ claim: first, outcomes: [{ fileId: 7,
      state: 'partial', nextPairOffset: 10, fingerprint }], nowMs: 200 }),
    { state: 'partial', count: 1 });
    cursor.close();
    cursor = openFileBackfillCursor(dbPath);
    const resumed = cursor.claim({ inventory, nowMs: 300, limit: 1 });
    assert.equal(resumed.pairOffset, 10);
    assert.equal(resumed.fingerprint, fingerprint);
    assert.equal(resumed.receipt, first.receipt + 1);
    assert.equal(cursor.record({ claim: first, outcomes: [{ fileId: 7,
      state: 'unknown' }], nowMs: 300 }).state, 'held');
    assert.deepEqual(cursor.record({ claim: resumed,
      outcomes: [{ fileId: 7, state: 'partial',
        nextPairOffset: 1, fingerprint: 'b'.repeat(64) }], nowMs: 301 }),
    { state: 'partial', count: 1 });
    const changed = cursor.claim({ inventory, nowMs: 302, limit: 1 });
    assert.equal(changed.pairOffset, 1);
    assert.equal(changed.fingerprint, 'b'.repeat(64));
    assert.deepEqual(cursor.record({ claim: changed,
      outcomes: [{ fileId: 7, state: 'available' }], nowMs: 301 }),
    { state: 'recorded', count: 1 });
    assert.deepEqual(cursor.claim({ inventory, nowMs: 302, limit: 1 }).fileIds,
      [8]);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

async function arrivalFixture(run){const dir=await mkdtemp(path.join(os.tmpdir(),'negev-arrival-retry-')),dbPath=path.join(dir,'state.sqlite');let cursor=openFileBackfillCursor(dbPath);const reopen=()=>{cursor.close();cursor=openFileBackfillCursor(dbPath);return cursor};try{await run({dbPath,get cursor(){return cursor},reopen})}finally{cursor.close();await rm(dir,{recursive:true,force:true})}}
const emptyHints={listFileHintIds:()=>[]};
const finishArrival=(cursor,claim,nowMs,state='unknown')=>cursor.record({claim,outcomes:claim.fileIds.map(fileId=>({fileId,state})),nowMs});
test('an initial Plex miss has durable due retry beyond restart and the historical prefix',()=>arrivalFixture(async f=>{
 const inventory={listFileHintIds:({afterFileId,limit})=>[1,2,51].filter(id=>id>afterFileId).slice(0,limit)};
 f.cursor.prioritizeFile({fileId:51,observedMs:100});const first=f.cursor.claim({inventory,nowMs:101,limit:1});assert.deepEqual(first.fileIds,[51]);finishArrival(f.cursor,first,102);f.reopen();
 const retry=f.cursor.claim({inventory,nowMs:60102,limit:1});assert.deepEqual(retry.fileIds,[51]);assert.equal(retry.priority,true);finishArrival(f.cursor,retry,60103,'available');
 const historical=f.cursor.claim({inventory,nowMs:60104,limit:1});assert.deepEqual(historical.fileIds,[1]);finishArrival(f.cursor,historical,60105);
 const db=new DatabaseSync(f.dbPath);assert.equal(db.prepare('SELECT COUNT(*) n FROM file_backfill_arrivals').get().n,0);db.close();
}));
test('arrival retries survive thirty minutes without another event or positive observer',()=>arrivalFixture(async f=>{
 f.cursor.prioritizeFile({fileId:51,observedMs:100});const first=f.cursor.claim({inventory:emptyHints,nowMs:101,limit:1});finishArrival(f.cursor,first,102);f.reopen();
 const retry=f.cursor.claim({inventory:emptyHints,nowMs:1800103,limit:1});assert.deepEqual(retry.fileIds,[51]);finishArrival(f.cursor,retry,1800104);assert.equal(f.cursor.claim({inventory:emptyHints,nowMs:1800105,limit:1}).state,'idle');
 const later=f.cursor.claim({inventory:emptyHints,nowMs:2100104,limit:1});assert.deepEqual(later.fileIds,[51]);
}));
test('continuous arrivals preserve historical turns across reopen',()=>arrivalFixture(async f=>{
 const inventory={listFileHintIds:({afterFileId,limit})=>Array.from({length:10},(_,i)=>i+1).filter(id=>id>afterFileId).slice(0,limit)};const history=[];
 for(let i=0;i<10;i++){const clock=100+i*61000;f.cursor.prioritizeFile({fileId:100+i,observedMs:clock});const claim=f.cursor.claim({inventory,nowMs:clock+1,limit:1});if(claim.priority!==true)history.push(...claim.fileIds);finishArrival(f.cursor,claim,clock+2,'available');f.reopen();}assert.deepEqual(history,[1,2,3,4,5]);
}));
test('an older in-flight success cannot erase a newer arrival generation',()=>arrivalFixture(async f=>{
 f.cursor.prioritizeFile({fileId:51,observedMs:100});const first=f.cursor.claim({inventory:emptyHints,nowMs:101,limit:1});f.cursor.prioritizeFile({fileId:51,observedMs:102});finishArrival(f.cursor,first,103,'available');f.reopen();
 const newer=f.cursor.claim({inventory:emptyHints,nowMs:104,limit:1});assert.deepEqual(newer.fileIds,[51]);finishArrival(f.cursor,newer,105,'available');assert.equal(f.cursor.claim({inventory:emptyHints,nowMs:106,limit:1}).state,'idle');
}));

test('due retries, fresh arrivals and history each retain turns under continuous intake',()=>arrivalFixture(async f=>{
 const inventory={listFileHintIds:({afterFileId,limit})=>[1,2,3,4,5,51].filter(id=>id>afterFileId).slice(0,limit)};const seen=[];
 f.cursor.prioritizeFile({fileId:51,observedMs:100});const initial=f.cursor.claim({inventory,nowMs:101,limit:1});finishArrival(f.cursor,initial,102);
 for(let i=0;i<12;i++){const clock=60102+i*61000;f.cursor.prioritizeFile({fileId:200+i,observedMs:clock});const claim=f.cursor.claim({inventory,nowMs:clock+1,limit:1});seen.push(claim.fileIds[0]);finishArrival(f.cursor,claim,clock+2,claim.fileIds[0]===51?'unknown':'available');f.reopen();}
 assert.ok(seen.filter(x=>x===51).length>=3,JSON.stringify(seen));assert.ok(seen.filter(x=>x<51).length>=3,JSON.stringify(seen));assert.ok(seen.filter(x=>x>=200).length>=3,JSON.stringify(seen));
}));
test('card-invalidated priority work also retains retry without an arrival marker',()=>arrivalFixture(async f=>{
 const db=new DatabaseSync(f.dbPath);db.prepare('INSERT INTO file_backfill_priority(file_id,rank)VALUES(51,1)').run();db.close();const first=f.cursor.claim({inventory:emptyHints,nowMs:100,limit:1});finishArrival(f.cursor,first,101);f.reopen();assert.deepEqual(f.cursor.claim({inventory:emptyHints,nowMs:60101,limit:1}).fileIds,[51]);
}));

test('duplicate or older arrival events cannot bypass the persisted retry backoff',()=>arrivalFixture(async f=>{
 f.cursor.prioritizeFile({fileId:51,observedMs:100});const first=f.cursor.claim({inventory:emptyHints,nowMs:101,limit:1});finishArrival(f.cursor,first,102);
 assert.equal(f.cursor.prioritizeFile({fileId:51,observedMs:100}).state,'unchanged');assert.equal(f.cursor.prioritizeFile({fileId:51,observedMs:99}).state,'unchanged');
 assert.equal(f.cursor.claim({inventory:emptyHints,nowMs:103,limit:1}).state,'idle');const db=new DatabaseSync(f.dbPath);assert.equal(db.prepare('SELECT observed_ms FROM file_backfill_arrivals').get().observed_ms,100);db.close();
}));
test('a definitive source transition retires only its captured arrival generation',()=>arrivalFixture(async f=>{
 f.cursor.prioritizeFile({fileId:51,observedMs:100});const first=f.cursor.claim({inventory:emptyHints,nowMs:101,limit:1});f.cursor.prioritizeFile({fileId:51,observedMs:102});f.cursor.record({claim:first,outcomes:[{fileId:51,state:'unknown',terminal:true}],nowMs:103});const next=f.cursor.claim({inventory:emptyHints,nowMs:104,limit:1});assert.deepEqual(next.fileIds,[51]);f.cursor.record({claim:next,outcomes:[{fileId:51,state:'unknown',terminal:true}],nowMs:105});assert.equal(f.cursor.claim({inventory:emptyHints,nowMs:106,limit:1}).state,'idle');
}));
