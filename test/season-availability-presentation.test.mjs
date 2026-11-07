import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeSeasonAvailability } from
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
