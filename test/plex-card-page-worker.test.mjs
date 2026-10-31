import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlexCardPageWorker, indexPlexCardPage,
  retryOnePlexCard } from '../src/availability/plex-card-page-worker.mjs';

const card = (key) => ({ state: 'ok', complete: true,
  parts: [{ partId: key + 10, libraryId: 102,
    plexPath: `/source-pure/${key}.mkv`, size: 5 }] });

test('one bounded page records positive cards and yields the next offset', async () => {
  const recorded = [];
  const result = await indexPlexCardPage({ libraryId: 102, kind: 'episode',
    offset: 0, pageSize: 2, now: () => 50,
    readPage: async (input) => {
      assert.deepEqual(input, { libraryId: 102, kind: 'episode', offset: 0,
        pageSize: 2 });
      return { state: 'page', libraryId: 102, kind: 'episode', offset: 0,
        totalSize: 9, keys: [500, 501], complete: false };
    }, readCard: async ({ ratingKey }) => card(ratingKey),
    index: { recordCard(input) { recorded.push(input); return { state: 'recorded_card' }; } } });
  assert.deepEqual(result, { state: 'page_indexed', processed: 2, nextOffset: 2 });
  assert.deepEqual(recorded.map((row) => row.ratingKey), [500, 501]);
  assert.deepEqual(recorded.map((row) => row.observedMs), [50, 50]);
});

test('a final short page wraps but never claims a complete Plex catalogue', async () => {
  const result = await indexPlexCardPage({ libraryId: 102, kind: 'episode',
    offset: 5, pageSize: 2, now: () => 50,
    readPage: async () => ({ state: 'page', libraryId: 102, kind: 'episode',
      offset: 5, totalSize: 6, keys: [506], complete: false }),
    readCard: async () => card(506),
    index: { recordCard: () => ({ state: 'recorded_card' }) } });
  assert.deepEqual(result, { state: 'page_indexed', processed: 1, nextOffset: 0 });
});

test('card outage skips one card while later pages remain reachable', async () => {
  const recorded = [];
  const deferred = [];
  const result = await indexPlexCardPage({ libraryId: 102, kind: 'episode',
    offset: 0, pageSize: 2, now: () => 50,
    readPage: async () => ({ state: 'page', libraryId: 102, kind: 'episode',
      offset: 0, totalSize: 9, keys: [500, 501], complete: false }),
    readCard: async ({ ratingKey }) => ratingKey === 500 ? card(500) :
      { state: 'unavailable' },
    index: { recordCard: (input) => { recorded.push(input); return { state: 'recorded_card' }; },
      deferCard: (input) => { deferred.push(input); return { state: 'retry_deferred' }; } } });
  assert.deepEqual(result, { state: 'page_indexed', processed: 1,
    skipped: 1, nextOffset: 2 });
  assert.deepEqual(recorded.map((row) => row.ratingKey), [500]);
  assert.deepEqual(deferred, [{ libraryId: 102, ratingKey: 501,
    kind: 'episode', nowMs: 50 }]);
});

test('malformed key page does not record or advance', async () => {
  let cardReads = 0;
  const result = await indexPlexCardPage({ libraryId: 102, kind: 'episode',
    offset: 0, pageSize: 2, now: () => 50,
    readPage: async () => ({ state: 'page', libraryId: 103, kind: 'episode',
      offset: 0, totalSize: 9, keys: [500], complete: false }),
    readCard: async () => { cardReads++; return card(500); },
    index: { recordCard: () => { throw Error('should not write'); } } });
  assert.deepEqual(result, { state: 'held', reason: 'key_page_unavailable' });
  assert.equal(cardReads, 0);
});

test('page worker advances after a skipped card and later pages remain reachable', async () => {
  let offset = 0;
  let failSecond = true;
  const index = {
    getCursor: () => offset,
    recordCard: () => ({ state: 'recorded_card' }),
    advanceCursor({ expectedOffset, nextOffset }) {
      assert.equal(expectedOffset, offset);
      offset = nextOffset;
      return { state: 'cursor_advanced', offset };
    },
  };
  const worker = createPlexCardPageWorker({ libraryId: 102, kind: 'episode',
    pageSize: 2, index, now: () => 50,
    readPage: async ({ offset: current }) => ({ state: 'page', libraryId: 102,
      kind: 'episode', offset: current, totalSize: 4,
      keys: current === 0 ? [500, 501] : [502, 503], complete: false }),
    readCard: async ({ ratingKey }) => ratingKey === 501 && failSecond
      ? { state: 'unavailable' } : card(ratingKey) });
  assert.deepEqual(await worker.tick(), { state: 'page_indexed', processed: 1,
    skipped: 1, nextOffset: 2 });
  assert.equal(offset, 2);
  failSecond = false;
  assert.deepEqual(await worker.tick(), { state: 'page_indexed', processed: 2,
    nextOffset: 0 });
  assert.equal(offset, 0);
  assert.deepEqual(await worker.tick(), { state: 'page_indexed', processed: 2,
    nextOffset: 2 });
  assert.equal(offset, 2);
});

test('one due retry rechecks its card without blocking the page cursor', async () => {
  const calls = [];
  const result = await retryOnePlexCard({ libraryId: 102, kind: 'episode',
    now: () => 60_010, readCard: async (input) => {
      calls.push(input); return card(500);
    }, index: { nextRetry: () => ({ ratingKey: 500 }),
      recordCard: () => ({ state: 'recorded_card' }),
      deferCard: () => ({ state: 'retry_deferred' }), clearRetry: () => {} } });
  assert.deepEqual(result, { state: 'retry_indexed', ratingKey: 500 });
  assert.deepEqual(calls, [{ libraryId: 102, ratingKey: 500,
    expectedType: 'episode' }]);
});
