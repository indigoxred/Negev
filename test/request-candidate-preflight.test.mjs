import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { previewRequestCandidate } from '../src/acquisition/request-candidate-preflight.mjs';
import { createRequestCandidateDiscovery } from '../src/acquisition/request-candidate-discovery.mjs';
import { prepareStoppedCandidate } from '../src/acquisition/prepare-stopped-candidate.mjs';
import { createAniDbCorrespondence } from '../src/identity/anidb-correspondence.mjs';
import { createAcquisitionRequestProcessor } from '../src/acquisition/acquisition-request-processor.mjs';

const candidate = { guid: 'release-1', indexerId: 7,
  title: 'Example - 01', size: 1_000 };
const request = { id: 4, status: 'held', anidbId: 42,
  kind: 'series', episodeIds: [1001, 1002] };
const detail = { state: 'details', complete: true, total: 2, page: 1,
  nextPage: null,
  anidbId: 42, title: 'Example', kind: 'series', restricted: false,
  episodes: [{ id: 1001, number: 1, type: 'Episode', title: 'First' },
    { id: 1002, number: 2, type: 'Episode', title: 'Second' }] };
const prepared = { state: 'prepared_stopped', expected: { hash: 'a'.repeat(40) },
  version: 'v1', totalBytes: 1_000,
  files: [{ name: 'Example - 01.mkv', size: 1_000 }],
  form: new FormData() };

test('preflight exposes per-file correspondence without making it an acquisition gate', async () => {
  for (const throws of [false, true]) {
    let calls = 0;
    const result = await previewRequestCandidate({ requestId: 4, candidate,
      readRequest: () => request, loadDetail: async () => detail,
      prepare: async () => prepared,
      inspectCorrespondence: async ({ anidbId, torrentHash, files }) => {
        calls++;
        assert.equal(anidbId, 42);
        assert.equal(torrentHash, 'a'.repeat(40));
        assert.equal(files[0].episodeIds[0], 1001);
        if (throws) throw Error('lookup unavailable');
        return { state: 'likely', files: [{ name: files[0].name, state: 'likely' }] };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.state, 'preflight');
    assert.equal(result.registeredInAniDb, false);
    assert.equal(result.correspondence.state, throws ? 'unknown' : 'likely');
  }
});

test('an AniMap outage still permits normal automatic acquisition of an eligible release', async () => {
  let submitted = 0;
  const inspectCorrespondence = createAniDbCorrespondence({
    fetchImpl: async () => new Response(null, { status: 429 }) });
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request, requireReleasePolicy: true, preferShokoPreview: true,
    loadDetail: async () => detail,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: [{ ...candidate, title: 'Example - 01 1080p',
        seeders: 10, evidence: 'unverified' }] }),
    previewCandidate: (input) => previewRequestCandidate({ ...input,
      readRequest: () => request, loadDetail: async () => detail,
      prepare: async () => ({ ...prepared,
        files: [{ ...prepared.files[0], name: 'Example - 01 [AABBCCDD].mkv' }] }),
      inspectCorrespondence }),
    submitCandidate: async ({ preflight }) => {
      submitted++;
      return { state: 'stopped_observed', attemptId: 11 };
    },
  });
  assert.equal((await process({ requestId: 4 })).state, 'stopped_observed');
  assert.equal(submitted, 1);
});

test('preflight returns only provisional file and target evidence', async () => {
  let preparedCalls = 0;
  const result = await previewRequestCandidate({ requestId: 4, candidate,
    readRequest: () => request, loadDetail: async () => detail,
    prepare: async ({ query, candidate: selected }) => {
      preparedCalls++;
      assert.equal(query, 'Example');
      assert.deepEqual(selected, candidate);
      return prepared;
    } });
  assert.equal(preparedCalls, 1);
  assert.deepEqual(result, { state: 'preflight', requestId: 4,
    anidbId: 42, torrentHash: 'a'.repeat(40), version: 'v1',
    totalBytes: 1_000, episodeIds: [1001],
    files: [{ name: 'Example - 01.mkv', size: 1_000,
      episodeIds: [1001] }], subtitles: [], filesToExclude: [],
    registeredInAniDb: false,
    downloadStarted: false });
  assert.equal(JSON.stringify(result).includes('form'), false);
});

