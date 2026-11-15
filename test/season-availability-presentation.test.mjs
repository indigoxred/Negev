import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeSeasonAvailability, summarizeFilmAvailability,
  installmentRequestState, filmEntryRequestState, titleAvailabilitySummary } from
  '../src/web/public/season-availability-presentation.mjs';

test('a verified Special does not become a regular episode or main film claim', () => {
  const episodes = [{ type: 'Special', availability: 'available' }];
  assert.deepEqual(titleAvailabilitySummary({ kind: 'series', episodes,
    nextPage: 2, verifiedTitleItems: 1 }), {
    text: 'Availability unconfirmed · Some items for this title are verified playable in Plex, but regular-season availability is not confirmed yet; Specials are separate.',
    available: false, state: 'unverified' });
  assert.deepEqual(titleAvailabilitySummary({ kind: 'movie', episodes,
    nextPage: 2, verifiedTitleItems: 1 }), {
    text: 'Availability unconfirmed · Some items for this title are verified playable in Plex, but a main film entry is not confirmed on this page.',
    available: false, state: 'unverified' });
});

test('title headline keeps exact regular-season and main-film proof', () => {
  assert.deepEqual(titleAvailabilitySummary({ kind: 'series',
    episodes: [{ type: 'Episode', availability: 'available' }],
    nextPage: 2, regularSeason: { verified: 9, total: 12 },
    verifiedTitleItems: 10 }), {
    text: 'Partially available · 9 of 12 regular episodes verified playable in Plex. 3 episodes remain unverified. Specials are separate.',
    available: true, state: 'partial' });
  assert.deepEqual(titleAvailabilitySummary({ kind: 'movie',
    episodes: [{ type: 'Episode', availability: 'available' },
      { type: 'Special', availability: 'available' }],
    nextPage: null, verifiedTitleItems: 2 }), {
    text: 'Already available · 1 verified main film entry playable in Plex. Other editions and extras are separate.',
    available: true, state: 'available' });
});

test('an airing season distinguishes aired availability from scheduled entries', () => {
  assert.deepEqual(titleAvailabilitySummary({ kind: 'series', episodes: [],
    nextPage: null, regularSeason: { verified: 40, total: 44 },
    regularSchedule: { aired: 40, upcoming: 4, undated: 0, verifiedAired: 40, total: 44,
      asOf: '2026-11-13' } }), {
    text: 'Available so far · 40 of 40 aired regular episodes verified playable in Plex. 4 upcoming episodes are scheduled; they are not missing downloads. Specials are separate.',
    available: true, state: 'available' });
});

test('series and films use the same clear available and unverified vocabulary', () => {
  const full = titleAvailabilitySummary({ kind: 'series', episodes: [], nextPage: 2,
    regularSeason: { verified: 12, total: 12 } });
  assert.match(full.text, /^Already available ·/);
  assert.equal(full.state, 'available');
  const unverifiedSeries = titleAvailabilitySummary({ kind: 'series', episodes: [],
    nextPage: 2, regularSeason: { verified: 0, total: 12 } });
  assert.match(unverifiedSeries.text, /^Availability unconfirmed ·/);
  assert.equal(unverifiedSeries.state, 'unverified');
  const unverifiedFilm = titleAvailabilitySummary({ kind: 'movie', episodes: [
    { type: 'Episode', availability: 'unknown' }], nextPage: null });
  assert.match(unverifiedFilm.text, /^Availability unconfirmed ·/);
  assert.equal(unverifiedFilm.state, 'unverified');
  const airing = titleAvailabilitySummary({ kind: 'series', episodes: [],
    nextPage: null, monitorFuture: true, regularSeason: { verified: 6, total: 6 } });
  assert.match(airing.text, /^Available so far ·/);
  assert.equal(airing.state, 'available');
});

test('undated older entries do not claim that zero episodes aired', () => {
  const result = titleAvailabilitySummary({ kind: 'series', episodes: [],
    nextPage: null, regularSeason: { verified: 12, total: 12 },
    regularSchedule: { aired: 0, upcoming: 0, undated: 12,
      verifiedAired: 0, total: 12, asOf: '2026-11-13' } });
  assert.match(result.text, /12 of 12 listed regular episodes verified playable/);
  assert.doesNotMatch(result.text, /0 of 0 aired/);
});

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
