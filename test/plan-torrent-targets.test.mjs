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

test('plans standard season-episode filenames provisionally against exact AniDB numbers', () => {
  for (const [name, id] of [
    ['[Judas] Firefly Wedding - S01E03.mkv', 1003],
    ['Firefly.Wedding.S01E02.Tennyo.Island.1080p.CR.WEB-DL.DUAL.AAC2.0.H.264.MSubs-ToonsHub.mkv', 1002],
    ['Show.S02E01.1080p.mkv', 1001],
  ]) {
    const video = { name, size: 1200 };
    assert.deepEqual(planTorrentTargets({ request, detail,
      prepared: { state: 'prepared_stopped', files: [video] } }), {
      state: 'planned_targets', episodeIds: [id],
      plannedFiles: [{ ...video, episodeIds: [id] }],
    });
  }
  for (const name of [
    'Show.S01E02-E03.mkv', 'Show.S01E02-03.mkv',
    'Show.S01E02E03.mkv', 'Show.S01E02 - 03.mkv',
  ]) assert.equal(planTorrentTargets({ request, detail,
    prepared: { state: 'prepared_stopped', files: [{ name, size: 1200 }] } }).state,
  'held');
});

test('numbered episodes and films still require a trusted release title', () => {
  const wrongSeries = planTorrentTargets({ request, detail, prepared: pack,
    releaseTitle: '[Group] Different Anime - 01-02', trustedTitle: 'Example' });
  assert.deepEqual(wrongSeries,
    { state: 'held', reason: 'release_title_mismatch' });
  const filmRequest = { ...request, kind: 'movie', episodeIds: [5001] };
  const filmDetail = { ...detail, kind: 'movie', total: 1,
    episodes: [{ id: 5001, number: 1, type: 'Episode' }] };
  const wrongFilm = planTorrentTargets({ request: filmRequest,
    detail: filmDetail, prepared: { state: 'prepared_stopped',
      files: [{ name: '01.mkv', size: 1200 }] },
    releaseTitle: 'Different Film', trustedTitle: 'Example' });
  assert.deepEqual(wrongFilm,
    { state: 'held', reason: 'release_title_mismatch' });
  assert.equal(planTorrentTargets({ request, detail, prepared: pack,
    releaseTitle: '[Group] EXAMPLE - 01-02', trustedTitle: 'Example' }).state,
  'planned_targets');
  assert.equal(planTorrentTargets({ request, detail, prepared: pack,
    releaseTitle: '[Group] Re:ZERO - 01-02', trustedTitle: 'Re Zero' }).state,
  'planned_targets');
  assert.equal(planTorrentTargets({ request, detail, prepared: pack,
    releaseTitle: '[Group] ReZero - 01-02', trustedTitle: 'Re Zero' }).state,
  'planned_targets');
  assert.deepEqual(planTorrentTargets({ request, detail, prepared: pack,
    releaseTitle: '[Group] Archive 1986 - 01-02', trustedTitle: '86' }),
  { state: 'held', reason: 'release_title_mismatch' });
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

test('plans one two-episode file only when both exact regular targets are requested', () => {
  const video = { name: '[Group] Show - 01-02 (1080p).mkv', size: 2400 };
  assert.deepEqual(planTorrentTargets({ request, detail,
    prepared: { state: 'prepared_stopped', files: [video] } }), {
    state: 'planned_targets', episodeIds: [1001, 1002],
    plannedFiles: [{ ...video, episodeIds: [1001, 1002] }],
  });
  for (const changed of [
    { request: { ...request, episodeIds: [1001] }, name: video.name },
    { request, name: '[Group] Show - 01-03 (1080p).mkv' },
    { request, name: '[Group] Show - 01-02-03 (1080p).mkv' },
  ]) {
    assert.equal(planTorrentTargets({ request: changed.request, detail,
      prepared: { state: 'prepared_stopped', files: [
        { ...video, name: changed.name },
      ] } }).state, 'held');
  }
  assert.equal(planTorrentTargets({ request, detail,
    prepared: { state: 'prepared_stopped', files: [video,
      { name: 'Show - 02.mkv', size: 1200 }] } }).state, 'held');
});

test('maps an explicitly requested AniDB Special only from an S-number filename', () => {
  const specialRequest = { ...request, episodeIds: [9002] };
  const specialDetail = { ...detail, total: 2, episodes: [
    { id: 1001, number: 1, type: 'Episode' },
    { id: 9002, number: 1, type: 'Special' },
  ] };
  const special = { name: '[Group] Show - S01 (1080p).mkv', size: 1200 };
  assert.deepEqual(planTorrentTargets({ request: specialRequest, detail: specialDetail,
    prepared: { state: 'prepared_stopped', files: [special] } }), {
    state: 'planned_targets', episodeIds: [9002],
    plannedFiles: [{ ...special, episodeIds: [9002] }],
  });
  const seasonZero = { ...special, name: 'Show.S00E01.mkv' };
  assert.deepEqual(planTorrentTargets({ request: specialRequest,
    detail: specialDetail,
    prepared: { state: 'prepared_stopped', files: [seasonZero] } }), {
    state: 'planned_targets', episodeIds: [9002],
    plannedFiles: [{ ...seasonZero, episodeIds: [9002] }],
  });
  const regular = { name: '[Group] Show - 01 (1080p).mkv', size: 1300 };
  assert.deepEqual(planTorrentTargets({
    request: { ...request, episodeIds: [1001, 9002] }, detail: specialDetail,
    prepared: { state: 'prepared_stopped', files: [regular, special] },
  }).plannedFiles, [
    { ...regular, episodeIds: [1001] }, { ...special, episodeIds: [9002] },
  ]);
  for (const name of ['[Group] Show - 01 (1080p).mkv',
    '[Group] Show - S01E01.mkv', '[Group] Show - S01-S02.mkv']) {
    assert.equal(planTorrentTargets({ request: specialRequest, detail: specialDetail,
      prepared: { state: 'prepared_stopped', files: [{ ...special, name }] } }).state,
    'held');
  }
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

test('a one-episode series can provisionally plan an unnumbered single video', () => {
  const oneRequest = { ...request, episodeIds: [1001] };
  const oneDetail = { ...detail, total: 1,
    episodes: [{ id: 1001, number: 1, type: 'Episode' }] };
  const video = { name: '[Group] Pale Cocoon (2005) [1080p].mkv', size: 1200 };
  assert.deepEqual(planTorrentTargets({ request: oneRequest, detail: oneDetail,
    releaseTitle: '[Group] Pale Cocoon (2005)', trustedTitle: 'Pale Cocoon',
    prepared: { state: 'prepared_stopped', files: [video] } }), {
    state: 'planned_targets', episodeIds: [1001],
    plannedFiles: [{ ...video, episodeIds: [1001] }],
  });
  for (const changed of [
    { detail, files: [video] },
    { detail: oneDetail, files: [video], releaseTitle: 'Unrelated release' },
    { detail: oneDetail, files: [video, { ...video, name: 'extra.mkv' }] },
    { detail: oneDetail, files: [{ ...video, name: 'Show S01E02.mkv' }] },
    { detail: oneDetail, files: [{ ...video, name: 'Show - 02.mkv' }] },
    { detail: oneDetail, files: [{ ...video, name: 'Show - 01-03.mkv' }] },
  ]) {
    assert.equal(planTorrentTargets({ request: oneRequest,
      releaseTitle: changed.releaseTitle ?? '[Group] Pale Cocoon (2005)',
      trustedTitle: 'Pale Cocoon',
      detail: changed.detail, prepared: { state: 'prepared_stopped',
        files: changed.files } }).state, 'held');
  }
  assert.equal(planTorrentTargets({ request: oneRequest, detail: oneDetail,
    prepared: { state: 'prepared_stopped', files: [video] } }).state, 'held');
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
