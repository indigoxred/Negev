import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeDisplayFacts } from '../src/catalogue/merge-display-facts.mjs';

test('conflicting archive dates do not appear beside a newer mapped season', () => {
  const display = { state: 'display', anidbId: 19608,
    startYear: 1970, startDate: '1970-01-01', endDate: '1970-01-01' };
  const facts = { state: 'facts', year: 2027, season: 'Spring 2027',
    status: 'Upcoming', studio: null, durationMinutes: null };
  assert.deepEqual(mergeDisplayFacts(display, facts), {
    ...display, startYear: null, startDate: null, endDate: null,
    season: 'Spring 2027', releaseStatus: 'Upcoming',
    studio: null, durationMinutes: null,
  });
});

test('consistent dates and missing map facts keep the archive display intact', () => {
  const display = { state: 'display', anidbId: 15733,
    startYear: 2021, startDate: '2021-01-10', endDate: '2021-04-04' };
  const facts = { state: 'facts', year: 2021, season: 'Winter 2021',
    status: 'Finished', studio: 'cloverworks', durationMinutes: 23 };
  assert.deepEqual(mergeDisplayFacts(display, facts), {
    ...display, season: 'Winter 2021', releaseStatus: 'Finished',
    studio: 'cloverworks', durationMinutes: 23,
  });
  assert.deepEqual(mergeDisplayFacts(display, { state: 'unavailable' }), display);
});
