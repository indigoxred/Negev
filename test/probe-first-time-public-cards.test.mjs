import assert from 'node:assert/strict';
import test from 'node:test';
import { probeFirstTimePublicCards } from
  '../src/availability/probe-first-time-public-cards.mjs';

test('series queries exact episode GUID in each public Anime section and remains uncertain when empty', async () => {
  const calls = [];
  const result = await probeFirstTimePublicCards({
    kind: 'series', episodeIds: [101, 102],
    publicSections: { episode: [102, 103], movie: [123] },
    readGuidCards: async (input) => {
      calls.push(input);
      return { state: 'cards', complete: true, cards: [] };
    },
  });
  assert.deepEqual(calls, [
    { libraryId: 102, kind: 'episode', guid: 'tv.plex.agents.custom.shoko://episode/e101' },
    { libraryId: 103, kind: 'episode', guid: 'tv.plex.agents.custom.shoko://episode/e101' },
    { libraryId: 102, kind: 'episode', guid: 'tv.plex.agents.custom.shoko://episode/e102' },
    { libraryId: 103, kind: 'episode', guid: 'tv.plex.agents.custom.shoko://episode/e102' },
  ]);
  assert.deepEqual(result, { state: 'healthy_unconfirmed',
    libraryIds: [102, 103], parts: [], complete: false });
});

test('movie checks episode and movie sections, and any observed card blocks acquisition', async () => {
  const calls = [];
  const result = await probeFirstTimePublicCards({
    kind: 'movie', episodeIds: [201], tmdbMovieIds: [9001],
    publicSections: { episode: [102], movie: [123] },
    readGuidCards: async (input) => {
      calls.push(input);
      return { state: 'cards', complete: true,
        cards: input.kind === 'movie' ? [{ libraryId: 123, ratingKey: 44, kind: 'movie' }] : [] };
    },
  });
  assert.deepEqual(calls, [
    { libraryId: 102, kind: 'episode', guid: 'tv.plex.agents.custom.shoko://episode/e201' },
    { libraryId: 123, kind: 'movie', guid: 'tmdb://9001' },
  ]);
  assert.deepEqual(result, { state: 'held', reason: 'public_card_observed' });
});

test('a failed, incomplete, unscoped or oversized probe cannot authorize uncertainty', async () => {
  const input = { kind: 'movie', episodeIds: [201],
    publicSections: { episode: [102], movie: [123] },
    readGuidCards: async () => ({ state: 'cards', complete: true, cards: [] }) };
  assert.deepEqual(await probeFirstTimePublicCards(input),
    { state: 'held', reason: 'movie_identity_unverified' });
  assert.deepEqual(await probeFirstTimePublicCards({ ...input, tmdbMovieIds: [9001],
    readGuidCards: async () => ({ state: 'unavailable' }) }),
    { state: 'held', reason: 'public_probe_unavailable' });
  assert.deepEqual(await probeFirstTimePublicCards({ ...input, tmdbMovieIds: [9001],
    readGuidCards: async () => ({ state: 'cards', complete: false, cards: [] }) }),
    { state: 'held', reason: 'public_probe_unavailable' });
  await assert.rejects(probeFirstTimePublicCards({ ...input,
    publicSections: { episode: [], movie: [] } }), TypeError);
  await assert.rejects(probeFirstTimePublicCards({ ...input,
    episodeIds: Array.from({ length: 21 }, (_, i) => i + 1) }), TypeError);
});
