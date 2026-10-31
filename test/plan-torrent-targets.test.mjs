import assert from 'node:assert/strict';
import test from 'node:test';
import { planTorrentTargets } from '../src/acquisition/plan-torrent-targets.mjs';

const request = { id: 7, status: 'held', anidbId: 42, kind: 'series',
  episodeIds: [1001, 1002, 1003] };
const detail = { state: 'details', complete: true, total: 3, anidbId: 42, kind: 'series',
  restricted: false,
  episodes: [
    { id: 1001, number: 1, type: 'Episode' },
    { id: 1002, number: 2, type: 'Episode' },
    { id: 1003, number: 3, type: 'Episode' },
  ] };
const pack = { state: 'prepared_stopped', files: [
  { name: 'Show/[Group] Show - 01 (1080p).mkv', size: 1200 },
  { name: 'Show/[Group] Show - 02 (1080p).mkv', size: 1300 },
  { name: 'Show/[Group] Show - 02 (1080p).ass', size: 25 },
] };

test('plans an exact subset from unambiguous AniDB regular episode numbers', () => {
  assert.deepEqual(planTorrentTargets({ request, detail, prepared: pack }), {
    state: 'planned_targets', episodeIds: [1001, 1002], plannedFiles: [
      { name: pack.files[0].name, size: 1200, episodeIds: [1001] },
      { name: pack.files[1].name, size: 1300, episodeIds: [1002] },
    ],
  });
});

test('plans a four-digit regular episode without accepting a range as one target', () => {
  const longRequest = { ...request, episodeIds: [9001] };
  const longDetail = { ...detail, total: 1,
    episodes: [{ id: 9001, number: 1000, type: 'Episode' }] };
  const video = { name: '[Group] Long Show - 1000 (1080p).mkv', size: 1200 };
  assert.deepEqual(planTorrentTargets({ request: longRequest, detail: longDetail,
    prepared: { state: 'prepared_stopped', files: [video] } }), {
    state: 'planned_targets', episodeIds: [9001],
    plannedFiles: [{ ...video, episodeIds: [9001] }],
  });
  assert.equal(planTorrentTargets({ request: longRequest, detail: longDetail,
    prepared: { state: 'prepared_stopped', files: [
      { ...video, name: '[Group] Long Show - 1000-1001.mkv' },
    ] } }).state, 'held');
});

test('a one-video movie uses its one requested AniDB episode identity', () => {
  const filmRequest = { ...request, kind: 'movie', episodeIds: [5001] };
  const filmDetail = { ...detail, kind: 'movie', total: 1,
    episodes: [{ id: 5001, number: 1, type: 'Episode' }] };
  assert.deepEqual(planTorrentTargets({ request: filmRequest, detail: filmDetail,
    prepared: { ...pack, files: [{ name: 'Feature Film.mkv', size: 2400 }] } }), {
    state: 'planned_targets', episodeIds: [5001],
    plannedFiles: [{ name: 'Feature Film.mkv', size: 2400, episodeIds: [5001] }],
  });
});

test('passive artwork and notes cannot claim an AniDB episode', () => {
  const prepared = { ...pack, files: [...pack.files,
    { name: 'Show/readme.nfo', size: 200 },
    { name: 'Show/cover.jpg', size: 300 }] };
  const plan = planTorrentTargets({ request, detail, prepared });
  assert.equal(plan.state, 'planned_targets');
  assert.deepEqual(plan.episodeIds, [1001, 1002]);
  assert.equal(plan.plannedFiles.length, 2);
});

test('ambiguous pack, duplicate number, foreign target, and special hold without a claim', () => {
  const variants = [
    { ...pack, files: [{ name: 'Show S01E01.mkv', size: 1200 }] },
    { ...pack, files: [{ name: 'Show - 01-02.mkv', size: 1200 }] },
    { ...pack, files: [{ name: 'Show - 01.mkv', size: 1200 },
      { name: 'Show - 01 alt.mkv', size: 1300 }] },
    { ...pack, files: [{ name: 'Show - 04.mkv', size: 1200 }] },
    { ...pack, files: [{ name: 'Show - 01.mkv', size: 1200 },
      { name: 'run.sh', size: 100 }] },
  ];
  for (const prepared of variants) {
    assert.equal(planTorrentTargets({ request, detail, prepared }).state, 'held');
  }
  assert.equal(planTorrentTargets({ request: { ...request, episodeIds: [1001] },
    detail, prepared: pack }).state, 'held');
  assert.equal(planTorrentTargets({ request, detail: { ...detail,
    total: 1, episodes: [{ id: 1001, number: 1, type: 'Special' }] },
    prepared: { ...pack, files: [pack.files[0]] } }).state, 'held');
});

test('incomplete or contradictory AniDB detail cannot make a plan', () => {
  for (const changed of [
    { ...detail, complete: false },
    { ...detail, restricted: true },
    { ...detail, restricted: null },
    { ...detail, anidbId: 43 },
    { ...detail, episodes: [...detail.episodes, { id: 9000, number: 1, type: 'Episode' }] },
  ]) assert.equal(planTorrentTargets({ request, detail: changed, prepared: pack }).state, 'held');
});
