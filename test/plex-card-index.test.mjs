import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPlexCardIndex } from '../src/availability/plex-card-index.mjs';
import { indexPlexCardPage, retryOnePlexCard } from
  '../src/availability/plex-card-page-worker.mjs';

const cleanup = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((dir) => rm(dir,
  { recursive: true, force: true }))));
async function index() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-plex-index-'));
  cleanup.push(dir);
  return { path: path.join(dir, 'negev.sqlite'), ledger: openPlexCardIndex(
    path.join(dir, 'negev.sqlite')) };
}
const card = (ratingKey = 500, size = 5) => ({ libraryId: 102,
  ratingKey, kind: 'episode', parts: [{ partId: ratingKey + 100,
    libraryId: 102, plexPath: `/source-pure/${ratingKey}.mkv`, size }] });

test('a durable physical identity selects one of many same-size Parts', async () => {
  const { path: dbPath, ledger } = await index();
  for (let ratingKey = 500; ratingKey < 512; ratingKey++) {
    const item = card(ratingKey);
    item.parts[0].candidateKey = `1:${ratingKey}:5`;
    ledger.recordCard({ ...item, observedMs: 10 });
  }
  assert.deepEqual(ledger.lookupCards({ sizes: [5], libraryIds: [102],
    kind: 'episode' }), { state: 'held', reason: 'candidate_budget_exceeded' });
  ledger.close();
  const reopened = openPlexCardIndex(dbPath);
  assert.deepEqual(reopened.lookupCardsByCandidateKey({ keys: ['1:505:5'],
    libraryIds: [102], kind: 'episode' }),
  { state: 'candidates', cards: [{ libraryId: 102, ratingKey: 505 }] });
  assert.deepEqual(reopened.lookupCardsByCandidateKey({ keys: ['1:505:5'],
    libraryIds: [103], kind: 'episode' }),
  { state: 'candidates', cards: [] });
  reopened.close();
});

test('refresh and removal retire the old physical identity candidate', async () => {
  const { ledger } = await index();
  const first = card(); first.parts[0].candidateKey = '1:10:5';
  ledger.recordCard({ ...first, observedMs: 10 });
  const replacement = card(); replacement.parts[0].candidateKey = '1:11:5';
  ledger.recordCard({ ...replacement, observedMs: 11 });
  const lookup = (key) => ledger.lookupCardsByCandidateKey({ keys: [key],
    libraryIds: [102], kind: 'episode' }).cards;
  assert.deepEqual(lookup('1:10:5'), []);
  assert.equal(lookup('1:11:5').length, 1);
  ledger.forgetCard({ libraryId: 102, ratingKey: 500, observedMs: 12 });
  assert.deepEqual(lookup('1:11:5'), []);
  ledger.close();
});

test('malformed physical identity candidates cannot enter or query the index', async () => {
  const { ledger } = await index();
  for (const key of ['1:2:6', '01:2:5', '1:0:5', '1:2:5\n', 'x:2:5']) {
    const item = card(); item.parts[0].candidateKey = key;
    assert.throws(() => ledger.recordCard({ ...item, observedMs: 10 }), TypeError);
    if (key !== '1:2:6') {
      assert.throws(() => ledger.lookupCardsByCandidateKey({ keys: [key],
        libraryIds: [102], kind: 'episode' }), TypeError);
    }
  }
  ledger.close();
});

test('legacy size-only index migrates without inventing physical identity', async () => {
  const { path: dbPath, ledger } = await index();
  ledger.close();
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TABLE plex_part_candidates');
  db.exec(`CREATE TABLE plex_part_candidates (
    library_id INTEGER NOT NULL, rating_key INTEGER NOT NULL,
    part_id INTEGER NOT NULL CHECK(part_id>0),
    file_size INTEGER NOT NULL CHECK(file_size>0),
    plex_path TEXT NOT NULL,
    PRIMARY KEY(library_id,rating_key,part_id),
    FOREIGN KEY(library_id,rating_key)
      REFERENCES plex_card_observations(library_id,rating_key)) STRICT`);
  db.prepare(`INSERT INTO plex_card_observations
    (library_id,rating_key,kind,observed_ms) VALUES (102,500,'episode',10)`).run();
  db.prepare(`INSERT INTO plex_part_candidates
    (library_id,rating_key,part_id,file_size,plex_path)
    VALUES (102,500,600,5,'/source-pure/500.mkv')`).run();
  db.close();
  const reopened = openPlexCardIndex(dbPath);
  assert.deepEqual(reopened.lookupCardsByCandidateKey({ keys: ['1:10:5'],
    libraryIds: [102], kind: 'episode' }).cards, []);
  const item = card(501); item.parts[0].candidateKey = '1:11:5';
  reopened.recordCard({ ...item, observedMs: 11 });
  assert.equal(reopened.lookupCardsByCandidateKey({ keys: ['1:11:5'],
    libraryIds: [102], kind: 'episode' }).cards.length, 1);
  reopened.close();
});

