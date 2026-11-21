import assert from 'node:assert/strict';
import test from 'node:test';
import * as targetPlanning from '../src/acquisition/plan-torrent-targets.mjs';
import { matchesTrustedReleaseTitle, planTorrentTargets } from
  '../src/acquisition/plan-torrent-targets.mjs';

test('a release group alone cannot match the requested anime title', () => {
  assert.equal(matchesTrustedReleaseTitle(
    '[Cerberus] Fate Extra Last Encore [BD 1080p]', 'Cerberus'), false);
  assert.equal(matchesTrustedReleaseTitle(
    '[Cerberus] Seisen Cerberus - 01 [BD 1080p]', 'Cerberus'), true);
  assert.equal(matchesTrustedReleaseTitle(
    '[MTBB] Dead Leaves (WEB 720p)', 'Dead Leaves'), true);
});

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

test('maps a revised episode number without treating its version as an episode', () => {
  for (const name of ['[Group] Show - 03v2 [1080p].mkv',
    '[Group] Show S01E03v2 [1080p].mkv',
    '[Group] Show E03v2 [1080p].mkv']) {
    const plan = planTorrentTargets({ request: { ...request,
      episodeIds: [1003] }, detail,
    prepared: { state: 'prepared_stopped', files: [{ name, size: 1000 }] },
    releaseTitle: '[Group] Show - 03v2 [1080p]', trustedTitle: 'Show' });
    assert.equal(plan.state, 'planned_targets', name);
    assert.deepEqual(plan.episodeIds, [1003]);
  }
});

test('maps a full BD season whose files put episode numbers before source tags', () => {
  const episodeIds = Array.from({ length: 13 }, (_, index) => 2001 + index);
  const fullDetail = { ...detail, total: 13,
    episodes: episodeIds.map((id, index) => ({ id,
      number: index + 1, type: 'Episode' })) };
  const fullRequest = { ...request, episodeIds };
  const files = episodeIds.map((_, index) => ({
    name: `[OxyMux] Seisen Cerberus Ryuukoku no Fatalite ${String(index + 1).padStart(2, '0')} [BD 1080p][Multi Subs].mkv`,
    size: 1000 + index,
  }));
  const plan = planTorrentTargets({ request: fullRequest, detail: fullDetail,
    prepared: { state: 'prepared_stopped', files },
    releaseTitle: '[OxyMux] Cerberus Season 1 (BD 1080p)',
    trustedTitle: 'Cerberus' });
  assert.equal(plan.state, 'planned_targets');
  assert.deepEqual(plan.episodeIds, episodeIds);
});

test('maps a complete season by one file-number sequence across group layouts', () => {
  for (const nameForEpisode of [
    (n) => `[Alpha] Show E${String(n).padStart(2, '0')} (WEB 1080p).mkv`,
    (n) => `${String(n).padStart(2, '0')} - Show [DVD].mkv`,
    (n) => `[86Fans] Show.${String(n).padStart(2, '0')}.720p.mkv`,
    (n) => `Show Episode ${String(n).padStart(2, '0')} (2016) 1080p.mkv`,
    (n) => `Show.${String(n).padStart(2, '0')}.720p.[ABC${n + 6}DEF].mkv`,
  ]) {
    const files = [1, 2, 3].map((number) => ({
      name: nameForEpisode(number), size: 1000 + number,
    }));
    const plan = planTorrentTargets({ request, detail,
      prepared: { state: 'prepared_stopped', files },
      releaseTitle: '[Group] Show Season 1', trustedTitle: 'Show' });
    assert.equal(plan.state, 'planned_targets', files[0].name);
    assert.deepEqual(plan.episodeIds, [1001, 1002, 1003]);
    assert.deepEqual(plan.plannedFiles.map((file) => file.episodeIds),
      [[1001], [1002], [1003]]);
  }
});