test('an exact-episode result is rechecked with its original trusted query', async () => {
  const queried = [];
  const result = await previewRequestCandidate({ requestId: 4,
    candidate: { ...candidate, sourceQuery: 'Example 01',
      targetEpisodeId: 1001, targetedEpisode: true },
    readRequest: () => request, loadDetail: async () => detail,
    prepare: async ({ query }) => { queried.push(query); return prepared; } });
  assert.equal(result.state, 'preflight');
  assert.deepEqual(queried, ['Example 01']);
  assert.equal(result.searchQuery, 'Example 01');
});

test('a long same-ID main title keeps its exact search query through preflight', async () => {
  const japanese = 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu';
  const selected = { ...candidate,
    title: '[Group] Kashita Maryoku wa Revo Barai de Kyousei Choushuu - 01 1080p',
    sourceQuery: `${japanese} 01`, targetEpisodeId: 1001,
    targetedEpisode: true };
  const queried = [];
  const result = await previewRequestCandidate({ requestId: 4,
    candidate: selected, readRequest: () => request,
    loadDetail: async () => ({ ...detail,
      title: `${japanese}: ${'Long subtitle '.repeat(12)}` }),
    releaseQueries: async () => ['Magic Repo Man'],
    prepare: async ({ query }) => {
      queried.push(query);
      return { ...prepared, files: [{
        name: 'Kashita Maryoku wa Revo Barai de Kyousei Choushuu - 01.mkv',
        size: 1_000 }] };
    },
  });
  assert.equal(result.state, 'preflight');
  assert.equal(result.searchQuery, `${japanese} 01`);
  assert.equal(result.identityTitle, japanese);
  assert.deepEqual(queried, [`${japanese} 01`]);
});

test('a broad long-title search prefix cannot establish a different title identity', async () => {
  const longTitle = 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu: ' +
    'Long subtitle '.repeat(12);
  let preparedCalls = 0;
  const result = await previewRequestCandidate({ requestId: 4,
    candidate: { ...candidate,
      title: '[Group] Kashita Maryoku wa A Completely Different Tale - 01',
      sourceQuery: 'Kashita Maryoku wa 01', targetEpisodeId: 1001,
      targetedEpisode: true },
    readRequest: () => request,
    loadDetail: async () => ({ ...detail, title: longTitle }),
    releaseQueries: async () => ['Magic Repo Man'],
    prepare: async () => { preparedCalls++; return prepared; },
  });
  assert.deepEqual(result, { state: 'held', reason: 'release_title_mismatch' });
  assert.equal(preparedCalls, 0);
});

test('a broad search hit needs an independent exact Shoko episode prediction', async () => {
  const longTitle = 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu: ' +
    'Long subtitle '.repeat(12);
  const filename = 'Kashita Maryoku wa A Completely Different Tale - 01.mkv';
  const input = { requestId: 4,
    candidate: { ...candidate,
      title: '[Group] Kashita Maryoku wa A Completely Different Tale - 01',
      sourceQuery: 'Kashita Maryoku wa 01', targetEpisodeId: 1001,
      targetedEpisode: true },
    readRequest: () => request,
    loadDetail: async () => ({ ...detail, title: longTitle }),
    releaseQueries: async () => ['Magic Repo Man'],
    prepare: async () => ({ ...prepared, files: [{ name: filename, size: 1_000 }] }),
  };
  assert.deepEqual(await previewRequestCandidate({ ...input,
    offlineLookup: async () => ({ status: 204 }) }),
  { state: 'held', reason: 'release_title_mismatch' });
  const result = await previewRequestCandidate({ ...input,
    offlineLookup: async () => ({ status: 200, release: {
      ProviderName: 'Offline Importer', IsCorrupted: false,
      ID: 'offline://42-1001', OriginalFilename: filename,
      CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
        PercentageStart: 0, PercentageEnd: 100 }],
    } }) });
  assert.equal(result.state, 'preflight');
  assert.equal(result.shokoPreview, 'exact');
});