test('records scoped positive Parts and looks up only matching public card sizes', async () => {
  const { path: dbPath, ledger } = await index();
  assert.deepEqual(ledger.recordCard({ ...card(), observedMs: 10 }),
    { state: 'recorded_card' });
  assert.deepEqual(ledger.lookupCards({ sizes: [5], libraryIds: [102], kind: 'episode' }),
    { state: 'candidates', cards: [{ libraryId: 102, ratingKey: 500 }] });
  assert.deepEqual(ledger.lookupCards({ sizes: [5], libraryIds: [103], kind: 'episode' }),
    { state: 'candidates', cards: [] });
  assert.deepEqual(ledger.lookupCards({ sizes: [5], libraryIds: [102], kind: 'movie' }),
    { state: 'candidates', cards: [] });
  ledger.close();
  const reopened = openPlexCardIndex(dbPath);
  assert.equal(reopened.lookupCards({ sizes: [5], libraryIds: [102],
    kind: 'episode' }).cards.length, 1);
  reopened.close();
});

test('a newer card refresh replaces old Parts; an older page cannot revert it', async () => {
  const { ledger } = await index();
  ledger.recordCard({ ...card(), observedMs: 10 });
  ledger.recordCard({ ...card(500, 8), observedMs: 20 });
  assert.deepEqual(ledger.recordCard({ ...card(), observedMs: 15 }),
    { state: 'stale_card' });
  assert.equal(ledger.lookupCards({ sizes: [5], libraryIds: [102],
    kind: 'episode' }).cards.length, 0);
  assert.equal(ledger.lookupCards({ sizes: [8], libraryIds: [102],
    kind: 'episode' }).cards.length, 1);
  ledger.close();
});

test('a confirmed missing card retires its indexed Parts without erasing a newer observation', async () => {
  const { ledger } = await index();
  ledger.recordCard({ ...card(), observedMs: 10 });
  assert.deepEqual(ledger.forgetCard({ libraryId: 102, ratingKey: 500,
    observedMs: 9 }), { state: 'stale_card' });
  assert.equal(ledger.lookupCards({ sizes: [5], libraryIds: [102],
    kind: 'episode' }).cards.length, 1);
  const result = await indexPlexCardPage({ libraryId: 102, kind: 'episode',
    offset: 0, now: () => 11, index: ledger,
    readPage: async () => ({ state: 'page', libraryId: 102, kind: 'episode',
      offset: 0, totalSize: 1, keys: [500], complete: false }),
    readCard: async () => ({ state: 'not_found' }) });
  assert.equal(result.state, 'page_indexed');
  assert.deepEqual(ledger.lookupCards({ sizes: [5], libraryIds: [102],
    kind: 'episode' }), { state: 'candidates', cards: [] });
  ledger.close();
});

test('a missing-card observation survives restart and rejects a delayed older card page', async () => {
  const { path: dbPath, ledger } = await index();
  ledger.recordCard({ ...card(), observedMs: 10 });
  assert.deepEqual(ledger.forgetCard({ libraryId: 102, ratingKey: 500,
    observedMs: 20 }), { state: 'card_forgotten' });
  ledger.close();
  const reopened = openPlexCardIndex(dbPath);
  assert.deepEqual(reopened.recordCard({ ...card(), observedMs: 15 }),
    { state: 'stale_card' });
  assert.deepEqual(reopened.lookupCards({ sizes: [5], libraryIds: [102],
    kind: 'episode' }), { state: 'candidates', cards: [] });
  assert.deepEqual(reopened.recordCard({ ...card(), observedMs: 21 }),
    { state: 'recorded_card' });
  reopened.close();
});

test('an unseen missing card also rejects an older in-flight read', async () => {
  const { ledger } = await index();
  assert.deepEqual(ledger.forgetCard({ libraryId: 102, ratingKey: 500,
    observedMs: 20 }), { state: 'card_absent' });
  assert.deepEqual(ledger.recordCard({ ...card(), observedMs: 19 }),
    { state: 'stale_card' });
  ledger.close();
});

