import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { observePublicTarget } from '../src/availability/observe-public-target.mjs';

const target = { anidbId: 42, episodeId: 1001, kind: 'series' };
const shoko = { state: 'ok', complete: true, shokoEpisodeId: 555,
  shokoSeriesId: 99, files: [{ fileId: 51,
  anidbId: 42, episodeIds: [1001], coverage: [{ episodeId: 1001, start: 0, end: 100 }],
  sourcePaths: ['/pure/a.mkv'], size: 5 }] };
const localRoot = path.resolve('local');
const mounts = { shokoMount: { appRoot: '/pure', localRoot },
  plexMount: { appRoot: '/source-pure', localRoot } };
const part = { state: 'ok', complete: true, parts: [{ libraryId: 102,
  partId: 700, plexPath: '/source-pure/a.mkv', size: 5,
  cardType: 'episode', externalGuids: [],
  itemGuid: 'tv.plex.agents.custom.shoko://episode/e555',
  showGuid: 'tv.plex.agents.custom.shoko://show/99' }] };

test('joins one scoped public Plex card to an exact Shoko episode', async () => {
  const calls = [];
  const result = await observePublicTarget({ target, publicLibraryIds: [102],
    knownCards: [{ libraryId: 102, ratingKey: 600 }], ...mounts,
    readShoko: async (input) => { calls.push(['shoko', input]); return shoko; },
    readPlex: async (input) => { calls.push(['plex', input]); return part; },
    proveImpl: async () => ({ state: 'same_file', storageKey: '1:2:5' }) });
  assert.deepEqual(result, { state: 'available', fileId: 51,
    proof: { fileId: 51, libraryId: 102, ratingKey: 600,
      partId: 700, storageKey: '1:2:5' } });
  assert.deepEqual(calls, [['shoko', { anidbId: 42, episodeId: 1001 }],
    ['plex', { libraryId: 102, ratingKey: 600, expectedType: 'episode' }]]);
});

test('movie target can use a native episode card in the public Anime library', async () => {
  const result = await observePublicTarget({ target: { ...target, kind: 'movie' },
    publicLibraryIds: [102], knownCards: [
      { libraryId: 102, ratingKey: 600, kind: 'episode' },
      { libraryId: 102, ratingKey: 601, kind: 'episode' },
    ], ...mounts, readShoko: async () => shoko,
    readPlex: async ({ ratingKey, expectedType }) => {
      assert.equal(expectedType, 'episode');
      return ratingKey === 600 ? { state: 'not_found' } : part;
    }, proveImpl: async () => ({ state: 'same_file', storageKey: '1:2:5' }) });
  assert.deepEqual(result, { state: 'available', fileId: 51,
    proof: { fileId: 51, libraryId: 102, ratingKey: 601,
      partId: 700, storageKey: '1:2:5' } });
});

test('missing card, reader errors and incomplete inventory cannot claim absence', async () => {
  const base = { target, publicLibraryIds: [102], ...mounts,
    readShoko: async () => shoko, readPlex: async () => part,
    proveImpl: async () => ({ state: 'same_file', storageKey: '1:2:5' }) };
  assert.deepEqual(await observePublicTarget({ ...base, knownCards: [] }),
    { state: 'unknown', reason: 'card_discovery_incomplete' });
  assert.deepEqual(await observePublicTarget({ ...base,
    knownCards: [{ libraryId: 102, ratingKey: 600 }],
    readPlex: async () => { throw new Error('offline'); } }),
  { state: 'unknown', reason: 'observer_incomplete' });
  assert.deepEqual(await observePublicTarget({ ...base,
    knownCards: [{ libraryId: 102, ratingKey: 600 }],
    readShoko: async () => ({ state: 'not_imported' }) }),
  { state: 'unknown', reason: 'observer_incomplete' });
});

test('untrusted or unbounded card selection fails before any provider call', async () => {
  let calls = 0;
  const base = { target, publicLibraryIds: [102], ...mounts,
    readShoko: async () => { calls++; return shoko; },
    readPlex: async () => { calls++; return part; } };
  for (const knownCards of [
    [{ libraryId: 103, ratingKey: 600 }],
    [{ libraryId: 102, ratingKey: 600 }, { libraryId: 102, ratingKey: 600 }],
    Array.from({ length: 11 }, (_, index) => ({ libraryId: 102, ratingKey: index + 1 })),
  ]) {
    await assert.rejects(observePublicTarget({ ...base, knownCards }), TypeError);
  }
  assert.equal(calls, 0);
});
