import test from 'node:test';
import assert from 'node:assert/strict';
import { createAniDbWeeklySchedule } from '../src/catalogue/anidb-weekly-schedule.mjs';

const week = { period: { week: '2026-W45',
  start_date: '2026-11-02', end_date: '2026-11-08' },
days: [
  { date: '2026-11-02', episodes: [
    { anidb_id: 50, anidb_episode_id: 501, anime_title: 'Weekly title',
      episode_number: '3', episode_type: 'regular', adult_only: false },
    { anidb_id: 60, anidb_episode_id: 601, anime_title: 'Adult title',
      episode_number: '2', episode_type: 'regular', adult_only: true },
  ] },
  { date: '2026-11-03', episodes: [{ anidb_id: 50,
    anidb_episode_id: 502, anime_title: 'Weekly title',
    episode_number: '4', episode_type: 'regular', adult_only: false }] },
  ...['04', '05', '06', '07', '08'].map((day) =>
    ({ date: `2026-11-${day}`, episodes: [] })),
] };
const reply = (body, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });

test('weekly Airing browse uses exact AniDB IDs and labels adult entries', async () => {
  const calls = [];
  const source = createAniDbWeeklySchedule({ now: () => 1_000,
    fetchImpl: async (url) => { calls.push(url); return reply(week); } });
  assert.deepEqual(await source.read(), { state: 'ready', week: '2026-W45',
    checkedMs: 1_000, items: [{ anidbId: 60, title: 'Adult title',
      scheduledDate: '2026-11-02', episodeNumber: '2', adult: true },
    { anidbId: 50, title: 'Weekly title', scheduledDate: '2026-11-02',
      episodeNumber: '3', adult: false }] });
  assert.equal((await source.read()).state, 'ready');
  assert.equal(calls.length, 1);
});

test('provider failure is distinct from an empty week and rejects unknown age flags', async () => {
  let clock = 1_000;
  let fail = false;
  const source = createAniDbWeeklySchedule({ now: () => clock,
    cacheMs: 100, staleMs: 300,
    fetchImpl: async () => fail ? reply({}, 503) : reply(week) });
  assert.equal((await source.read()).state, 'ready');
  clock = 1_101;
  fail = true;
  assert.equal((await source.read()).state, 'stale');
  clock = 1_301;
  assert.deepEqual(await source.read(), { state: 'unavailable' });
  const bad = createAniDbWeeklySchedule({ now: () => 1_000,
    fetchImpl: async () => reply({ ...week,
      days: [{ date: '2026-11-02', episodes: [{
        anidb_id: 1, anime_title: 'Unsafe', adult_only: null,
      }] }] }) });
  assert.deepEqual(await bad.read(), { state: 'unavailable' });
});