test('a confirmed missing retry also retires its old Part candidate', async () => {
  const { ledger } = await index();
  ledger.recordCard({ ...card(), observedMs: 10 });
  ledger.deferCard({ libraryId: 102, ratingKey: 500,
    kind: 'episode', nowMs: 10 });
  const result = await retryOnePlexCard({ libraryId: 102, kind: 'episode',
    index: ledger, now: () => 60_010,
    readCard: async () => ({ state: 'not_found' }) });
  assert.deepEqual(result, { state: 'retry_missing', ratingKey: 500 });
  assert.deepEqual(ledger.lookupCards({ sizes: [5], libraryIds: [102],
    kind: 'episode' }), { state: 'candidates', cards: [] });
  assert.equal(ledger.nextRetry({ libraryId: 102,
    kind: 'episode', nowMs: 100_000 }), null);
  ledger.close();
});

test('an exact card with no Media retires its old Part candidate', async () => {
  const { ledger } = await index();
  ledger.recordCard({ ...card(), observedMs: 10 });
  const result = await indexPlexCardPage({ libraryId: 102, kind: 'episode',
    offset: 0, now: () => 11, index: ledger,
    readPage: async () => ({ state: 'page', libraryId: 102, kind: 'episode',
      offset: 0, totalSize: 1, keys: [500], complete: false }),
    readCard: async () => ({ state: 'no_parts' }) });
  assert.equal(result.state, 'page_indexed');
  assert.deepEqual(ledger.lookupCards({ sizes: [5], libraryIds: [102],
    kind: 'episode' }), { state: 'candidates', cards: [] });
  ledger.close();
});

test('too many same-size candidates hold rather than dropping one arbitrarily', async () => {
  const { ledger } = await index();
  for (let key = 1; key <= 11; key++) {
    ledger.recordCard({ ...card(key), observedMs: key });
  }
  assert.deepEqual(ledger.lookupCards({ sizes: [5], libraryIds: [102],
    kind: 'episode' }), { state: 'held', reason: 'candidate_budget_exceeded' });
  ledger.close();
});

test('invalid section identity, paths and parts cannot enter the index', async () => {
  const { ledger } = await index();
  for (const input of [
    { ...card(), parts: [{ ...card().parts[0], libraryId: 103 }] },
    { ...card(), parts: [{ ...card().parts[0], plexPath: '/source-pure/../bad' }] },
    { ...card(), parts: [{ ...card().parts[0], size: 0 }] },
    { ...card(), parts: [] },
  ]) assert.throws(() => ledger.recordCard({ ...input, observedMs: 10 }), TypeError);
  assert.deepEqual(ledger.lookupCards({ sizes: [5], libraryIds: [102], kind: 'episode' }),
    { state: 'candidates', cards: [] });
  ledger.close();
});

test('page cursor is durable and rejects a stale concurrent advance', async () => {
  const { path: dbPath, ledger } = await index();
  assert.equal(ledger.getCursor({ libraryId: 102, kind: 'episode' }), 0);
  assert.deepEqual(ledger.advanceCursor({ libraryId: 102, kind: 'episode',
    expectedOffset: 0, nextOffset: 5 }),
  { state: 'cursor_advanced', offset: 5 });
  assert.deepEqual(ledger.advanceCursor({ libraryId: 102, kind: 'episode',
    expectedOffset: 0, nextOffset: 10 }),
  { state: 'held', reason: 'stale_cursor' });
  ledger.close();
  const reopened = openPlexCardIndex(dbPath);
  assert.equal(reopened.getCursor({ libraryId: 102, kind: 'episode' }), 5);
  assert.equal(reopened.getCursor({ libraryId: 102, kind: 'movie' }), 0);
  reopened.close();
});

test('failed card reads retain one bounded durable retry until a successful card', async () => {
  const { path: dbPath, ledger } = await index();
  assert.deepEqual(ledger.deferCard({ libraryId: 102, ratingKey: 500,
    kind: 'episode', nowMs: 10 }), { state: 'retry_deferred' });
  assert.equal(ledger.nextRetry({ libraryId: 102, kind: 'episode', nowMs: 60_009 }), null);
  ledger.close();
  const reopened = openPlexCardIndex(dbPath);
  assert.deepEqual(reopened.nextRetry({ libraryId: 102, kind: 'episode', nowMs: 60_010 }),
    { ratingKey: 500 });
  reopened.recordCard({ ...card(), observedMs: 60_011 });
  assert.equal(reopened.nextRetry({ libraryId: 102, kind: 'episode', nowMs: 99_999 }), null);
  reopened.close();
});
