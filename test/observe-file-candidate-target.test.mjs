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
      cardIndex: { ...base.cardIndex,
        getCardRevision: () => ({ observedMs: 100,
          identitySignature: `card-${ratingKey}` }) },
      target: { anidbId: 42, episodeId, kind: 'series' } });
    assert.deepEqual(result, { state: 'available', fileId: 51,
      proof: { fileId: 51, libraryId: 102, ratingKey,
        partId: ratingKey + 100, storageKey: '1:2:5' },
      cardRevision: { observedMs: 100,
        identitySignature: `card-${ratingKey}` } });
  }
});

test('one fully linked file playable on a sibling episode card proves both episodes', async () => {
  const result = await observeFileCandidateTarget({ ...base,
    target: { anidbId: 42, episodeId: 1002, kind: 'series' },
    cardIndex: { ...base.cardIndex,
      lookupCardsByCandidateKey: () => ({ state: 'candidates', cards: [
        { libraryId: 102, ratingKey: 500 }] }) },
  });
  assert.deepEqual(result, { state: 'available', fileId: 51,
    proof: { fileId: 51, libraryId: 102, ratingKey: 500,
      partId: 600, storageKey: '1:2:5',
      presentation: 'alternate_card' } });
});

test('a Plex local episode card in the exact Shoko show can prove the same registered file', async () => {
  const result = await observeFileCandidateTarget({ ...base,
    target: { anidbId: 42, episodeId: 1001, kind: 'series' },
    cardIndex: { ...base.cardIndex,
      lookupCardsByCandidateKey: () => ({ state: 'candidates', cards: [
        { libraryId: 102, ratingKey: 500 }] }),
      lookupCards: () => ({ state: 'candidates', cards: [] }) },
    readPlex: async () => ({ state: 'ok', complete: true, parts: [{
      partId: 600, libraryId: 102, size: 5,
      plexPath: '/source-pure/a.mkv', cardType: 'episode',
      itemGuid: 'local://500',
      showGuid: 'tv.plex.agents.custom.shoko://show/99' }] }) });
  assert.deepEqual(result, { state: 'available', fileId: 51,
    proof: { fileId: 51, libraryId: 102, ratingKey: 500,
      partId: 600, storageKey: '1:2:5', presentation: 'alternate_card' } });
});

test('local-card fallback still rejects the wrong show, wrong local ID and different file', async () => {
  const readPlex = async ({ ratingKey }) => ({ state: 'ok', complete: true,
    parts: [{ partId: 600, libraryId: 102, size: 5,
      plexPath: '/source-pure/a.mkv', cardType: 'episode',
      itemGuid: `local://${ratingKey}`,
      showGuid: 'tv.plex.agents.custom.shoko://show/99' }] });
  const input = { ...base, target: { anidbId: 42, episodeId: 1001,
    kind: 'series' }, readPlex,
    cardIndex: { ...base.cardIndex,
      lookupCardsByCandidateKey: () => ({ state: 'candidates', cards: [
        { libraryId: 102, ratingKey: 500 }] }),
      lookupCards: () => ({ state: 'candidates', cards: [] }) } };
  for (const change of [
    { itemGuid: 'local://501' },
    { showGuid: 'tv.plex.agents.custom.shoko://show/100' },
    { externalGuids: ['tv.plex.agents.custom.shoko://episode/e999'] },
  ]) {
    const outcome = await observeFileCandidateTarget({ ...input,
      readPlex: async (query) => {
        const card = await readPlex(query);
        return { ...card, parts: [{ ...card.parts[0], ...change }] };
      } });
    assert.notEqual(outcome.state, 'available');
  }
  const wrongFile = await observeFileCandidateTarget({ ...input,
    proveImpl: async () => ({ state: 'held', reason: 'different_file' }) });
  assert.notEqual(wrongFile.state, 'available');
});

test('sibling-card proof rejects a wrong show, unrelated episode and different file', async () => {
  const target = { anidbId: 42, episodeId: 1002, kind: 'series' };
  const cardIndex = { ...base.cardIndex,
    lookupCardsByCandidateKey: () => ({ state: 'candidates', cards: [
      { libraryId: 102, ratingKey: 500 }] }),
    lookupCards: () => ({ state: 'candidates', cards: [] }) };
  const sibling = (await base.readPlex({ libraryId: 102, ratingKey: 500 })).parts[0];
  for (const changed of [
    { showGuid: 'tv.plex.agents.custom.shoko://show/100' },
    { itemGuid: 'tv.plex.agents.custom.shoko://episode/e777' },
  ]) {
    const result = await observeFileCandidateTarget({ ...base, target, cardIndex,
      readPlex: async () => ({ state: 'ok', complete: true,
        parts: [{ ...sibling, ...changed }] }) });
    assert.notEqual(result.state, 'available');
  }
  const wrongFile = await observeFileCandidateTarget({ ...base,
    target, cardIndex,
    proveImpl: async () => ({ state: 'unknown', reason: 'different_file' }) });
  assert.notEqual(wrongFile.state, 'available');
});

test('an AniDB-flagged existing file needs the same exact public card and file proof', async () => {
  const result = await observeFileCandidateTarget({ ...base,
    candidate: { ...candidate, releaseEvidence: 'anidb_flagged' },
    target: { anidbId: 42, episodeId: 1001, kind: 'series' } });
  assert.equal(result.state, 'available');
  assert.deepEqual(await observeFileCandidateTarget({ ...base,
    candidate: { ...candidate, anidbFileId: null,
      releaseEvidence: 'anidb_flagged' },
    target: { anidbId: 42, episodeId: 1001, kind: 'series' } }),
  { state: 'unknown', reason: 'file_identity_unverified' });
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
    ratingKey: 700, partId: 800, storageKey: '1:2:5' });
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
