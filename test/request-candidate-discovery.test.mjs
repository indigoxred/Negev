import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestCandidateDiscovery } from '../src/acquisition/request-candidate-discovery.mjs';

const request = { id: 12, requesterId: 1, anidbId: 1234, kind: 'series',
  episodeIds: [1001], status: 'held' };
const detail = { state: 'details', anidbId: 1234, page: 1, total: 1,
  title: 'Canonical Anime', kind: 'series', restricted: false,
  complete: true, nextPage: null,
  episodes: [{ id: 1001, number: 1, type: 'Episode', title: 'First' }] };

test('marks a historically completed series for full-season preference', async () => {
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request,
    loadDetail: async () => ({ ...detail, airDate: '2016-04-05',
      endDate: '2016-06-28' }),
    searchReleases: async () => ({ state: 'candidates', items: [] }),
  });
  assert.equal((await discover({ requestId: 12 })).releaseState, 'completed');
});

test('discovers candidates for an existing exact request without authorizing them', async () => {
  const queries = [];
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request,
    loadDetail: async () => detail,
    searchReleases: async (input) => { queries.push(input); return { state: 'candidates', items: [
      { guid: 'candidate-1', title: 'Canonical Anime 01', evidence: 'unverified' }] }; },
  });
  assert.deepEqual(await discover({ requestId: 12 }), {
    state: 'candidates', requestId: 12, anidbId: 1234,
    items: [{ guid: 'candidate-1', title: 'Canonical Anime 01',
      evidence: 'unverified', sourceQuery: 'Canonical Anime' }],
    exhaustive: false,
  });
  assert.deepEqual(queries, [{ query: 'Canonical Anime', targetEpisodeNumber: null }]);
});

test('a failed alias search marks a surviving candidate set incomplete', async () => {
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request, loadDetail: async () => detail,
    releaseQueries: async () => ['Official English'],
    pause: async () => {},
    searchReleases: async ({ query }) => query === 'Official English'
      ? { state: 'unavailable' }
      : { state: 'candidates', items: [{
        indexerId: 7, guid: 'low-quality',
        title: 'Canonical Anime - 01 720p',
        evidence: 'unverified' }] },
  });
  const found = await discover({ requestId: 12 });
  assert.equal(found.state, 'candidates');
  assert.equal(found.searchIncomplete, true);
  assert.deepEqual(found.failedQueries, ['Official English']);
});

test('an empty partial search reports provider uncertainty, not no releases', async () => {
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request, loadDetail: async () => detail,
    releaseQueries: async () => ['Official English'], pause: async () => {},
    searchReleases: async ({ query }) => query === 'Official English'
      ? { state: 'unavailable' } : { state: 'candidates', items: [] },
  });
  assert.deepEqual(await discover({ requestId: 12 }), {
    state: 'held', reason: 'release_search_incomplete',
  });
});

test('a catalogue year does not hide same-title Airing releases', async () => {
  const queries = [];
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request,
    loadDetail: async () => ({ ...detail, title: 'Ice Wall (2026)' }),
    pause: async () => {},
    searchReleases: async ({ query }) => {
      queries.push(query);
      return { state: 'candidates', items: query === 'Ice Wall'
        ? [{ indexerId: 7, guid: 'episode', title: 'Ice Wall S02E01',
          evidence: 'unverified' }] : [] };
    },
  });
  const result = await discover({ requestId: 12 });
  assert.deepEqual(queries, ['Ice Wall (2026)', 'Ice Wall']);
  assert.deepEqual(result.items.map((item) => item.guid), ['episode']);
});

test('a missing episode search reaches older releases without losing title aliases', async () => {
  const queries = [];
  const targetNumbers = [];
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request, loadDetail: async () => detail,
    releaseQueries: async () => ['Official English'],
    pause: async () => {},
    searchReleases: async ({ query, targetEpisodeNumber }) => {
      queries.push(query);
      targetNumbers.push(targetEpisodeNumber);
      return { state: 'candidates', items: Array.from({ length: 25 }, (_, i) => ({
        indexerId: 7, guid: `${query}-${i}`,
        title: query === 'Canonical Anime 01'
          ? `Canonical Anime - ${i === 1 ? '08' : '01'} WEB 1080p release ${i}`
          : `${query} release ${i}`,
        evidence: 'unverified' })) };
    },
  });
  const found = await discover({ requestId: 12, searchTargetEpisodeId: 1001 });
  assert.deepEqual(queries, ['Canonical Anime 01', 'Official English 01',
    'Canonical Anime', 'Official English']);
  assert.deepEqual(targetNumbers, [1, 1, null, null]);
  assert.equal(found.items.length, 50);
  for (const query of queries) {
    assert.ok(found.items.some((item) => item.sourceQuery === query));
  }
  assert.ok(found.items[0].title.startsWith('Canonical Anime - 01'));
  assert.equal(found.items[0].targetedEpisode, true);
  assert.equal(found.items.find((item) => item.guid === 'Canonical Anime 01-1')
    .targetedEpisode, false);
  assert.equal(found.items[0].sourceQuery, 'Canonical Anime 01');
  assert.equal(found.items[0].targetEpisodeId, 1001);
  assert.equal(found.items.find((item) =>
    item.title.startsWith('Canonical Anime release')).targetedEpisode, undefined);
  assert.equal(found.items.find((item) =>
    item.title.startsWith('Official English release')).sourceQuery,
  'Official English');
});

