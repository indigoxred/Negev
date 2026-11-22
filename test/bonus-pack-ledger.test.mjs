import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createBonusPackLedger } from '../src/acquisition/bonus-pack-ledger.mjs';

const hash = 'a'.repeat(40);
const bonus = { name: 'Extras/OVA.mkv', size: 200, anidbId: 43,
  episodeIds: [2001], kind: 'ova', evidence: 'shoko_filename_prediction' };
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'negev-bonus-'));
  const file = path.join(dir, 'private.sqlite');
  let db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE requests(id INTEGER PRIMARY KEY);
    CREATE TABLE acquisition_attempts(id INTEGER PRIMARY KEY,request_id INTEGER,anidb_id INTEGER,status TEXT,expected_hash TEXT);
    CREATE TABLE acquisition_starts(attempt_id INTEGER PRIMARY KEY);
    CREATE TABLE acquisition_file_plans(attempt_id INTEGER,file_name TEXT,file_size INTEGER,episode_key TEXT);
    CREATE TABLE acquisition_target_claims(attempt_id INTEGER,anidb_id INTEGER,episode_id INTEGER,active INTEGER);
    CREATE TABLE acquisition_releases(attempt_id INTEGER PRIMARY KEY);
    CREATE TABLE acquisition_retirements(attempt_id INTEGER PRIMARY KEY);
    CREATE TABLE acquisition_rejections(attempt_id INTEGER PRIMARY KEY);
    INSERT INTO requests VALUES(1);
    INSERT INTO acquisition_attempts VALUES(1,1,42,'reserved','${hash}'),(2,1,44,'reserved','${hash}');
    INSERT INTO acquisition_file_plans VALUES(1,'main.mkv',100,'[1001]'),(2,'second.mkv',100,'[3001]');
    INSERT INTO acquisition_target_claims VALUES(1,42,1001,1),(2,44,3001,1);`);
  let ledger = createBonusPackLedger(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get db() { return db; }, get ledger() { return ledger; },
    plan: (files = [bonus], changes = {}) => ledger.recordBonusPlan({ attemptId: 1, hash, files, nowMs: 10, ...changes }),
    restart() { db.close(); db = new DatabaseSync(file); ledger = createBonusPackLedger(db); } };
}

test('durable independent AniDB scope, frozen plan and main claims unchanged', (t) => {
  const f = fixture(t);
  const planned = f.plan();
  assert.deepEqual(planned, { state: 'planned', files: [bonus], skipped: [] });
  f.restart();
  assert.deepEqual(f.plan(), planned);
  assert.deepEqual(f.ledger.getBonusPlan(1), [bonus]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM acquisition_target_claims').get().n, 2);
  assert.equal(f.plan([{ ...bonus, size: 201 }]).state, 'held');
  assert.equal(f.plan([{ ...bonus, anidbId: 99 }]).state, 'held');
  assert.equal(f.plan([bonus], { hash: 'b'.repeat(40) }).state, 'held');
  f.db.exec("UPDATE acquisition_attempts SET status='dispatch_unknown' WHERE id=1");
  assert.deepEqual(f.plan(), planned);
  assert.equal(f.plan([bonus, { ...bonus, name: 'extra.mkv', episodeIds: [2002] }]).state, 'held');
});

test('busy targets skip without holding main and skipped decisions remain frozen', (t) => {
  const f = fixture(t);
  f.db.exec('INSERT INTO acquisition_target_claims VALUES(2,43,2001,1)');
  const result = f.plan();
  assert.equal(result.state, 'planned');
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.skipped, [{ name: bonus.name, reason: 'target_busy' }]);
  f.db.exec('UPDATE acquisition_target_claims SET active=0 WHERE anidb_id=43');
  f.restart();
  assert.deepEqual(f.plan(), result);
  assert.deepEqual(f.ledger.getBonusPlan(1), []);
});

test('another bonus claim skips but a distinct AniDB target remains independent', (t) => {
  const f = fixture(t);
  f.plan();
  const result = f.ledger.recordBonusPlan({ attemptId: 2, hash, nowMs: 11,
    files: [bonus, { ...bonus, name: 'other.mkv', anidbId: 99 }] });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].anidbId, 99);
  assert.deepEqual(result.skipped, [{ name: bonus.name, reason: 'target_busy' }]);
});

test('reject forged evidence, malformed files and bounds atomically', (t) => {
  const f = fixture(t);
  for (const change of [{ evidence: 'title_guess' }, { anidbId: 0 }, { size: 0 },
    { size: 1024 ** 4 + 1 }, { name: '../bad.mkv' }, { name: 'a\\b.mkv' },
    { name: 'readme.txt' }, { name: 'x'.repeat(1001) + '.mkv' },
    { episodeIds: [1, 2] }, { episodeIds: [] }, { episodeIds: [0] }, { kind: 'series' }]) {
    assert.throws(() => f.plan([{ ...bonus, ...change }]), TypeError);
  }
  assert.throws(() => f.plan(Array.from({ length: 21 }, (_, i) => ({ ...bonus, name: `${i}.mkv`, episodeIds: [2001+i] }))), TypeError);
  assert.throws(() => f.plan([bonus, { ...bonus, name: bonus.name.toUpperCase(), episodeIds: [2002] }]), TypeError);
  assert.throws(() => f.plan([bonus, { ...bonus, name: 'two.mkv' }]), TypeError);
  assert.deepEqual(f.ledger.getBonusPlan(1), []);
  assert.equal(f.plan([{ ...bonus, name: 'MAIN.mkv' }]).state, 'held');
  assert.equal(f.plan([{ ...bonus, anidbId: 42, episodeIds: [1001] }]).state, 'held');
  f.db.exec('DELETE FROM acquisition_file_plans WHERE attempt_id=1');
  assert.equal(f.plan().state, 'held');
});

test('no new bonus plan after dispatch or start and no unknown attempts', (t) => {
  const f = fixture(t);
  assert.equal(f.plan([bonus], { attemptId: 99 }).state, 'held');
  f.db.exec("UPDATE acquisition_attempts SET status='dispatch_unknown' WHERE id=1");
  assert.equal(f.plan().state, 'held');
  f.db.exec("UPDATE acquisition_attempts SET status='reserved' WHERE id=1; INSERT INTO acquisition_starts VALUES(1)");
  assert.equal(f.plan().state, 'held');
});

test('pending bonuses survive main release; retire/reject excluded and deactivation preserves physical plan', (t) => {
  const f = fixture(t); f.plan();
  f.db.exec('INSERT INTO acquisition_releases VALUES(1); UPDATE acquisition_target_claims SET active=0 WHERE attempt_id=1');
  assert.equal(f.ledger.listPendingBonuses({ nowMs: 10 }).length, 1);
  f.db.exec('INSERT INTO acquisition_retirements VALUES(1)');
  assert.deepEqual(f.ledger.listPendingBonuses({ nowMs: 10 }), []);
  f.db.exec('DELETE FROM acquisition_retirements; INSERT INTO acquisition_rejections VALUES(1)');
  assert.deepEqual(f.ledger.listPendingBonuses({ nowMs: 10 }), []);
  f.ledger.deactivateBonuses(1, 20);
  assert.deepEqual(f.ledger.getBonusPlan(1), [bonus]);
  assert.equal(f.db.prepare('SELECT active FROM acquisition_bonus_files').get().active, 0);
});

test('progress is forward, idempotent, time bounded and requires exact positive file identity', (t) => {
  const f = fixture(t); f.plan();
  const progress = (status, changes = {}) => f.ledger.recordBonusProgress({ attemptId: 1, name: bonus.name, status, nowMs: 20, ...changes });
  assert.equal(progress('identified').state, 'held');
  assert.throws(() => progress('identified', { fileId: 0 }), TypeError);
  assert.equal(progress('published').state, 'published');
  assert.equal(progress('selected').state, 'held');
  assert.equal(progress('attention', { reason: 'awaiting_identity', nextCheckMs: 100 }).state, 'attention');
  assert.deepEqual(f.ledger.listPendingBonuses({ nowMs: 99 }), []);
  assert.equal(f.ledger.listPendingBonuses({ nowMs: 100 })[0].status, 'attention');
  assert.equal(progress('identified', { fileId: 9, nowMs: 100 }).state, 'identified');
  assert.equal(progress('identified', { fileId: 9, nowMs: 101 }).state, 'identified');
  assert.equal(progress('playable', { fileId: 10, nowMs: 102 }).state, 'held');
  assert.equal(progress('playable', { fileId: 9, nowMs: 102 }).state, 'playable');
  assert.equal(progress('attention', { nowMs: 103 }).state, 'held');
  assert.deepEqual(f.ledger.listPendingBonuses({ nowMs: 200 }), []);
  assert.deepEqual(f.ledger.getBonusPlan(1), [bonus]);
  assert.equal(f.db.prepare('SELECT active FROM acquisition_bonus_files').get().active, 0);
  assert.equal(f.db.prepare('SELECT active FROM acquisition_target_claims WHERE attempt_id=1').get().active, 1);
});

test('parent retirement transaction can deactivate bonuses without nesting and roll back together', (t) => {
  const f = fixture(t); f.plan();
  f.db.exec('BEGIN IMMEDIATE');
  f.ledger.deactivateBonuses(1, 20);
  assert.equal(f.db.prepare('SELECT active FROM acquisition_bonus_files').get().active, 0);
  f.db.exec('ROLLBACK');
  assert.equal(f.db.prepare('SELECT active FROM acquisition_bonus_files').get().active, 1);
  assert.deepEqual(f.ledger.getBonusPlan(1), [bonus]);
});

test('verified playable bonus releases only its independent target for a later claim', (t) => {
  const f = fixture(t); f.plan();
  for (const [index, status] of ['published', 'identified', 'playable'].entries()) {
    f.ledger.recordBonusProgress({ attemptId: 1, name: bonus.name, status,
      nowMs: 20+index, ...(status === 'published' ? {} : { fileId: 9 }) });
  }
  assert.equal(f.ledger.recordBonusProgress({ attemptId: 1, name: bonus.name,
    status: 'playable', fileId: 9, nowMs: 19 }).state, 'held');
  const result = f.ledger.recordBonusPlan({ attemptId: 2, hash, files: [bonus], nowMs: 30 });
  assert.deepEqual(result.files, [bonus]);
  assert.equal(f.db.prepare('SELECT active FROM acquisition_target_claims WHERE attempt_id=1').get().active, 1);
  assert.deepEqual(f.ledger.getBonusPlan(1), [bonus]);
  assert.throws(() => f.ledger.listPendingBonuses({ nowMs: 30, limit: 0 }), TypeError);
});

test('a retained bonus under review cannot be acquired again opportunistically by another pack',t=>{
 const f=fixture(t);f.plan();assert.equal(f.ledger.releaseBonusClaimForReview({attemptId:1,name:bonus.name,publishedMs:10,nowMs:900010,reason:'bonus_awaiting_shoko'}).state,'attention');
 const second=f.ledger.recordBonusPlan({attemptId:2,hash,files:[bonus],nowMs:900011});
 assert.equal(second.files.length,0);assert.deepEqual(second.skipped,[{name:bonus.name,reason:'bonus_review_pending'}]);
});

test('a released bonus awaiting Plex proof still prevents a second opportunistic bonus',t=>{
 const f=fixture(t);f.plan();f.ledger.recordBonusProgress({attemptId:1,name:bonus.name,status:'published',nowMs:11});
 f.ledger.releaseBonusClaimForReview({attemptId:1,name:bonus.name,publishedMs:10,nowMs:900010,reason:'bonus_awaiting_shoko'});
 assert.equal(f.ledger.recordBonusProgress({attemptId:1,name:bonus.name,status:'identified',fileId:77,nowMs:900011}).state,'identified');
 const second=f.ledger.recordBonusPlan({attemptId:2,hash,files:[bonus],nowMs:900012});
 assert.equal(second.files.length,0);assert.equal(second.skipped[0].reason,'bonus_review_pending');
});