test('a short same-ID query keeps a seeded 1080p title eligible for exact file checks', async () => {
  const japanese = 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu';
  const selected = { ...candidate,
    title: '[SubsPlease] Kashita Maryoku wa Revo Barai de Kyousei Choushuu - 01 (1080p)',
    sourceQuery: 'Kashita Maryoku wa 01', targetEpisodeId: 1001,
    targetedEpisode: true };
  const queried = [];
  const result = await previewRequestCandidate({ requestId: 4,
    candidate: selected, readRequest: () => request,
    loadDetail: async () => ({ ...detail,
      title: `${japanese}: ${'Long subtitle '.repeat(12)}` }),
    releaseQueries: async () => ['Magic Repo Man'],
    prepare: async ({ query }) => {
      queried.push(query);
      return { ...prepared, files: [{
        name: 'Kashita Maryoku wa Revo Barai de Kyousei Choushuu - 01.mkv',
        size: 1_000 }] };
    },
  });
  assert.equal(result.state, 'preflight');
  assert.equal(result.searchQuery, 'Kashita Maryoku wa 01');
  assert.equal(result.identityTitle, japanese);
  assert.deepEqual(queried, ['Kashita Maryoku wa 01']);
});

test('a release absent from broad top 50 survives discovery and preflight', async () => {
  const exact = { ...candidate, title: 'Example - 01 WEB 1080p',
    seeders: 100, evidence: 'unverified' };
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request, loadDetail: async () => detail,
    pause: async () => {},
    searchReleases: async ({ query }) => ({ state: 'candidates',
      items: query === 'Example 01' ? [exact] :
        Array.from({ length: 50 }, (_, index) => ({ ...exact,
          guid: `decoy-${index}`, title: `Example - ${index + 2} WEB 1080p` })) }),
  });
  const found = await discover({ requestId: 4,
    searchTargetEpisodeId: 1001 });
  const selected = found.items.find((item) => item.guid === exact.guid);
  assert.equal(selected.sourceQuery, 'Example 01');
  const queried = [];
  const result = await previewRequestCandidate({ requestId: 4,
    candidate: selected, readRequest: () => request,
    loadDetail: async () => detail,
    prepare: async ({ query }) => {
      queried.push(query);
      return query === 'Example 01' ? prepared :
        { state: 'held', reason: 'candidate_changed' };
    } });
  assert.equal(result.state, 'preflight');
  assert.deepEqual(queried, ['Example 01']);
});

test('an untrusted query or fuzzy other-episode result cannot pass preflight', async () => {
  let preparedCalls = 0;
  const run = (selected, files) => previewRequestCandidate({ requestId: 4,
    candidate: { ...candidate, sourceQuery: selected,
      targetEpisodeId: 1001, targetedEpisode: true },
    readRequest: () => request, loadDetail: async () => detail,
    prepare: async () => { preparedCalls++; return { ...prepared, files }; } });
  assert.deepEqual(await run('Other Anime 01', prepared.files),
    { state: 'held', reason: 'untrusted_release_query' });
  assert.equal(preparedCalls, 0);
  assert.deepEqual(await run('Example 01',
    [{ name: 'Example - 02.mkv', size: 1_000 }]),
    { state: 'held', reason: 'targeted_result_wrong_episode' });
});

test('preflight refuses a video excluded by Shoko and waits if settings cannot be read', async () => {
  const run = (extensions) => previewRequestCandidate({ requestId: 4, candidate,
    readRequest: () => request, loadDetail: async () => detail,
    readVideoExtensions: async () => extensions,
    prepare: async () => ({ ...prepared,
      files: [{ name: 'Example - 01.webm', size: 1_000 }] }) });
  assert.deepEqual(await run({ state: 'extensions', values: ['.mkv'] }),
    { state: 'held', reason: 'shoko_video_format_unsupported' });
  assert.deepEqual(await run({ state: 'unavailable' }),
    { state: 'held', reason: 'shoko_settings_unavailable' });
});

test('Shoko filename preview marks exact identity and refuses a different episode', async () => {
  const release = (episodeId) => ({ status: 200, release: {
    ProviderName: 'Offline Importer', IsCorrupted: false,
    ID: `offline://42-${episodeId}`,
    OriginalFilename: 'Example - 01.mkv',
    CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: episodeId,
      PercentageStart: 0, PercentageEnd: 100 }],
  } });
  const run = (episodeId) => previewRequestCandidate({ requestId: 4, candidate,
    readRequest: () => request, loadDetail: async () => detail,
    prepare: async () => prepared,
    offlineLookup: async () => release(episodeId),
  });
  assert.equal((await run(1001)).shokoPreview, 'exact');
  assert.deepEqual(await run(1002),
    { state: 'held', reason: 'shoko_preview_wrong_identity' });
});