test('one airing search checks every bounded missing episode before reporting no releases', async () => {
  const searches = [];
  const multiRequest = { ...request, episodeIds: [1001, 1002, 1003] };
  const multiDetail = { ...detail, total: 3, episodes: [
    { id: 1001, number: 1, type: 'Episode', title: 'First' },
    { id: 1002, number: 2, type: 'Episode', title: 'Second' },
    { id: 1003, number: 3, type: 'Episode', title: 'Third' },
  ] };
  const discover = createRequestCandidateDiscovery({
    readRequest: () => multiRequest, loadDetail: async () => multiDetail,
    pause: async () => {},
    searchReleases: async ({ query, targetEpisodeNumber }) => {
      searches.push([query, targetEpisodeNumber]);
      return { state: 'candidates', items: query === 'Canonical Anime 03'
        ? [{ indexerId: 7, guid: 'third-episode',
          title: 'Canonical Anime - 03 1080p', evidence: 'unverified' }] : [] };
    },
  });
  const found = await discover({ requestId: 12,
    searchTargetEpisodeIds: [1001, 1002, 1003] });
  assert.equal(found.state, 'candidates', JSON.stringify(found));
  assert.deepEqual(searches.slice(0, 3), [
    ['Canonical Anime 01', 1], ['Canonical Anime 02', 2],
    ['Canonical Anime 03', 3]]);
  assert.equal(found.items[0].guid, 'third-episode');
  assert.equal(found.items[0].targetEpisodeId, 1003);
});

test('a long official title searches its short main title for the exact episode', async () => {
  const japanese = 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu';
  const longTitle = `${japanese}: ${'Long subtitle '.repeat(12)}`;
  const queries = [];
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request,
    loadDetail: async () => ({ ...detail, title: longTitle }),
    releaseQueries: async () => ['Magic Repo Man'],
    pause: async () => {},
    searchReleases: async ({ query }) => {
      queries.push(query);
      return { state: 'candidates', items: query === `${japanese} 01` ?
        [{ indexerId: 7, guid: 'strong-1080',
          title: '[Group] Kashita Maryoku wa Revo Barai de Kyousei Choushuu - 01 1080p',
          seeders: 239, evidence: 'unverified' }] : [] };
    },
  });
  const found = await discover({ requestId: 12, searchTargetEpisodeId: 1001 });
  assert.equal(queries[0], `${japanese} 01`);
  assert.equal(found.items[0].guid, 'strong-1080');
  assert.equal(found.items[0].targetEpisodeId, 1001);
  assert.equal(found.items[0].targetedEpisode, true);
});

test('a punctuation-tolerant same-title query finds seeded 1080p when the exact prefix misses it', async () => {
  const japanese = 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu';
  const longTitle = `${japanese}: ${'Long subtitle '.repeat(12)}`;
  const searches = [];
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request,
    loadDetail: async () => ({ ...detail, title: longTitle }),
    releaseQueries: async () => ['Magic Repo Man'],
    pause: async () => {},
    searchReleases: async ({ query }) => {
      searches.push(query);
      return { state: 'candidates', items:
        query === 'Kashita Maryoku wa 01'
          ? [{ indexerId: 7, guid: 'seeded-1080',
            title: '[SubsPlease] Kashita Maryoku wa Revo Barai de Kyousei Choushuu - 01 (1080p)',
            seeders: 239, evidence: 'unverified' }]
          : query === `${japanese} 01`
            ? [{ indexerId: 7, guid: 'weak-480',
              title: '[SubsPlease] Kashita Maryoku wa Revo Barai de Kyousei Choushuu - 01 (480p)',
              seeders: 1, evidence: 'unverified' }]
            : [] };
    },
  });
  const found = await discover({ requestId: 12, searchTargetEpisodeId: 1001 });
  assert.ok(searches.includes('Kashita Maryoku wa 01'));
  assert.ok(found.items.some((item) => item.guid === 'seeded-1080' &&
    item.targetEpisodeId === 1001 && item.targetedEpisode === true));
});

