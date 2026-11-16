import assert from 'node:assert/strict';
import test from 'node:test';
import { regularEpisodeSchedule, episodeScheduleLabel, nextAirDateLabel } from
  '../src/web/public/episode-schedule.mjs';

test('aired, future and undated entries remain distinct', () => {
  const episodes = [
    { id: 1, type: 'Episode', number: 1, airDate: '2026-11-12', title: 'First' },
    { id: 2, type: 'Episode', number: 2, airDate: '2026-11-14', title: 'Episode 2' },
    { id: 3, type: 'Episode', number: 3, airDate: null, title: 'Episode 3' },
    { id: 4, type: 'Special', number: 1, airDate: '2026-12-01', title: '' },
  ];
  assert.deepEqual(regularEpisodeSchedule({ episodes, asOf: '2026-11-13',
    verifiedIds: new Set([1, 2]) }),
    { aired: 1, upcoming: 1, undated: 1, verifiedAired: 1,
      total: 3, asOf: '2026-11-13',
      nextAirDate: '2026-11-14', nextEpisodeNumber: 2 });
  assert.equal(episodeScheduleLabel(episodes[1], '2026-11-13'),
    'Upcoming · scheduled 2026-11-14 · title not published yet');
  assert.equal(episodeScheduleLabel(episodes[2], '2026-11-13'),
    'Air date and title not published yet');
  assert.equal(episodeScheduleLabel(episodes[0], '2026-11-13'), 'Aired');
});

test('the next air date uses the earliest dated regular entry and excludes specials', () => {
  const episodes = [
    { id: 4, type: 'Episode', number: 4, airDate: '2026-11-21' },
    { id: 3, type: 'Episode', number: 3, airDate: null },
    { id: 2, type: 'Episode', number: 2, airDate: '2026-11-15' },
    { id: 1, type: 'Episode', number: 1, airDate: '2026-11-12' },
    { id: 9, type: 'Special', number: 1, airDate: '2026-11-14' },
  ];
  const result = regularEpisodeSchedule({ episodes, asOf: '2026-11-13' });
  assert.equal(result.nextAirDate, '2026-11-15');
  assert.equal(result.nextEpisodeNumber, 2);
  assert.deepEqual(regularEpisodeSchedule({ episodes: [episodes[2], episodes[4]],
    asOf: '2026-11-15' }).nextAirDate, '2026-11-15');
  assert.equal(regularEpisodeSchedule({ episodes, asOf: '2026-11-15',
    verifiedIds: new Set([2]) }).nextAirDate, '2026-11-21');
  assert.equal(regularEpisodeSchedule({ episodes: [episodes[0]],
    asOf: '2026-11-22' }).nextAirDate, null);
});

test('only an airing series shows a next air date or an honest unknown state', () => {
  assert.equal(nextAirDateLabel({ kind: 'series', releaseState: 'airing',
    schedule: { nextAirDate: '2026-11-15', nextEpisodeNumber: 2 } }),
  'Next scheduled episode: 2 · 2026-11-15');
  assert.equal(nextAirDateLabel({ kind: 'series', releaseState: 'airing',
    schedule: { nextAirDate: null } }), 'Next air date unknown');
  assert.equal(nextAirDateLabel({ kind: 'series', releaseState: 'airing',
    schedule: null }), 'Next air date unknown');
  assert.equal(nextAirDateLabel({ kind: 'movie', releaseState: 'airing',
    schedule: null }), null);
  assert.equal(nextAirDateLabel({ kind: 'series', releaseState: 'completed',
    schedule: null }), null);
});
