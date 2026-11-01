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

test('physical identity avoids an overloaded size lookup but still requires fresh Plex proof', async () => {
  const queried = [];
  const result = await observeIndexedTarget({ ...base,
    readShoko: async () => shoko,
    probeImpl: async () => ({ state: 'candidate', candidateKey: '1:2:5' }),
    cardIndex: {
      lookupCards: () => { throw new Error('size lookup is overloaded'); },
      lookupCardsByCandidateKey(input) {
        queried.push(input);
        return { state: 'candidates', cards: [{ libraryId: 102, ratingKey: 500 }] };
      },
    },
  });
  assert.deepEqual(queried, [{ keys: ['1:2:5'], libraryIds: [102], kind: 'episode' }]);
  assert.deepEqual(result, { state: 'available', fileId: 51 });
});

test('keyed candidate is not Available when fresh physical proof disagrees', async () => {
  for (const reason of ['different_file', 'file_unavailable']) {
    const result = await observeIndexedTarget({ ...base,
      readShoko: async () => shoko,
      probeImpl: async () => ({ state: 'candidate', candidateKey: '1:2:5' }),
      proveImpl: async () => ({ state: 'held', reason }),
      cardIndex: {
        lookupCards: () => { throw new Error('size lookup is overloaded'); },
        lookupCardsByCandidateKey: () => ({ state: 'candidates', cards: [
          { libraryId: 102, ratingKey: 500 }] }),
      },
    });
    assert.equal(result.state, 'unknown');
  }
});

test('a stale keyed card does not hide a second exact playable copy indexed by size', async () => {
  const checked = [];
  const goodPart = (await base.readPlex()).parts[0];
  const result = await observeIndexedTarget({ ...base,
    readShoko: async () => shoko,
    probeImpl: async () => ({ state: 'candidate', candidateKey: '1:2:5' }),
    readPlex: async ({ ratingKey }) => {
      checked.push(ratingKey);
      return { state: 'ok', complete: true, parts: [ratingKey === 500
        ? { ...goodPart, itemGuid: 'wrong-show' } : goodPart] };
    },
    cardIndex: {
      lookupCardsByCandidateKey: () => ({ state: 'candidates', cards: [
        { libraryId: 102, ratingKey: 500 }] }),
      lookupCards: () => ({ state: 'candidates', cards: [
        { libraryId: 102, ratingKey: 500 },
        { libraryId: 102, ratingKey: 501 }] }),
    },
  });
  assert.deepEqual(result, { state: 'available', fileId: 51 });
  assert.deepEqual(checked, [500, 501]);
});

test('size fallback never exceeds the ten-card fresh-read budget', async () => {
  const keyedCards = Array.from({ length: 9 }, (_, index) => ({
    libraryId: 102, ratingKey: 500 + index }));
  let reads = 0;
  const wrongPart = { ...(await base.readPlex()).parts[0], itemGuid: 'wrong-show' };
  const result = await observeIndexedTarget({ ...base,
    readShoko: async () => shoko,
    probeImpl: async () => ({ state: 'candidate', candidateKey: '1:2:5' }),
    readPlex: async () => { reads++; return { state: 'ok', complete: true,
      parts: [wrongPart] }; },
    cardIndex: {
      lookupCardsByCandidateKey: () => ({ state: 'candidates', cards: keyedCards }),
      lookupCards: () => ({ state: 'candidates', cards: [
        { libraryId: 102, ratingKey: 509 },
        { libraryId: 102, ratingKey: 510 }] }),
    },
  });
  assert.equal(result.state, 'unknown');
  assert.equal(reads, 9);
});

test('a keyed Plex outage does not trigger a second wave of card reads', async () => {
  let fallbackLookups = 0;
  const result = await observeIndexedTarget({ ...base,
    readShoko: async () => shoko,
    probeImpl: async () => ({ state: 'candidate', candidateKey: '1:2:5' }),
    readPlex: async () => ({ state: 'unavailable' }),
    cardIndex: {
      lookupCardsByCandidateKey: () => ({ state: 'candidates', cards: [
        { libraryId: 102, ratingKey: 500 }] }),
      lookupCards: () => { fallbackLookups++; return { state: 'candidates',
        cards: [{ libraryId: 102, ratingKey: 501 }] }; },
    },
  });
  assert.deepEqual(result, { state: 'unknown', reason: 'observer_incomplete' });
  assert.equal(fallbackLookups, 0);
});

test('stale key, missing mount and overloaded fallback cannot imply availability', async () => {
  const keyed = { lookupCards: () => ({ state: 'held',
    reason: 'candidate_budget_exceeded' }),
  lookupCardsByCandidateKey: () => ({ state: 'candidates', cards: [
    { libraryId: 102, ratingKey: 500 }] }) };
  const stale = await observeIndexedTarget({ ...base,
    readShoko: async () => shoko,
    probeImpl: async () => ({ state: 'candidate', candidateKey: '1:2:5' }),
    readPlex: async () => ({ state: 'ok', complete: true, parts: [
      { ...((await base.readPlex()).parts[0]), itemGuid: 'wrong-show' }] }),
    cardIndex: keyed });
  assert.equal(stale.state, 'unknown');
  const unavailable = await observeIndexedTarget({ ...base,
    readShoko: async () => shoko,
    probeImpl: async () => ({ state: 'held', reason: 'file_unavailable' }),
    cardIndex: keyed });
  assert.deepEqual(unavailable, { state: 'unknown',
    reason: 'card_discovery_incomplete' });
  const missingMount = await observeIndexedTarget({ ...base,
    shokoMount: undefined, readShoko: async () => shoko,
    cardIndex: keyed });
  assert.equal(missingMount.state, 'unknown');
  const collision = await observeIndexedTarget({ ...base,
    readShoko: async () => shoko,
    probeImpl: async () => ({ state: 'candidate', candidateKey: '1:2:5' }),
    cardIndex: { ...keyed, lookupCardsByCandidateKey: () => ({ state: 'held',
      reason: 'candidate_budget_exceeded' }) } });
  assert.equal(collision.state, 'unknown');
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

test('a definitively missing Plex card is removed from the candidate index', async () => {
  const forgotten = [];
  const result = await observeIndexedTarget({ ...base,
    now: () => 1234, readShoko: async () => shoko,
    readPlex: async () => ({ state: 'not_found' }),
    cardIndex: {
      lookupCards: () => ({ state: 'candidates', cards: [
        { libraryId: 102, ratingKey: 500 }] }),
      forgetCard: (input) => forgotten.push(input),
    },
  });
  assert.equal(result.state, 'unknown');
  assert.deepEqual(forgotten, [{ libraryId: 102, ratingKey: 500,
    observedMs: 1234 }]);
});

test('a transient Plex card error does not remove an indexed candidate', async () => {
  const forgotten = [];
  await observeIndexedTarget({ ...base, readShoko: async () => shoko,
    readPlex: async () => ({ state: 'unavailable' }),
    cardIndex: {
      lookupCards: () => ({ state: 'candidates', cards: [
        { libraryId: 102, ratingKey: 500 }] }),
      forgetCard: (input) => forgotten.push(input),
    },
  });
  assert.deepEqual(forgotten, []);
});
