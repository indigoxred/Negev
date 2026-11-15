import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openReleaseFeedLedger } from '../src/acquisition/release-feed-ledger.mjs';

test('seeds existing feed, wakes only a matching waiting request, and survives restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-rss-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE requests (id INTEGER PRIMARY KEY,title TEXT,anidb_id INTEGER,
      status TEXT,cancelled_ms INTEGER,monitor_future INTEGER,watch_closed INTEGER);
      CREATE TABLE request_targets (request_id INTEGER);
      CREATE TABLE acquisition_request_suspensions (request_id INTEGER);
      CREATE TABLE acquisition_request_checks (request_id INTEGER PRIMARY KEY,
        state TEXT,reason TEXT,next_due_ms INTEGER);`);
    db.exec(`INSERT INTO requests VALUES
      (1,'Example Anime',100,'held',NULL,1,0),
      (2,'Other Anime',101,'held',NULL,1,0),
      (3,'Example Anime',100,'held',NULL,1,1);
      INSERT INTO request_targets VALUES (1),(2),(3);
      INSERT INTO acquisition_request_checks VALUES
      (1,'held','no_release_candidates',9000000),
      (2,'held','no_release_candidates',9000000),
      (3,'held','no_release_candidates',9000000);`);
    db.close();
    const first = openReleaseFeedLedger(dbPath);
    const old = { guid: 'https://nyaa.si/view/1', title: 'Example Anime 01',
      indexerId: 5, publishedMs: 1_000 };
    assert.deepEqual(first.accept({ indexerId: 5, items: [old], nowMs: 10_000 }),
      { state: 'seeded', newItems: 0, wokenRequests: 0 });
    first.close();
    const second = openReleaseFeedLedger(dbPath);
    const fresh = { ...old, guid: 'https://nyaa.si/view/2', publishedMs: 11_000 };
    assert.deepEqual(second.accept({ indexerId: 5, items: [old, fresh], nowMs: 12_000 }),
      { state: 'processed', newItems: 1, wokenRequests: 1 });
    assert.deepEqual(second.accept({ indexerId: 5, items: [fresh], nowMs: 13_000 }),
      { state: 'processed', newItems: 0, wokenRequests: 0 });
    second.close();
    const verify = new DatabaseSync(dbPath);
    assert.equal(verify.prepare('SELECT next_due_ms FROM acquisition_request_checks WHERE request_id=1').get().next_due_ms, 12_000);
    assert.equal(verify.prepare('SELECT next_due_ms FROM acquisition_request_checks WHERE request_id=2').get().next_due_ms, 9_000_000);
    assert.equal(verify.prepare('SELECT next_due_ms FROM acquisition_request_checks WHERE request_id=3').get().next_due_ms, 9_000_000);
    assert.equal(verify.prepare("SELECT sql FROM sqlite_master WHERE name='rss_seen'").get().sql.includes('guid TEXT'), false);
    verify.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a feed hit wakes a future watch with no targets and tightens its temporary metadata cadence', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-rss-upcoming-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  let feed;
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE requests (id INTEGER PRIMARY KEY,title TEXT,anidb_id INTEGER,
      status TEXT,cancelled_ms INTEGER,monitor_future INTEGER,watch_closed INTEGER);
      CREATE TABLE request_targets (request_id INTEGER);
      CREATE TABLE acquisition_request_suspensions (request_id INTEGER);
      CREATE TABLE acquisition_request_checks (request_id INTEGER PRIMARY KEY,
        state TEXT,reason TEXT,next_due_ms INTEGER);
      INSERT INTO requests VALUES (1,'Example Anime',100,'held',NULL,1,0);`);
    db.close();
    feed = openReleaseFeedLedger(dbPath);
    assert.equal(feed.getPollIntervalMs({ nowMs: 1_000 }), 3_600_000);
    feed.accept({ indexerId: 5, items: [], nowMs: 1_000 });
    const result = feed.accept({ indexerId: 5, items: [{
      guid: 'new-release', title: 'Example Anime 01', indexerId: 5,
      publishedMs: 2_000 }], nowMs: 2_000 });
    assert.equal(result.wokenRequests, 1);
    const verify = new DatabaseSync(dbPath);
    assert.equal(verify.prepare('SELECT next_metadata_ms FROM rss_watch_timing WHERE request_id=1').get().next_metadata_ms, 2_000);
    verify.close();
  } finally { feed?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a same-ID trusted alias can wake an active request', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-rss-alias-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  let feed;
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE requests (id INTEGER PRIMARY KEY,title TEXT,anidb_id INTEGER,
      status TEXT,cancelled_ms INTEGER,monitor_future INTEGER,watch_closed INTEGER);
      CREATE TABLE acquisition_request_suspensions (request_id INTEGER);
      CREATE TABLE acquisition_request_checks (request_id INTEGER PRIMARY KEY,
        state TEXT,reason TEXT,next_due_ms INTEGER);
      INSERT INTO requests VALUES (1,'Japanese Catalogue Title',100,'held',NULL,1,0);
      INSERT INTO acquisition_request_checks VALUES
        (1,'held','no_release_candidates',9000000);`);
    db.close();
    feed = openReleaseFeedLedger(dbPath, { aliasesForId: (id) =>
      id === 100 ? ['Trusted English Name'] : [] });
    feed.accept({ indexerId: 5, items: [], nowMs: 1000 });
    const result = feed.accept({ indexerId: 5, items: [{ guid: 'alias-1',
      title: 'Trusted English Name - 01', indexerId: 5,
      publishedMs: 2000 }], nowMs: 2000 });
    assert.equal(result.wokenRequests, 1);
  } finally { feed?.close(); await rm(dir, { recursive: true, force: true }); }
});
