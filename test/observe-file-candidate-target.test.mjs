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

test('an offline Shoko link needs the same exact public Plex file and episode card', async () => {
  const offline = { ...candidate, anidbFileId: null,
    releaseEvidence: 'shoko_offline_link',
    pairs: [candidate.pairs[0]], identities: [candidate.identities[0]] };
  const input = { ...base, candidate: offline,
    target: { anidbId: 42, episodeId: 1001, kind: 'series' } };
  assert.equal((await observeFileCandidateTarget(input)).state, 'available');
  assert.notEqual((await observeFileCandidateTarget({ ...input,
    proveImpl: async () => ({ state: 'held', reason: 'different_file' }) })).state,
  'available');
  assert.notEqual((await observeFileCandidateTarget({ ...input,
    readPlex: async () => ({ state: 'ok', complete: true, parts: [{
      partId: 600, libraryId: 102, size: 5, plexPath: '/source-pure/a.mkv',
      cardType: 'episode', itemGuid: 'tv.plex.agents.custom.shoko://episode/e999',
      showGuid: 'tv.plex.agents.custom.shoko://show/99',
    }] }) })).state, 'available');
});

test('one fully linked file playable on a sibling episode card proves both episodes', async () => {
  const result = await observeFileCandidateTarget({ ...base,
    target: { anidbId: 42, episodeId: 1002, kind: 'series' },
    cardIndex: { ...base.cardIndex,
      lookupCardsByCandidateKey: () => ({ state: 'candidates', cards: [
        { libraryId: 102, ratingKey: 500 }] }),
      lookupCards: () => ({ state: 'candidates', cards: [] }) },
  });
  assert.deepEqual(result, { state: 'available', fileId: 51,
    proof: { fileId: 51, libraryId: 102, ratingKey: 500,
      partId: 600, storageKey: '1:2:5',
      presentation: 'alternate_card' } });
});

test('one registered episode playable on another episode card of its show has alternate-card proof', async () => {
  const single = { ...candidate, pairs: [candidate.pairs[0]],
    identities: [candidate.identities[0]] };
  const result = await observeFileCandidateTarget({ ...base, candidate: single,
    target: { anidbId: 42, episodeId: 1001, kind: 'series' },
    cardIndex: { ...base.cardIndex,
      lookupCardsByCandidateKey: () => ({ state: 'candidates', cards: [
        { libraryId: 102, ratingKey: 500 }] }),
      lookupCards: () => ({ state: 'candidates', cards: [] }) },
    readPlex: async () => ({ state: 'ok', complete: true, parts: [{
      partId: 600, libraryId: 102, size: 5,
      plexPath: '/source-pure/a.mkv', cardType: 'episode',
      itemGuid: 'tv.plex.agents.custom.shoko://episode/e777',
      showGuid: 'tv.plex.agents.custom.shoko://show/99' }] }) });
  assert.deepEqual(result, { state: 'available', fileId: 51,
    proof: { fileId: 51, libraryId: 102, ratingKey: 500,
      partId: 600, storageKey: '1:2:5', presentation: 'alternate_card' } });
});

test('a registered episode on its Shoko segment card has exact alternate-card proof', async () => {
  const single = { ...candidate, pairs: [candidate.pairs[0]],
    identities: [candidate.identities[0]] };
  const target = { anidbId: 42, episodeId: 1001, kind: 'series' };
  const cardIndex = { ...base.cardIndex,
    lookupCardsByCandidateKey: () => ({ state: 'candidates', cards: [
      { libraryId: 102, ratingKey: 500 }] }),
    lookupCards: () => ({ state: 'candidates', cards: [] }) };
  const part = { partId: 600, libraryId: 102, size: 5,
    plexPath: '/source-pure/a.mkv', cardType: 'episode',
    itemGuid: 'tv.plex.agents.custom.shoko://episode/e555p2',
    showGuid: 'tv.plex.agents.custom.shoko://show/99' };
  const input = { ...base, candidate: single, target, cardIndex,
    readPlex: async () => ({ state: 'ok', complete: true, parts: [part] }) };
  assert.deepEqual(await observeFileCandidateTarget(input), {
    state: 'available', fileId: 51,
    proof: { fileId: 51, libraryId: 102, ratingKey: 500,
      partId: 600, storageKey: '1:2:5', presentation: 'alternate_card' },
  });
  for (const changed of [
    { itemGuid: 'tv.plex.agents.custom.shoko://episode/e555p0' },
    { itemGuid: 'tv.plex.agents.custom.shoko://episode/e555p2junk' },
    { itemGuid: 'tv.plex.agents.custom.shoko://episode/e556p2' },
    { showGuid: 'tv.plex.agents.custom.shoko://show/100' },
  ]) {
    const result = await observeFileCandidateTarget({ ...input,
      readPlex: async () => ({ state: 'ok', complete: true,
        parts: [{ ...part, ...changed }] }) });
    assert.notEqual(result.state, 'available');
  }
  const userLinked = await observeFileCandidateTarget({ ...input,
    candidate: { ...single, anidbFileId: null,
      releaseEvidence: 'shoko_user_link' } });
  assert.notEqual(userLinked.state, 'available');
  const wrongFile = await observeFileCandidateTarget({ ...input,
    proveImpl: async () => ({ state: 'held', reason: 'different_file' }) });
  assert.notEqual(wrongFile.state, 'available');
});

test('a registered AniDB movie file can prove a second linked entry on its public Anime card', async () => {
  const target = { anidbId: 42, episodeId: 1001, kind: 'movie' };
  const cardIndex = { ...base.cardIndex,
    lookupCardsByCandidateKey: ({ kind }) => ({ state: 'candidates',
      cards: kind === 'episode' ? [{ libraryId: 102, ratingKey: 501 }] : [] }),
    lookupCards: () => ({ state: 'candidates', cards: [] }) };
  const input = { ...base, target, cardIndex };
  assert.deepEqual(await observeFileCandidateTarget(input), {
    state: 'available', fileId: 51,
    proof: { fileId: 51, libraryId: 102, ratingKey: 501,
      partId: 601, storageKey: '1:2:5', presentation: 'alternate_card' },
  });
  const userLinked = await observeFileCandidateTarget({ ...input,
    candidate: { ...candidate, anidbFileId: null,
      releaseEvidence: 'shoko_user_link' } });
  assert.notEqual(userLinked.state, 'available');
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

test('alternate-card proof rejects a wrong show and different file', async () => {
  const target = { anidbId: 42, episodeId: 1002, kind: 'series' };
  const cardIndex = { ...base.cardIndex,
    lookupCardsByCandidateKey: () => ({ state: 'candidates', cards: [
      { libraryId: 102, ratingKey: 500 }] }),
    lookupCards: () => ({ state: 'candidates', cards: [] }) };
  const sibling = (await base.readPlex({ libraryId: 102, ratingKey: 500 })).parts[0];
  for (const changed of [
    { showGuid: 'tv.plex.agents.custom.shoko://show/100' },
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
