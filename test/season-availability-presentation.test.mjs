import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeSeasonAvailability, summarizeFilmAvailability,
  installmentRequestState, filmEntryRequestState } from
  '../src/web/public/season-availability-presentation.mjs';

test('season summary counts regular episodes, not trailers or Specials', () => {
  assert.deepEqual(summarizeSeasonAvailability({ kind: 'series',
    nextPage: null, episodes: [
      { type: 'Episode', availability: 'available' },
      { type: 'Episode', availability: 'unknown' },
      { type: 'Trailer', availability: 'available' },
      { type: 'Special', availability: 'available' },
    ] }), { verified: 1, total: 2, completeList: true });
});

test('a paged season does not claim the page is the whole season', () => {
  assert.deepEqual(summarizeSeasonAvailability({ kind: 'series',
    nextPage: 2, episodes: [{ type: 'Episode', availability: 'available' }] }),
  { verified: 1, total: 1, completeList: false });
});

test('a film is available from a verified main entry without counting extras', () => {
  assert.deepEqual(summarizeFilmAvailability({ kind: 'movie', nextPage: null,
    episodes: [
      { type: 'Episode', availability: 'available' },
      { type: 'Episode', availability: 'unknown' },
      { type: 'Trailer', availability: 'available' },
      { type: 'Special', availability: 'available' },
    ] }), { verified: 1, total: 2, completeList: true, available: true });
});

test('verified complete installments are not offered as new requests', () => {
  assert.equal(installmentRequestState({ kind: 'series', nextPage: null,
    episodes: [{ type: 'Episode', availability: 'available' },
      { type: 'Special', availability: 'unknown' }] }), 'already_available');
  assert.equal(installmentRequestState({ kind: 'series', nextPage: null,
    monitorFuture: true,
    episodes: [{ type: 'Episode', availability: 'available' }] }), 'requestable',
  'an airing installment can still watch for future episodes');
  assert.equal(installmentRequestState({ kind: 'movie', nextPage: null,
    episodes: [{ type: 'Episode', availability: 'available' }] }), 'already_available');
  assert.equal(installmentRequestState({ kind: 'series', nextPage: 2,
    episodes: [{ type: 'Episode', availability: 'available' }] }), 'requestable');
  assert.equal(installmentRequestState({ kind: 'series', nextPage: 2,
    regularSeason: { verified: 10, total: 10 },
    episodes: [{ type: 'Episode', availability: 'available' }] }), 'already_available',
  'complete cached regular-season proof must close a multi-page request immediately');
  assert.equal(installmentRequestState({ kind: 'series', nextPage: 2,
    regularSeason: { verified: 9, total: 10 },
    episodes: [{ type: 'Episode', availability: 'available' }] }), 'requestable');
  assert.equal(installmentRequestState({ kind: 'series', nextPage: 2,
    monitorFuture: true, regularSeason: { verified: 10, total: 10 },
    episodes: [{ type: 'Episode', availability: 'available' }] }), 'requestable');
  assert.equal(installmentRequestState({ kind: 'series', nextPage: null,
    episodes: [{ type: 'Episode', availability: 'unknown' }] }), 'requestable');
});

test('a newly verified film entry closes the alternate-entry request action', () => {
  const episodes = [
    { id: 71, type: 'Episode', availability: 'unknown' },
    { id: 72, type: 'Episode', availability: 'unknown' },
  ];
  const input = { episodes, nextPage: null, selectedId: 72 };
  assert.equal(filmEntryRequestState(input), 'requestable');
  episodes[0].availability = 'available';
  assert.equal(filmEntryRequestState(input), 'already_available');
  episodes[0].availability = 'unknown';
  episodes[1].availability = 'available';
  assert.equal(filmEntryRequestState(input), 'already_available');
});
