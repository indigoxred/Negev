import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcquisitionRequestProcessor } from
  '../src/acquisition/acquisition-request-processor.mjs';

const request = { id: 4, anidbId: 42, kind: 'series', status: 'held',
  episodeIds: [1001, 1002] };
const candidate = (n) => ({ indexerId: 7, guid: `candidate-${n}`,
  title: `Example - 0${n}`, size: 1000, evidence: 'unverified' });
const detail = { state: 'details', complete: true, total: 2, anidbId: 42,
  title: 'Example', kind: 'series', restricted: false,
  episodes: [{ id: 1001, number: 1, type: 'Episode' },
    { id: 1002, number: 2, type: 'Episode' }] };
const preflight = { state: 'preflight', requestId: 4, anidbId: 42,
  torrentHash: 'a'.repeat(40), episodeIds: [1001],
  files: [{ name: 'Example - 01.mkv', size: 1000, episodeIds: [1001] }] };

test('bounded automatic path skips unsafe preflight and submits one exact stopped candidate', async () => {
  const inspected = [];
  const submitted = [];
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates',
      requestId: 4, anidbId: 42,
      items: [candidate(1), candidate(2), candidate(3)] }),
    previewCandidate: async ({ candidate: selected }) => {
      inspected.push(selected.guid);
      return selected.guid === 'candidate-1'
        ? { state: 'held', reason: 'ambiguous_or_unrequested_video' }
        : preflight;
    },
    loadDetail: async () => detail,
    submitCandidate: async (input) => {
      submitted.push(input);
      return { state: 'stopped_observed', attemptId: 11 };
    },
  });
  assert.deepEqual(await process({ requestId: 4 }),
    { state: 'stopped_observed', attemptId: 11 });
  assert.deepEqual(inspected, ['candidate-1', 'candidate-2']);
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0], { request, candidate: candidate(2), detail,
    episodeIds: [1001], plannedFiles: preflight.files,
    expectedHash: preflight.torrentHash });
});

test('unsafe or malformed release observations never reach stopped submission', async () => {
  for (const found of [
    { state: 'held', reason: 'release_search_unavailable' },
    { state: 'candidates', requestId: 4, anidbId: 99, items: [candidate(1)] },
    { state: 'candidates', requestId: 4, anidbId: 42, items: [] },
  ]) {
    let submits = 0;
    const process = createAcquisitionRequestProcessor({
      readRequest: () => request, discoverCandidates: async () => found,
      previewCandidate: async () => preflight, loadDetail: async () => detail,
      submitCandidate: async () => { submits++; },
    });
    assert.equal((await process({ requestId: 4 })).state, 'held');
    assert.equal(submits, 0);
  }
});

test('an unsafe changed catalogue or preflight identity cannot submit', async () => {
  for (const change of [
    { preview: { ...preflight, anidbId: 99 } },
    { preview: { ...preflight, episodeIds: [9999] } },
    { detail: { ...detail, restricted: true } },
    { detail: { ...detail, episodes: detail.episodes.slice(1), total: 1 } },
    { detail: { ...detail, episodes: [
      { ...detail.episodes[0], number: 2 },
      { ...detail.episodes[1], number: 1 },
    ] } },
  ]) {
    let submits = 0;
    const process = createAcquisitionRequestProcessor({
      readRequest: () => request,
      discoverCandidates: async () => ({ state: 'candidates',
        requestId: 4, anidbId: 42, items: [candidate(1)] }),
      previewCandidate: async () => change.preview ?? preflight,
      loadDetail: async () => change.detail ?? detail,
      submitCandidate: async () => { submits++; },
    });
    assert.equal((await process({ requestId: 4 })).state, 'held');
    assert.equal(submits, 0);
  }
});
