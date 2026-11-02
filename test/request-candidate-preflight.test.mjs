import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { previewRequestCandidate } from '../src/acquisition/request-candidate-preflight.mjs';
import { prepareStoppedCandidate } from '../src/acquisition/prepare-stopped-candidate.mjs';

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
    { detail: { ...detail, restricted: true } },
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
