import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createBonusPackLedger } from '../src/acquisition/bonus-pack-ledger.mjs';
import { processBonusImport } from '../src/acquisition/process-bonus-import.mjs';

const hash = 'a'.repeat(40);
const bonus = { name: 'Film.mkv', size: 100, anidbId: 500, episodeIds: [901],
  kind: 'movie', evidence: 'shoko_filename_prediction' };
const observedFile = { fileId: 77, anidbId: 500, episodeIds: [901], size: 100,
  coverage: [{ episodeId: 901, start: 0, end: 100 }],
  releaseEvidence: 'shoko_offline_link', sourcePaths: ['/pure/Anime/Film.mkv'] };
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'negev-bonus-import-'));
  const dbPath = path.join(dir, 'private.sqlite');
  let db = new DatabaseSync(dbPath), ledger;
  db.exec(`CREATE TABLE requests(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE acquisition_attempts(id INTEGER PRIMARY KEY,anidb_id INTEGER,status TEXT,expected_hash TEXT);
    CREATE TABLE acquisition_starts(attempt_id INTEGER);
    CREATE TABLE acquisition_file_plans(attempt_id INTEGER,file_name TEXT,file_size INTEGER,episode_key TEXT);
    CREATE TABLE acquisition_target_claims(attempt_id INTEGER,anidb_id INTEGER,episode_id INTEGER,active INTEGER);
    INSERT INTO requests VALUES(1,'fulfilled');
    INSERT INTO acquisition_attempts VALUES(1,42,'reserved','${hash}');
    INSERT INTO acquisition_file_plans VALUES(1,'main.mkv',100,'[1001]');
    INSERT INTO acquisition_target_claims VALUES(1,42,1001,0);`);
  ledger = createBonusPackLedger(db);
  ledger.recordBonusPlan({ attemptId: 1, hash, files: [bonus], nowMs: 1 });
  const calls = { read: [], public: [], progress: [] };
  let move = { status: 'published_observed', manifest: { attemptId: 1, torrentHash: hash,
    files: [{ name: 'unavailable-main.mkv', size: 999, dev: '9', ino: '8', mtimeNs: '7', episodeIds: [1001] },
      { ...bonus, scope: 'bonus', dev: '12', ino: '34', mtimeNs: '56' }] } };
  let read = async () => ({ state: 'ok', complete: true, files: [observedFile] });
  let verify = async () => ({ state: 'playable', anidbId: 500, episodeId: 901, fileId: 77 });
  let probe = async () => ({ state: 'candidate', candidateKey: '12:34:100:56' });
  let time = 100;
  const acquisitions = { getAttempt: () => ({ id: 1, requestId: 1, status: 'torrent_observed',
    anidbId: 42, expectedHash: hash, torrentHash: hash }),
    getBonusPlan: (...args) => ledger.getBonusPlan(...args),
    releaseBonusClaimForReview: input => ledger.releaseBonusClaimForReview(input),
    recordBonusProgress: (input) => { calls.progress.push(input); return ledger.recordBonusProgress(input); } };
  const item = () => ledger.listPendingBonuses({ nowMs: time })[0];
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { calls, acquisitions, get ledger() { return ledger; }, get db() { return db; },
    get move() { return move; }, set move(value) { move = value; },
    set read(value) { read = value; }, set verify(value) { verify = value; }, set probe(value) { probe = value; },
    set time(value) { time = value; }, item,
    restart() { db.close(); db = new DatabaseSync(dbPath); ledger = createBonusPackLedger(db); },
    run: (changes = {}) => processBonusImport({ item: item(), acquisitions,
      pureMoves: { getIntent: () => move },
      readEpisode: async (input) => { calls.read.push(input); return read(input); },
      verifyPublic: async (input) => { calls.public.push(input); return verify(input); },
      probeImpl: (...args) => probe(...args), now: () => time,
      shokoMount: { appRoot: '/pure', localRoot: process.platform === 'win32' ? 'C:\\pure' : '/pure' }, ...changes }) };
}