test('a broad result naming the exact episode gets the same target priority', async () => {
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request, loadDetail: async () => detail,
    pause: async () => {},
    searchReleases: async ({ query }) => ({ state: 'candidates', items:
      query === 'Canonical Anime 01'
        ? [{ indexerId: 7, guid: 'weak',
          title: 'Canonical Anime - 01 WEB 720p', seeders: 1,
          evidence: 'unverified' }]
        : [{ indexerId: 7, guid: 'strong',
          title: 'Canonical Anime - 01 WEB 1080p', seeders: 100,
          evidence: 'unverified' }] }),
  });
  const found = await discover({ requestId: 12,
    searchTargetEpisodeId: 1001 });
  assert.equal(found.items.find((item) => item.guid === 'strong')
    .targetedEpisode, true);
  assert.equal(found.items.find((item) => item.guid === 'strong')
    .sourceQuery, 'Canonical Anime');
});

test('an episode search cannot use a target outside the saved request', async () => {
  let searches = 0;
  const discover = createRequestCandidateDiscovery({ readRequest: () => request,
    loadDetail: async () => detail,
    searchReleases: async () => { searches++; return { state: 'candidates', items: [] }; } });
  assert.deepEqual(await discover({ requestId: 12, searchTargetEpisodeId: 9999 }),
    { state: 'held', reason: 'invalid_request' });
  assert.equal(searches, 0);
});

test('does not search for missing, changed, restricted or incomplete identity', async () => {
  for (const [existing, observation, reason] of [
    [null, detail, 'request_missing'],
    [request, { ...detail, anidbId: 9999 }, 'detail_unavailable'],
    [request, { ...detail, kind: 'movie' }, 'identity_changed'],
    [request, { ...detail, restricted: null }, 'restricted_or_unverified'],
    [request, { ...detail, episodes: [{ ...detail.episodes[0], id: 9999 }] }, 'target_missing'],
    [request, { state: 'detail_pending', anidbId: 1234 }, 'detail_unavailable'],
  ]) {
    let searches = 0;
    const discover = createRequestCandidateDiscovery({ readRequest: () => existing,
      loadDetail: async () => observation,
      searchReleases: async () => { searches++; throw Error('must not search'); } });
    assert.deepEqual(await discover({ requestId: 12 }), { state: 'held', reason });
    assert.equal(searches, 0);
  }
});

test('indexer outage and zero results never mean no release exists', async () => {
  for (const indexer of [{ state: 'unavailable' }, { state: 'candidates', items: [] }]) {
    const discover = createRequestCandidateDiscovery({ readRequest: () => request,
      loadDetail: async () => detail, searchReleases: async () => indexer });
    const result = await discover({ requestId: 12 });
    assert.equal(result.state, indexer.state === 'candidates' ? 'candidates' : 'held');
    if (result.state === 'candidates') assert.equal(result.exhaustive, false);
  }
});

test('searches verified same-ID aliases with a bounded pace and deduplicates releases', async () => {
  const queries = [];
  const waits = [];
  const shared = { indexerId: 7, guid: 'same', title: 'Shared', evidence: 'unverified' };
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request, loadDetail: async () => detail,
    releaseQueries: async ({ anidbId }) => {
      assert.equal(anidbId, 1234);
      return ['Canonical Anime', 'Official English', 'Official English',
        'x'.repeat(121)];
    },
    pause: async (ms) => { waits.push(ms); },
    searchReleases: async ({ query }) => {
      queries.push(query);
      return { state: 'candidates', items: query === 'Canonical Anime'
        ? [shared] : [shared, { indexerId: 7, guid: 'english',
          title: 'Official English 01', evidence: 'unverified' }] };
    },
  });
  const found = await discover({ requestId: 12 });
  assert.deepEqual(queries, ['Canonical Anime', 'Official English']);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(found.items.map((item) => item.guid), ['same', 'english']);
  assert.equal(found.exhaustive, false);
});

test('a long canonical title can search a short verified same-ID alias', async () => {
  const searched = [];
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request,
    loadDetail: async () => ({ ...detail, title: 'L'.repeat(121) }),
    releaseQueries: async ({ anidbId }) => {
      assert.equal(anidbId, 1234);
      return ['Short Alias'];
    },
    searchReleases: async ({ query }) => {
      searched.push(query);
      return { state: 'candidates', items: [] };
    },
  });
  assert.equal((await discover({ requestId: 12 })).state, 'candidates');
  assert.deepEqual(searched, ['Short Alias']);
});

test('a long canonical title without a valid same-ID alias never searches', async () => {
  let searches = 0;
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request,
    loadDetail: async () => ({ ...detail, title: 'L'.repeat(121) }),
    releaseQueries: async () => ['X', 'Y'.repeat(121)],
    searchReleases: async () => { searches++; return { state: 'candidates', items: [] }; },
  });
  assert.deepEqual(await discover({ requestId: 12 }),
    { state: 'held', reason: 'query_too_long' });
  assert.equal(searches, 0);
});