test('a normalized absolute season pack retains exact Shoko identity checks and provisional labels', async () => {
  const files = [{ name: 'Example - 25.mkv', size: 1000 },
    { name: 'Example - 26.mkv', size: 1000 }];
  const run = (wrongIdentity) => previewRequestCandidate({ requestId: 4,
    candidate: { ...candidate, title: 'Example (2025) Season 2' },
    readRequest: () => request, loadDetail: async () => detail,
    prepare: async () => ({ ...prepared, totalBytes: 2000, files }),
    offlineLookup: async ({ filename }) => {
      const episodeId = filename === 'Example - 25.mkv' ? 1001 : 1002;
      return { status: 200, release: { ProviderName: 'Offline Importer',
        IsCorrupted: false, ID: `offline://${wrongIdentity ? 43 : 42}-${episodeId}`,
        OriginalFilename: filename,
        CrossReferences: [{ AnidbAnimeID: wrongIdentity ? 43 : 42,
          AnidbEpisodeID: episodeId, PercentageStart: 0, PercentageEnd: 100 }] } };
    },
  });
  const result = await run(false);
  assert.equal(result.state, 'preflight');
  assert.deepEqual(result.files.map((file) => file.episodeIds), [[1001], [1002]]);
  assert.equal(result.shokoPreview, 'exact');
  assert.equal(result.registeredInAniDb, false);
  assert.equal(result.downloadStarted, false);
  assert.deepEqual(await run(true), { state: 'held', reason: 'shoko_preview_wrong_identity' });
});

test('a numbered release for an unrelated title cannot become a preflight', async () => {
  const result = await previewRequestCandidate({ requestId: 4,
    candidate: { ...candidate, title: 'Different Anime - 01' },
    readRequest: () => request, loadDetail: async () => detail,
    prepare: async () => prepared });
  assert.deepEqual(result,
    { state: 'held', reason: 'release_title_mismatch' });
});

test('a release group named after the request does not admit another anime', async () => {
  const result = await previewRequestCandidate({ requestId: 4,
    candidate: { ...candidate, title: '[Example] Fate Extra Last Encore - 01' },
    readRequest: () => request, loadDetail: async () => detail,
    prepare: async () => ({ ...prepared,
      files: [{ name: '[Example] Fate Extra Last Encore - 01.mkv', size: 1_000 }] }),
  });
  assert.deepEqual(result, { state: 'held', reason: 'release_title_mismatch' });
});

test('a second-season request accepts its AniDB alias and S02 files but not S01', async () => {
  const title = 'Itai no wa Iya nano de Bougyoryoku ni Kyokufuri Shitai to Omoimasu. 2';
  const alias = 'Bofuri: I Don`t Want to Get Hurt, So I`ll Max Out My Defense. 2';
  const second = { ...detail, anidbId: 15464, title, total: 1,
    episodes: [{ id: 260001, number: 1, type: 'Episode', title: 'First' }] };
  const selected = { ...request, anidbId: 15464, episodeIds: [260001] };
  const make = (season) => previewRequestCandidate({ requestId: 4,
    candidate: { ...candidate, title:
      `Bofuri.I.Don't.Want.to.Get.Hurt.So.I'll.Max.Out.My.Defense.S0${season}.1080p` },
    readRequest: () => selected, loadDetail: async () => second,
    releaseQueries: async () => [title, alias],
    readRelatedTitles: async () => ({ state: 'related_titles', anidbId: 15464,
      items: [{ anidbId: 14523,
        title: 'Itai no wa Iya nano de Bougyoryoku ni Kyokufuri Shitai to Omoimasu.',
        relation: 'Prequel' }] }),
    prepare: async () => ({ ...prepared, files: [{
      name: `Bofuri.S0${season}E01.mkv`, size: 1_000 }] }) });
  const yes = await make(2);
  assert.equal(yes.state, 'preflight', JSON.stringify(yes));
  assert.deepEqual(yes.episodeIds, [260001]);
  assert.equal(yes.searchQuery, alias);
  const no = await make(1);
  assert.equal(no.state, 'held');
});