test('fulfilled main is irrelevant: one independent film becomes playable using its exact file', async (t) => {
  const f = fixture(t);
  assert.equal((await f.run()).state, 'bonus_playable');
  assert.deepEqual(f.calls.read, [{ anidbId: 500, episodeId: 901 }]);
  assert.deepEqual(f.calls.public, [{ anidbId: 500, episodeId: 901, fileId: 77, kind: 'movie' }]);
  assert.deepEqual(f.calls.progress.map((row) => row.status), ['published', 'identified', 'playable']);
  assert.equal(f.db.prepare('SELECT active FROM acquisition_bonus_files').get().active, 0);
  assert.equal(f.db.prepare('SELECT active FROM acquisition_target_claims').get().active, 0);
});

test('missing or unpublished journal backs off without reads or publication writes', async (t) => {
  for (const status of [null, 'moving', 'prepared']) {
    const f = fixture(t);
    f.move = status ? { ...f.move, status } : null;
    const result = await f.run();
    assert.equal(result.state, 'bonus_waiting');
    assert.equal(f.calls.read.length, 0);
    assert.equal(f.calls.public.length, 0);
    assert.equal(f.calls.progress[0].status, 'selected');
    assert.equal(f.calls.progress[0].nextCheckMs, 60100);
  }
});

test('forged item, journal scope, identity and parent hash never reach public verification', async (t) => {
  for (const mutate of [
    (f) => { f.move.manifest.files[1].scope = 'main'; },
    (f) => { f.move.manifest.files[1].anidbId = 42; },
    (f) => { f.move.manifest.files[1].size = 101; },
    (f) => { f.move.manifest.files[1].kind = 'ova'; },
    (f) => { f.move.manifest.torrentHash = 'b'.repeat(40); },
    (f) => { f.move.manifest.attemptId = 2; },
    (f) => { f.acquisitions.getAttempt = () => ({ expectedHash: hash, torrentHash: 'b'.repeat(40) }); },
  ]) {
    const f = fixture(t); mutate(f);
    assert.equal((await f.run()).state, 'bonus_waiting');
    assert.equal(f.calls.public.length, 0);
  }
  const f = fixture(t);
  assert.equal((await f.run({ item: { ...f.item(), anidbId: 42 } })).state, 'bonus_waiting');
  assert.equal(f.calls.public.length, 0);
});

test('unknown publication requires exact own-file Shoko evidence before advancing', async (t) => {
  const f = fixture(t); f.move.status = 'publish_unknown';
  f.probe = async () => ({ state: 'candidate', candidateKey: '12:35:100:56' });
  assert.equal((await f.run()).state, 'bonus_waiting');
  assert.equal(f.calls.progress.some((row) => row.status === 'published'), false);
  assert.equal(f.calls.public.length, 0);
  f.time = 60200; f.restart();
  f.probe = async () => ({ state: 'candidate', candidateKey: '12:34:100:56' });
  assert.equal((await f.run()).state, 'bonus_playable');
  assert.equal(f.move.status, 'publish_unknown');
});

test('public proof must match exact AniDB episode and new file, including after restart', async (t) => {
  for (const changes of [{ fileId: 76 }, { anidbId: 42 }, { episodeId: 1001 }, { state: 'available' }]) {
    const f = fixture(t);
    f.verify = async () => ({ state: 'playable', anidbId: 500, episodeId: 901, fileId: 77, ...changes });
    assert.equal((await f.run()).state, 'bonus_waiting');
    assert.equal(f.db.prepare('SELECT active FROM acquisition_bonus_files').get().active, 1);
    f.time = 60200; f.restart();
    f.verify = async () => ({ state: 'playable', anidbId: 500, episodeId: 901, fileId: 77 });
    assert.equal((await f.run()).state, 'bonus_playable');
  }
});

