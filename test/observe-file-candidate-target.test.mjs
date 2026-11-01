import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { observeFileCandidateTarget } from
  '../src/availability/observe-file-candidate-target.mjs';

const candidate = { state: 'candidate', fileId: 51, size: 5,
  anidbFileId: 800, releaseEvidence: 'registered',
  pairs: [{ anidbId: 42, episodeId: 1001 },
    { anidbId: 42, episodeId: 1002 }],
  identities: [
    { anidbId: 42, episodeId: 1001, shokoSeriesId: 99,
      shokoEpisodeId: 555, tmdbMovieIds: [] },
    { anidbId: 42, episodeId: 1002, shokoSeriesId: 99,
      shokoEpisodeId: 556, tmdbMovieIds: [8001] },
  ], sourcePaths: ['/pure/a.mkv'] };
const localRoot = path.resolve('local');
const base = { candidate, publicLibraryIds: [102],
  shokoMount: { appRoot: '/pure', localRoot },
  plexMount: { appRoot: '/source-pure', localRoot },
  probeImpl: async () => ({ state: 'candidate', candidateKey: '1:2:5' }),
  proveImpl: async () => ({ state: 'same_file', storageKey: '1:2:5' }),
  cardIndex: {
    lookupCardsByCandidateKey: () => ({ state: 'candidates', cards: [
      { libraryId: 102, ratingKey: 500 },
      { libraryId: 102, ratingKey: 501 }] }),
    lookupCards: () => { throw Error('physical index should be sufficient'); },
  },
  readPlex: async ({ libraryId, ratingKey }) => ({ state: 'ok', complete: true,
    parts: [{ partId: ratingKey + 100, libraryId, size: 5,
      plexPath: '/source-pure/a.mkv', cardType: 'episode',
      itemGuid: `tv.plex.agents.custom.shoko://episode/e${ratingKey + 55}`,
      showGuid: 'tv.plex.agents.custom.shoko://show/99' }] }),
};

test('one Shoko file candidate can prove two distinct exact public episode cards', async () => {
  for (const [episodeId, ratingKey] of [[1001, 500], [1002, 501]]) {
    const result = await observeFileCandidateTarget({ ...base,
      target: { anidbId: 42, episodeId, kind: 'series' } });
    assert.deepEqual(result, { state: 'available', fileId: 51,
      proof: { fileId: 51, libraryId: 102, ratingKey,
        partId: ratingKey + 100 } });
  }
});

test('a movie can be proven by its exact public Plex Movie card', async () => {
  const result = await observeFileCandidateTarget({ ...base,
    target: { anidbId: 42, episodeId: 1002, kind: 'movie' },
    publicLibraryIds: [123],
    cardIndex: {
      lookupCardsByCandidateKey: ({ kind }) => ({ state: 'candidates',
        cards: kind === 'movie' ? [{ libraryId: 123, ratingKey: 700 }] : [] }),
      lookupCards: ({ kind }) => ({ state: 'candidates',
        cards: kind === 'movie' ? [{ libraryId: 123, ratingKey: 700 }] : [] }),
    },
    readPlex: async () => ({ state: 'ok', complete: true, parts: [{
      partId: 800, libraryId: 123, size: 5,
      plexPath: '/source-pure/a.mkv', cardType: 'movie',
      itemGuid: 'tmdb://8001', externalGuids: [] }] }),
  });
  assert.equal(result.state, 'available');
  assert.deepEqual(result.proof, { fileId: 51, libraryId: 123,
    ratingKey: 700, partId: 800 });
});

test('unlinked episode, missing Shoko IDs, and wrong Plex GUID cannot publish Available', async () => {
  let plexReads = 0;
  assert.deepEqual(await observeFileCandidateTarget({ ...base,
    target: { anidbId: 42, episodeId: 1003, kind: 'series' },
    readPlex: async () => { plexReads++; throw Error('not called'); } }),
  { state: 'unknown', reason: 'file_identity_unverified' });
  assert.equal(plexReads, 0);
  assert.deepEqual(await observeFileCandidateTarget({ ...base,
    target: { anidbId: 42, episodeId: 1001, kind: 'series' },
    candidate: { ...candidate, identities: [{ ...candidate.identities[0],
      shokoEpisodeId: null }, candidate.identities[1]] },
    readPlex: async () => { plexReads++; throw Error('not called'); } }),
  { state: 'unknown', reason: 'file_identity_unverified' });
  assert.equal(plexReads, 0);
  const wrong = await observeFileCandidateTarget({ ...base,
    target: { anidbId: 42, episodeId: 1001, kind: 'series' },
    cardIndex: { ...base.cardIndex, lookupCards: () => ({ state: 'candidates',
      cards: [] }) },
    readPlex: async (input) => ({ ...await base.readPlex(input),
      parts: [{ ...(await base.readPlex(input)).parts[0], itemGuid: 'wrong-show' }] }),
  });
  assert.equal(wrong.state, 'unknown');
});

test('malformed file candidate entries fail closed before any Plex read', async () => {
  let reads = 0;
  for (const changed of [
    { ...candidate, pairs: [null, candidate.pairs[1]] },
    { ...candidate, identities: [null, candidate.identities[1]] },
    { ...candidate, pairs: [candidate.pairs[0], candidate.pairs[0]] },
  ]) {
    assert.deepEqual(await observeFileCandidateTarget({ ...base,
      target: { anidbId: 42, episodeId: 1001, kind: 'series' },
      candidate: changed,
      readPlex: async () => { reads++; throw Error('not called'); } }),
    { state: 'unknown', reason: 'file_identity_unverified' });
  }
  assert.equal(reads, 0);
});