test('a separately listed side story is held before it can become a preflight', async () => {
  const result = await previewRequestCandidate({ requestId: 4,
    candidate: { ...candidate, title: 'Example: Side Story - 01' },
    readRequest: () => request, loadDetail: async () => detail,
    readRelatedTitles: async () => ({ state: 'related_titles', anidbId: 42,
      items: [{ anidbId: 43, title: 'Example: Side Story', relation: 'SideStory' }] }),
    prepare: async () => ({ ...prepared,
      files: [{ name: 'Example - Side Story - 01.mkv', size: 1_000 }] }),
  });
  assert.deepEqual(result, { state: 'held', reason: 'related_installment_mismatch' });
});

test('a related installment under its English alias is held before a torrent is submitted', async () => {
  const original = { ...detail, anidbId: 461,
    title: 'Kanojo to Kanojo no Neko', total: 1,
    episodes: [{ id: 5336, number: 1, type: 'Episode', title: 'OVA' }] };
  const result = await previewRequestCandidate({ requestId: 4,
    candidate: { ...candidate,
      title: '[Commie] She and Her Cat ~Everything Flows~ - 01' },
    readRequest: () => ({ ...request, anidbId: 461, episodeIds: [5336] }),
    loadDetail: async () => original,
    releaseQueries: async () => ['She and Her Cat'],
    readRelatedTitles: async () => ({ state: 'related_titles', anidbId: 461,
      items: [{ anidbId: 11874,
        title: 'Kanojo to Kanojo no Neko: Everything Flows',
        aliases: ['She and Her Cat: Everything Flows'], relation: 'Sequel' }] }),
    prepare: async () => ({ ...prepared,
      files: [{ name: '[Commie] She and Her Cat ~Everything Flows~ - 01.mkv',
        size: 1_000 }] }),
  });
  assert.deepEqual(result, { state: 'held', reason: 'related_installment_mismatch' });
});

test('a singularized related subtitle is held before a torrent is submitted', async () => {
  const original = { ...detail, anidbId: 461,
    title: 'Kanojo to Kanojo no Neko', total: 1,
    episodes: [{ id: 5336, number: 1, type: 'Episode', title: 'OVA' }] };
  const result = await previewRequestCandidate({ requestId: 4,
    candidate: { ...candidate,
      title: '[Draguila] Kanojo to Kanojo no Neko - Everything Flow - 01' },
    readRequest: () => ({ ...request, anidbId: 461, episodeIds: [5336] }),
    loadDetail: async () => original,
    releaseQueries: async () => ['She and Her Cat'],
    readRelatedTitles: async () => ({ state: 'related_titles', anidbId: 461,
      items: [{ anidbId: 11874,
        title: 'Kanojo to Kanojo no Neko: Everything Flows',
        aliases: ['She and Her Cat: Everything Flows'], relation: 'Sequel' }] }),
    prepare: async () => ({ ...prepared,
      files: [{ name: '[Draguila] Kanojo to Kanojo no Neko - Everything Flow - 01.mkv',
        size: 1_000 }] }),
  });
  assert.deepEqual(result, { state: 'held', reason: 'related_installment_mismatch' });
});

test('an unnumbered one-episode series remains provisional before exact AniDB admission', async () => {
  const single = { ...detail, total: 1,
    episodes: [detail.episodes[0]] };
  const result = await previewRequestCandidate({ requestId: 4, candidate,
    readRequest: () => ({ ...request, episodeIds: [1001] }),
    loadDetail: async () => single,
    prepare: async () => ({ ...prepared,
      files: [{ name: '[Group] Example (2005).mkv', size: 1_000 }] }),
  });
  assert.equal(result.state, 'preflight');
  assert.deepEqual(result.episodeIds, [1001]);
  assert.deepEqual(result.files[0].episodeIds, [1001]);
  assert.equal(result.registeredInAniDb, false);
  assert.equal(result.downloadStarted, false);
});

