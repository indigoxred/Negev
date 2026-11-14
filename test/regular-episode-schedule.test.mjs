import assert from 'node:assert/strict';
import test from 'node:test';
import { regularEpisodeSchedule, episodeScheduleLabel } from
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
      total: 3, asOf: '2026-11-13' });
  assert.equal(episodeScheduleLabel(episodes[1], '2026-11-13'),
    'Upcoming · scheduled 2026-11-14 · title not published yet');
  assert.equal(episodeScheduleLabel(episodes[2], '2026-11-13'),
    'Air date and title not published yet');
  assert.equal(episodeScheduleLabel(episodes[0], '2026-11-13'), 'Aired');
});
