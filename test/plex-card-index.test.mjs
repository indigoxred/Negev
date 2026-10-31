import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openPlexCardIndex } from '../src/availability/plex-card-index.mjs';

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