test('an alias-only hit is revalidated through a trusted same-anime title', async () => {
  const queries = [];
  const result = await previewRequestCandidate({ requestId: 4, candidate,
    readRequest: () => request, loadDetail: async () => detail,
    releaseQueries: async ({ anidbId }) => {
      assert.equal(anidbId, 42);
      return ['English Alias'];
    },
    pause: async () => {},
    prepare: async ({ query }) => {
      queries.push(query);
      return query === 'English Alias' ? prepared :
        { state: 'held', reason: 'candidate_changed' };
    },
  });
  assert.deepEqual(queries, ['Example', 'English Alias']);
  assert.equal(result.state, 'preflight');
  assert.equal(result.searchQuery, 'English Alias');
  assert.equal(result.identityTitle, undefined);
});

test('a long canonical title preflights only its verified short alias', async () => {
  const queries = [];
  const aliasCandidate = { ...candidate,
    title: 'Short Alias - 01' };
  const result = await previewRequestCandidate({ requestId: 4,
    candidate: aliasCandidate, readRequest: () => request,
    loadDetail: async () => ({ ...detail, title: 'L'.repeat(121) }),
    releaseQueries: async ({ anidbId }) => {
      assert.equal(anidbId, 42);
      return ['Short Alias'];
    },
    prepare: async ({ query }) => {
      queries.push(query);
      return { ...prepared, files: [{ name: 'Short Alias - 01.mkv', size: 1_000 }] };
    },
  });
  assert.deepEqual(queries, ['Short Alias']);
  assert.equal(result.state, 'preflight');
  assert.equal(result.searchQuery, 'Short Alias');
  assert.deepEqual(result.episodeIds, [1001]);
});

test('a long canonical title without a verified short alias cannot fetch a torrent', async () => {
  let providerCalls = 0;
  const result = await previewRequestCandidate({ requestId: 4,
    candidate, readRequest: () => request,
    loadDetail: async () => ({ ...detail, title: 'L'.repeat(121) }),
    releaseQueries: async () => ['X', 'Y'.repeat(121)],
    prepare: async () => { providerCalls++; return prepared; },
  });
  assert.deepEqual(result, { state: 'held', reason: 'release_title_mismatch' });
  assert.equal(providerCalls, 0);
});

test('preflight labels passive extras as exclusions, not episode evidence', async () => {
  const result = await previewRequestCandidate({ requestId: 4, candidate,
    readRequest: () => request, loadDetail: async () => detail,
    prepare: async () => ({ ...prepared, files: [...prepared.files,
      { name: 'Example/readme.nfo', size: 20 },
      { name: 'Example/cover.jpg', size: 100 },
      { name: 'Example/01.ass', size: 80 }] }),
  });
  assert.equal(result.state, 'preflight');
  assert.deepEqual(result.episodeIds, [1001]);
  assert.deepEqual(result.subtitles, [{ name: 'Example/01.ass', size: 80 }]);
  assert.deepEqual(result.filesToExclude, [
    { name: 'Example/readme.nfo', size: 20 },
    { name: 'Example/cover.jpg', size: 100 },
  ]);
});

test('changed request or catalogue blocks before torrent-byte retrieval', async () => {
  let calls = 0;
  for (const change of [{ request: null },
    { request: { ...request, status: 'cancelled' } },
    { detail: { ...detail, restricted: null } },
    { detail: { ...detail, episodes: detail.episodes.slice(1), total: 1 } }]) {
    const result = await previewRequestCandidate({ requestId: 4, candidate,
      readRequest: () => change.request === undefined ? request : change.request,
      loadDetail: async () => change.detail ?? detail,
      prepare: async () => { calls++; return prepared; } });
    assert.equal(result.state, 'held');
  }
  assert.equal(calls, 0);
});

test('real metainfo path reads only Prowlarr and never submits the prepared form', async () => {
  const info = Buffer.from('d6:lengthi1000e4:name11:Example.mkv12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae');
  const torrent = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
  const movieCandidate = { guid: 'release-1', indexerId: 3,
    title: 'Example Movie', size: 1000 };
  const proxy = 'http://prowlarr.internal:9696/3/download?apikey=syntheticKey&link=abc123&file=Example';
  const calls = [];
  const result = await previewRequestCandidate({ requestId: 4,
    candidate: movieCandidate,
    readRequest: () => ({ ...request, kind: 'movie', episodeIds: [1001] }),
    loadDetail: async () => ({ ...detail, kind: 'movie' }),
    prepare: (input) => prepareStoppedCandidate({
      baseUrl: 'http://prowlarr.internal:9696/', apiKey: 'syntheticKey',
      indexerIds: [3], ...input,
      fetchImpl: async (url) => {
        calls.push(new URL(url).pathname);
        return calls.length === 1
          ? Response.json([{ ...movieCandidate, protocol: 'torrent', downloadUrl: proxy }])
          : new Response(torrent, { headers: { 'content-type': 'application/x-bittorrent' } });
      },
    }),
  });
  assert.deepEqual(calls, ['/api/v1/search', '/3/download']);
  assert.equal(result.state, 'preflight');
  assert.equal(result.torrentHash, createHash('sha1').update(info).digest('hex'));
  assert.equal(result.downloadStarted, false);
  assert.equal(result.registeredInAniDb, false);
  assert.equal(JSON.stringify(result).includes('form'), false);
});