test('season sequence rejects duplicate, ranged, extra and conflicting video files', () => {
  for (const names of [
    ['Show E01.mkv', 'Show E01 Alternate.mkv', 'Show E03.mkv'],
    ['Show 01-02.mkv', 'Show 02-03.mkv', 'Show 03-04.mkv'],
    ['Show E01.mkv', 'Show E02.mkv', 'Show E03.mkv', 'Show E04.mkv'],
    ['Show 01 Part 01.mkv', 'Show 02 Part 02.mkv', 'Show 03 Part 03.mkv'],
    ['Show - 01 E02.mkv', 'Show - 02 E03.mkv', 'Show - 03 E01.mkv'],
    ['Show S01E01 S01E02.mkv', 'Show S01E02 S01E03.mkv',
      'Show S01E03 S01E01.mkv'],
    ['Show 01 + 02.mkv', 'Show 02 + 03.mkv', 'Show 03 + 04.mkv'],
    ['Show 01 & 02.mkv', 'Show 02 & 03.mkv', 'Show 03 & 04.mkv'],
    ['Show 01 and 02.mkv', 'Show 02 and 03.mkv', 'Show 03 and 04.mkv'],
  ]) {
    const plan = planTorrentTargets({ request, detail,
      prepared: { state: 'prepared_stopped', files: names.map((name) =>
        ({ name, size: 1000 })) },
      releaseTitle: 'Show Season 1', trustedTitle: 'Show' });
    assert.equal(plan.state, 'held', names.join(', '));
  }
  const twoEpisodeRequest = { ...request, episodeIds: [1001, 1002] };
  const twoFiles = ['Show S01E01 S01E02.mkv',
    'Show S01E02 S01E03.mkv'];
  assert.equal(planTorrentTargets({ request: twoEpisodeRequest, detail,
    prepared: { state: 'prepared_stopped', files: twoFiles.map((name) =>
      ({ name, size: 1000 })) },
    releaseTitle: 'Show Season 1', trustedTitle: 'Show' }).state, 'held');
  for (const name of ['Show 01 + 02.mkv', 'Show 01 & 02.mkv',
    'Show 01 and 02.mkv']) {
    assert.equal(planTorrentTargets({ request: twoEpisodeRequest, detail,
      prepared: { state: 'prepared_stopped', files: [{ name, size: 1000 }] },
      releaseTitle: 'Show Season 1', trustedTitle: 'Show' }).state, 'held');
  }
});

test('a complete installment pack can provisionally normalize one consistent absolute sequence', () => {
  const files = [27, 25, 26].map((n) => ({
    name: `[Group] Show - ${n}.mkv`, size: 1000 + n,
  }));
  const plan = planTorrentTargets({ request, detail,
    prepared: { state: 'prepared_stopped', files },
    releaseTitle: '[Group] Show (2025) (Season 2)', trustedTitle: 'Show (2025)' });
  assert.equal(plan.state, 'planned_targets');
  assert.deepEqual(plan.plannedFiles.map((file) => file.episodeIds),
    [[1003], [1001], [1002]]);
});

test('absolute pack normalization requires a complete single unambiguous regular installment', () => {
  for (const numbers of [[25, 26], [25, 25, 27], [25, 26, 28], [24, 25, 26, 27]]) {
    const plan = planTorrentTargets({ request, detail,
      prepared: { state: 'prepared_stopped', files: numbers.map((n) =>
        ({ name: `Show - ${n}.mkv`, size: 1000 })) },
      releaseTitle: 'Show (2025)', trustedTitle: 'Show (2025)' });
    assert.equal(plan.state, 'held', numbers.join(','));
  }
  for (const names of [
    ['Show - 25 E01.mkv', 'Show - 26 E02.mkv', 'Show - 27 E03.mkv'],
    ['Show - 25 Part 01.mkv', 'Show - 26 Part 02.mkv', 'Show - 27 Part 03.mkv'],
    ['Show - S25.mkv', 'Show - S26.mkv', 'Show - S27.mkv'],
  ]) {
    assert.equal(planTorrentTargets({ request, detail,
      prepared: { state: 'prepared_stopped', files: names.map((name) => ({name,size:1000})) },
      releaseTitle: 'Show (2025)', trustedTitle: 'Show (2025)' }).state, 'held');
  }
  const subset = { ...request, episodeIds: [1002, 1003] };
  assert.equal(planTorrentTargets({ request: subset, detail,
    prepared: { state: 'prepared_stopped', files: [26,27].map(n=>
      ({name:`Show - ${n}.mkv`,size:1000})) },
    releaseTitle: 'Show (2025)', trustedTitle: 'Show (2025)' }).state,'held');
});

test('selects requested regular episodes while excluding a separate Specials folder', () => {
  const files = [
    { name: '[Group]_Show_01_[DVD][4BD6D6B5].mkv', size: 1200 },
    { name: '[Group]_Show_02_[DVD][41541F2A].mkv', size: 1300 },
    { name: 'Specials/[Group]_Show_03_[DVD][C84024AB].mkv', size: 1400 },
  ];
  const subset = { ...request, episodeIds: [1001, 1002] };
  assert.deepEqual(planTorrentTargets({ request: subset, detail,
    prepared: { state: 'prepared_stopped', files } }), {
    state: 'planned_targets', episodeIds: [1001, 1002],
    plannedFiles: [
      { ...files[0], episodeIds: [1001] },
      { ...files[1], episodeIds: [1002] },
    ],
    excludedVideoNames: [files[2].name],
  });
  const unsafe = planTorrentTargets({ request: subset, detail,
    prepared: { state: 'prepared_stopped', files: [
      files[0], { ...files[2], name: 'More/[Group]_Show_03_[DVD][C84024AB].mkv' },
    ] } });
  assert.equal(unsafe.reason, 'ambiguous_or_unrequested_video');
});

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
    ['[Group] Show - 01 [BD 1080p].mkv', 1001],
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

