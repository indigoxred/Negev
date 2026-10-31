import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestCandidateDiscovery } from '../src/acquisition/request-candidate-discovery.mjs';

const request = { id: 12, requesterId: 1, anidbId: 1234, kind: 'series',
  episodeIds: [1001], status: 'held' };
const detail = { state: 'details', anidbId: 1234, page: 1, total: 1,
  title: 'Canonical Anime', kind: 'series', restricted: false,
  complete: true, nextPage: null,
  episodes: [{ id: 1001, number: 1, type: 'Episode', title: 'First' }] };

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
    items: [{ guid: 'candidate-1', title: 'Canonical Anime 01', evidence: 'unverified' }],
    exhaustive: false,
  });
  assert.deepEqual(queries, [{ query: 'Canonical Anime' }]);
});

test('does not search for missing, changed, restricted or incomplete identity', async () => {
  for (const [existing, observation, reason] of [
    [null, detail, 'request_missing'],
    [request, { ...detail, anidbId: 9999 }, 'detail_unavailable'],
    [request, { ...detail, kind: 'movie' }, 'identity_changed'],
    [request, { ...detail, restricted: true }, 'restricted_or_unverified'],
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