test('complete absolute packs treat a consistent same-anime preview shift as uncertain, never registered', async()=>{
 for(const [count,start]of [[4,25],[6,101]]){
  const episodes=Array.from({length:count},(_,i)=>({id:1001+i,number:i+1,type:'Episode',title:'Episode '+(i+1)}));
  const files=episodes.map((ep,i)=>({name:`Example - ${start+i}.mkv`,size:1000}));
  const result=await previewRequestCandidate({requestId:4,candidate:{...candidate,title:'Example Season 2'},
   readRequest:()=>({...request,episodeIds:episodes.map(e=>e.id)}),
   readRelatedTitles:async({anidbId})=>({state:'related_titles',anidbId,items:anidbId===42?[{anidbId:43,title:'Earlier Example',relation:'prequel'}]:[]}),
   loadDetail:async({anidbId})=>anidbId===42?({...detail,total:count,episodes}):({...detail,anidbId:43,title:'Earlier Example',total:start-1,episodes:Array.from({length:start-1},(_,i)=>({id:5001+i,number:i+1,type:'Episode',title:'Earlier '+(i+1)}))}),
   prepare:async()=>({...prepared,totalBytes:count*1000,files}),
   offlineLookup:async({filename})=>{const number=Number(/- (\d+)/.exec(filename)[1])-start+1-2;return{status:200,release:{ProviderName:'Offline Importer',IsCorrupted:false,OriginalFilename:filename,
    ID:number>0?`offline://42-${1000+number}`:null,CrossReferences:number>0?[{AnidbAnimeID:42,AnidbEpisodeID:1000+number,PercentageStart:0,PercentageEnd:100}]:[]}};}});
  assert.equal(result.state,'preflight',JSON.stringify(result));assert.equal(result.shokoPreview,'uncertain');assert.equal(result.shokoPreviewConflict,'absolute_number_offset');assert.equal(result.registeredInAniDb,false);
  assert.deepEqual(result.files.map(f=>f.episodeIds),episodes.map(e=>[e.id]));
 }
});

test('absolute preview conflicts still reject different anime, mixed shifts and invalid evidence',async()=>{
 const episodes=Array.from({length:4},(_,i)=>({id:1001+i,number:i+1,type:'Episode',title:'Episode '+(i+1)}));
 for(const mode of ['different_anime','mixed_shift','wrong_filename','unknown_episode','special_episode','single_prediction']){
 const result=await previewRequestCandidate({requestId:4,candidate:{...candidate,title:'Example Season 2'},
  readRequest:()=>({...request,episodeIds:episodes.map(e=>e.id)}),loadDetail:async()=>({...detail,total:mode==='special_episode'?5:4,episodes:mode==='special_episode'?[...episodes,{id:2001,number:1,type:'Special',title:'Special'}]:episodes}),
  prepare:async()=>({...prepared,totalBytes:4000,files:episodes.map((e,i)=>({name:`Example - ${25+i}.mkv`,size:1000}))}),
  offlineLookup:async({filename})=>{const n=Number(/- (\d+)/.exec(filename)[1])-24;if(mode==='single_prediction'&&n<4)return{status:200,release:{CrossReferences:[]}};const id=mode==='unknown_episode'?9999:mode==='special_episode'?2001:1000+(mode==='mixed_shift'&&n===4?2:Math.max(1,n-2));const anime=mode==='different_anime'?43:42;return{status:200,release:{ProviderName:'Offline Importer',IsCorrupted:false,OriginalFilename:mode==='wrong_filename'?'Other.mkv':filename,ID:`offline://${anime}-${id}`,CrossReferences:[{AnidbAnimeID:anime,AnidbEpisodeID:id,PercentageStart:0,PercentageEnd:100}]}};}});
 assert.equal(result.state,'held',mode);assert.equal(result.reason,'shoko_preview_wrong_identity',mode);
 }
});