test('Shoko and public errors are neutral retries with at least sixty seconds backoff', async (t) => {
  const f = fixture(t); f.read = async () => { throw new Error('offline'); };
  assert.equal((await f.run()).state, 'bonus_waiting');
  assert.equal(f.calls.public.length, 0);
  assert.equal(f.calls.progress.at(-1).nextCheckMs, 60100);
  f.time = 60200; f.read = async () => ({ state: 'ok', complete: true, files: [observedFile] });
  f.verify = async () => { throw new Error('offline'); };
  assert.equal((await f.run()).state, 'bonus_waiting');
  assert.equal(f.calls.progress.at(-1).nextCheckMs, 120200);
});

test('identified attention resumes without regressing its durable progress stage', async (t) => {
  const f = fixture(t);
  for (const status of ['published', 'identified', 'attention']) {
    f.ledger.recordBonusProgress({ attemptId: 1, name: bonus.name, status, nowMs: 50,
      ...(status === 'published' ? {} : { fileId: 77 }) });
  }
  f.restart();
  assert.equal(f.item().status, 'attention');
  assert.equal((await f.run()).state, 'bonus_playable');
  assert.deepEqual(f.calls.progress.map((row) => row.status), ['identified', 'playable']);
});

test('journal inode validation and duplicate filenames cannot prove a bonus', async (t) => {
  for (const mutate of [
    (f) => { f.move.manifest.files[1].ino = 'invalid'; },
    (f) => { f.move.manifest.files[1].episodeIds = [902]; },
    (f) => { f.move.manifest.files.push({ ...f.move.manifest.files[1], name: 'FILM.mkv' }); },
  ]) {
    const f = fixture(t); mutate(f);
    assert.equal((await f.run()).state, 'bonus_waiting');
    assert.equal(f.calls.public.length, 0);
    assert.equal(f.db.prepare('SELECT active FROM acquisition_bonus_files').get().active, 1);
  }
});

test('one bonus never waits for or changes another bonus in the physical manifest', async (t) => {
  const f = fixture(t);
  f.move.manifest.files.push({ ...bonus, name: 'Other.mkv', scope: 'bonus',
    anidbId: 999, episodeIds: [9999], dev: 'invalid', ino: '0', mtimeNs: '0' });
  assert.equal((await f.run()).state, 'bonus_playable');
  assert.deepEqual(f.calls.read, [{ anidbId: 500, episodeId: 901 }]);
  assert.equal(f.move.manifest.files[2].dev, 'invalid');
});

test('bonus observation relinquishes exclusivity after its original publication window and survives restart',async t=>{
 const f=fixture(t);f.move.updatedMs=2;f.read=async()=>({state:'ok',complete:true,files:[]});
 f.time=900002;f.restart();
 const result=await f.run();assert.equal(result.state,'bonus_review');
 assert.equal(f.db.prepare('SELECT active FROM acquisition_bonus_files').get().active,0);
 assert.equal(f.db.prepare('SELECT active FROM acquisition_target_claims').get().active,0);
 f.time=7*86400000;f.restart();f.read=async()=>({state:'ok',complete:true,files:[observedFile]});
 assert.equal((await f.run()).state,'bonus_playable');
 assert.equal(f.db.prepare('SELECT reason FROM acquisition_bonus_files').get().reason,null);
});

test('bonus deadline starts at publication, never expires a pending download, and leaves main ownership intact',async t=>{
 for(const unpublished of [true,false]){
  const f=fixture(t);f.read=async()=>({state:'ok',complete:true,files:[]});f.db.exec('UPDATE acquisition_target_claims SET active=1');
  f.time=7*86400000;f.move.updatedMs=f.time-100;
  if(unpublished)f.move.status='prepared';
  assert.equal((await f.run()).state,'bonus_waiting');
  assert.equal(f.db.prepare('SELECT active FROM acquisition_bonus_files').get().active,1);
  assert.equal(f.db.prepare('SELECT active FROM acquisition_target_claims').get().active,1);
 }
});
