import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { observeIndexedTarget } from '../src/availability/observe-indexed-target.mjs';

const target = { anidbId: 42, episodeId: 1001, kind: 'series' };
const shoko = { state: 'ok', complete: true, shokoEpisodeId: 555,
  shokoSeriesId: 99, files: [{ fileId: 51,
  anidbId: 42, episodeIds: [1001], coverage: [{ episodeId: 1001, start: 0, end: 100 }],
  sourcePaths: ['/pure/a.mkv'], size: 5 }] };
const localRoot = path.resolve('local');
const base = { target, publicLibraryIds: [102],
  shokoMount: { appRoot: '/pure', localRoot },
  plexMount: { appRoot: '/source-pure', localRoot },
  readPlex: async () => ({ state: 'ok', complete: true,
    parts: [{ partId: 9, libraryId: 102, plexPath: '/source-pure/a.mkv',
      size: 5, cardType: 'episode', externalGuids: [],
      itemGuid: 'tv.plex.agents.custom.shoko://episode/e555',
      showGuid: 'tv.plex.agents.custom.shoko://show/99' }] }),
  proveImpl: async () => ({ state: 'same_file', storageKey: '1:2:5' }) };

test('one fresh Shoko read selects indexed same-size cards and proves public playback', async () => {
  let shokoReads = 0;
  const result = await observeIndexedTarget({ ...base,
    readShoko: async () => { shokoReads++; return shoko; },
    cardIndex: { lookupCards(input) {
      assert.deepEqual(input, { sizes: [5], libraryIds: [102], kind: 'episode' });
      return { state: 'candidates', cards: [{ libraryId: 102, ratingKey: 500 }] };
    } } });
  assert.deepEqual(result, { state: 'available', fileId: 51 });
  assert.equal(shokoReads, 1);
});

test('movie target also checks native Anime episode candidates', async () => {
  const queried = [];
  const result = await observeIndexedTarget({ ...base,
    target: { ...target, kind: 'movie' }, readShoko: async () => shoko,
    cardIndex: { lookupCards(input) {
      queried.push(input.kind);
      return { state: 'candidates', cards: input.kind === 'episode'
        ? [{ libraryId: 102, ratingKey: 500 }] : [] };
    } } });
  assert.deepEqual(queried, ['episode', 'movie']);
  assert.deepEqual(result, { state: 'available', fileId: 51 });
});

test('empty, incomplete or overloaded index remains Unknown', async () => {
  for (const lookup of [
    () => ({ state: 'candidates', cards: [] }),
    () => ({ state: 'held', reason: 'candidate_budget_exceeded' }),
    () => { throw new Error('database unavailable'); },
  ]) {
    assert.equal((await observeIndexedTarget({ ...base,
      readShoko: async () => shoko,
      cardIndex: { lookupCards: lookup } })).state, 'unknown');
  }
  assert.deepEqual(await observeIndexedTarget({ ...base,
    readShoko: async () => ({ state: 'not_imported' }),
    cardIndex: { lookupCards: () => { throw new Error('should not read'); } } }),
  { state: 'unknown', reason: 'observer_incomplete' });
});