test('a first installment cannot infer an absolute offset from count and base title alone', async()=>{
 const ids=Array.from({length:12},(_,i)=>1001+i);
 const first={...detail,total:12,episodes:ids.map((id,i)=>({id,number:i+1,type:'Episode',title:'Episode '+(i+1)}))};
 const result=await previewRequestCandidate({requestId:4,candidate:{...candidate,title:'Example 13-24 Complete Batch WEB 1080p',size:12000},
 readRequest:()=>({...request,episodeIds:ids}),loadDetail:async()=>first,
 readRelatedTitles:async()=>({state:'related_titles',anidbId:42,items:[{anidbId:43,title:'Example Second Season',relation:'sequel'}]}),
 prepare:async()=>({...prepared,totalBytes:12000,files:ids.map((_,i)=>({name:'Example - '+(13+i)+'.mkv',size:1000}))}),
 offlineLookup:async()=>({status:200,release:{CrossReferences:[]}})});
 assert.equal(result.state,'held');assert.equal(result.reason,'absolute_numbering_unverified');
});

test('optional pack bonuses have their own identity while ambiguous extras do not block the season',async()=>{
 const meta={...detail,total:3,episodes:[...detail.episodes,{id:2001,number:1,type:'Special',title:'OVA'}]};
 const files=[...prepared.files,{name:'Extras/Example OVA 1.mkv',size:5},{name:'Extras/Unknown OVA 2.mkv',size:5}];
 const result=await previewRequestCandidate({requestId:4,candidate,readRequest:()=>request,loadDetail:async()=>meta,
  readVideoExtensions:async()=>({state:'extensions',values:['.mkv']}),readBonusOwnership:async()=>({state:'missing'}),
  prepare:async()=>({...prepared,files}),offlineLookup:async({filename})=>filename.includes('Unknown')?{status:204}:{status:200,release:{ProviderName:'Offline Importer',IsCorrupted:false,OriginalFilename:filename,ID:`offline://42-${filename.includes('OVA')?2001:1001}`,CrossReferences:[{AnidbAnimeID:42,AnidbEpisodeID:filename.includes('OVA')?2001:1001,PercentageStart:0,PercentageEnd:100}]}}});
 assert.equal(result.state,'preflight',JSON.stringify(result));assert.deepEqual(result.episodeIds,[1001]);assert.equal(result.files.length,1);assert.equal(result.bonusFiles.length,1);assert.equal(result.bonusFiles[0].anidbId,42);assert.deepEqual(result.bonusFiles[0].episodeIds,[2001]);assert.equal(result.skippedBonuses[0].name,'Extras/Unknown OVA 2.mkv');
});

test('a complete requested OVA pack survives bonus-looking regular filenames',async()=>{const meta={...detail,format:'OVA'};const result=await previewRequestCandidate({requestId:4,candidate:{...candidate,title:'Example OVA Complete Batch'},readRequest:()=>request,loadDetail:async()=>meta,readVideoExtensions:async()=>({state:'extensions',values:['.mkv']}),readBonusOwnership:async()=>{throw Error('main episodes are not bonuses')},prepare:async()=>({...prepared,totalBytes:2000,files:[{name:'Example OVA 01.mkv',size:1000},{name:'Example OVA 02.mkv',size:1000}]}),offlineLookup:async({filename})=>({status:200,release:{ProviderName:'Offline Importer',IsCorrupted:false,OriginalFilename:filename,ID:'offline://42-'+(filename.includes('01')?1001:1002),CrossReferences:[{AnidbAnimeID:42,AnidbEpisodeID:filename.includes('01')?1001:1002,PercentageStart:0,PercentageEnd:100}]}})});assert.equal(result.state,'preflight',JSON.stringify(result));assert.deepEqual(result.episodeIds,[1001,1002]);assert.equal(result.files.length,2);assert.equal(result.bonusFiles,undefined);});