test('separately named NCOP and NCED clips are excluded from a regular episode request', () => {
  const prepared = { ...pack, files: [...pack.files,
    { name: 'Show/NCOP.mkv', size: 100 },
    { name: 'Show/NCED.mkv', size: 120 },
    { name: 'Show/checksums.md5', size: 90 }] };
  const plan = planTorrentTargets({ request, detail, prepared });
  assert.equal(plan.state, 'planned_targets');
  assert.deepEqual(plan.episodeIds, [1001, 1002]);
  assert.deepEqual(plan.excludedVideoNames, ['Show/NCOP.mkv', 'Show/NCED.mkv']);
  assert.equal(plan.plannedFiles.length, 2);
  assert.equal(planTorrentTargets({ request, detail,
    prepared: { ...pack, files: [...pack.files,
      { name: 'Show/Show - 04.mkv', size: 100 }] } }).state, 'held');
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
    { ...detail, restricted: null },
    { ...detail, anidbId: 43 },
    { ...detail, episodes: [...detail.episodes, { id: 9000, number: 1, type: 'Episode' }] },
  ]) assert.equal(planTorrentTargets({ request, detail: changed, prepared: pack }).state, 'held');
  assert.equal(planTorrentTargets({ request, detail: { ...detail, restricted: true },
    prepared: pack }).state, 'planned_targets');
});


test('standalone labelled opening and ending extras do not reject an otherwise complete season',()=>{
 const files=[1,2,3].map(n=>({name:'Show - 0'+n+'v2 [BD 1080p].mkv',size:1000}));
 const extras=['Show - OP [BD 1080p].mkv','Show - ED [BD 1080p].mkv','Clean Opening.mkv','Clean Ending.mkv'].map(name=>({name,size:100}));
 const result=planTorrentTargets({request,detail,prepared:{state:'prepared_stopped',files:[...files,...extras]},releaseTitle:'Show BD 1080p',trustedTitle:'Show'});
 assert.equal(result.state,'planned_targets');assert.equal(result.plannedFiles.length,3);assert.equal(result.excludedVideoNames.length,4);
});


test('season-labelled year aliases are retrieval hints without changing strict matching', () => {
  const matches = targetPlanning.matchesSeasonLabelledTitle;
  assert.equal(typeof matches, 'function');
  for (const [release, title] of [
    ['[JP-EN] Silver Orchard : Season 02 S02 [2025] COMPLETE 1080p', 'Silver Orchard (2025)'],
    ['[Group] Violet Harbour S03 (2024) BD', 'Violet Harbour (2024)'],
    ['[Team] Moon & Lantern Season 01 [2023]', 'Moon and Lantern (2023)'],
  ]) {
    assert.equal(matchesTrustedReleaseTitle(release, title), false, release);
    assert.equal(matches(release, title), true, release);
  }
});

test('season-labelled retrieval preserves title, catalogue year, and consistent season tags', () => {
  const matches = targetPlanning.matchesSeasonLabelledTitle;
  assert.equal(typeof matches, 'function');
  for (const release of [
    '[Group] Silver Orchard Season 02 S03 [2025]',
    '[Group] Silver Orchard S02 Season 03 [2025]',
    '[Group] Silver Orchard Season 02 [2024]',
    '[Group] Silver Orchard Side Story Season 02 [2025]',
    '[Silver Orchard] Different Title Season 02 [2025]',
    '[Group] Silver Orchard 02 [2025]',
    '[Group] Silver Orchard Part 02 [2025]',
    '[Group] Silver Orchard Season 00 [2025]',
  ]) assert.equal(matches(release, 'Silver Orchard (2025)'), false, release);
  assert.equal(matches('[Group] Silver Orchard Season 02 [2025]', 'Silver Orchard'), false);
});

test('metadata variation allows only an opted-in provisional target plan', () => {
  const input = { request, detail: { ...detail, title: 'Silver Orchard (2025)' },
    prepared: pack, releaseTitle: '[Group] Silver Orchard Season 02 S02 [2025]',
    trustedTitle: 'Silver Orchard (2025)' };
  assert.deepEqual(planTorrentTargets(input), { state: 'held', reason: 'release_title_mismatch' });
  const plan = planTorrentTargets({ ...input, allowTitleMetadataVariation: true });
  assert.equal(plan.state, 'planned_targets');
  assert.deepEqual(plan.plannedFiles.map((file) => file.episodeIds), [[1001], [1002]]);
});
