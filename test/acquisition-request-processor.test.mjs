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

test('an alias preflight passes its query to the guarded stopped submission', async () => {
  let selected;
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates',
      requestId: 4, anidbId: 42, items: [candidate(1)] }),
    previewCandidate: async () => ({ ...preflight,
      searchQuery: 'Official English' }),
    loadDetail: async () => detail,
    submitCandidate: async (input) => {
      selected = input;
      return { state: 'stopped_observed', attemptId: 11 };
    },
  });
  assert.equal((await process({ requestId: 4 })).state, 'stopped_observed');
  assert.equal(selected.searchQuery, 'Official English');
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

test('later candidate batches can reach a fourth release without rechecking the first three', async () => {
  const seen = [];
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates',
      requestId: 4, anidbId: 42,
      items: [candidate(1), candidate(2), candidate(3), candidate(4)] }),
    previewCandidate: async ({ candidate: item }) => {
      seen.push(item.guid);
      return item.guid === 'candidate-4' ? preflight :
        { state: 'held', reason: 'unsafe_or_unselected_file' };
    },
    loadDetail: async () => detail,
    submitCandidate: async () => ({ state: 'stopped_observed', attemptId: 12 }),
  });
  const first = await process({ requestId: 4 });
  assert.equal(first.state, 'held');
  assert.equal(first.reason, 'no_safe_release');
  assert.equal(first.nextCandidateOffset, 3);
  assert.match(first.nextCandidateFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(await process({ requestId: 4, candidateOffset: 3,
    candidateFingerprint: first.nextCandidateFingerprint }),
    { state: 'stopped_observed', attemptId: 12 });
  assert.deepEqual(seen, ['candidate-1', 'candidate-2',
    'candidate-3', 'candidate-4']);
});

test('changed search order invalidates the saved candidate position', async () => {
  let order = [candidate(1), candidate(2), candidate(3), candidate(4)];
  const seen = [];
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: order }),
    previewCandidate: async ({ candidate: item }) => {
      seen.push(item.guid);
      return item.guid === 'candidate-4' ? preflight :
        { state: 'held', reason: 'unsafe_or_unselected_file' };
    },
    loadDetail: async () => detail,
    submitCandidate: async () => ({ state: 'stopped_observed', attemptId: 12 }),
  });
  const first = await process({ requestId: 4 });
  assert.equal(first.nextCandidateOffset, 3);
  order = [candidate(4), candidate(1), candidate(2), candidate(3)];
  assert.equal((await process({ requestId: 4,
    candidateOffset: first.nextCandidateOffset,
    candidateFingerprint: first.nextCandidateFingerprint })).state,
  'stopped_observed');
  assert.deepEqual(seen, ['candidate-1', 'candidate-2',
    'candidate-3', 'candidate-4']);
});

test('a newly aired target invalidates the saved candidate position', async () => {
  let requestedIds = [1001];
  const seen = [];
  const process = createAcquisitionRequestProcessor({
    maxPreflights: 1,
    readRequest: () => ({ ...request, episodeIds: requestedIds }),
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: [candidate(1), candidate(2)] }),
    previewCandidate: async ({ candidate: item }) => {
      seen.push(item.guid);
      return requestedIds.includes(1002) && item.guid === 'candidate-1'
        ? { ...preflight, episodeIds: [1002],
          files: [{ name: 'Example - 02.mkv', size: 1000,
            episodeIds: [1002] }] }
        : { state: 'held', reason: 'no_matching_episode' };
    },
    loadDetail: async () => detail,
    submitCandidate: async () => ({ state: 'stopped_observed', attemptId: 12 }),
  });
  const first = await process({ requestId: 4 });
  assert.equal(first.nextCandidateOffset, 1);
  requestedIds = [1001, 1002];
  assert.deepEqual(await process({ requestId: 4,
    candidateOffset: first.nextCandidateOffset,
    candidateFingerprint: first.nextCandidateFingerprint }),
  { state: 'stopped_observed', attemptId: 12 });
  assert.deepEqual(seen, ['candidate-1', 'candidate-1']);
});

test('fully verified public coverage skips repeat indexer searches', async () => {
  const calls = [];
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    readPublicCoverage: () => {
      calls.push('coverage');
      return { verifiedTargets: 2, targetCount: 2 };
    },
    discoverCandidates: async () => { throw Error('indexer was queried'); },
    previewCandidate: async () => { throw Error('preview was queried'); },
    loadDetail: async () => { throw Error('detail was queried'); },
    submitCandidate: async () => { throw Error('torrent was submitted'); },
  });
  assert.deepEqual(await process({ requestId: 4, candidateOffset: 3 }),
    { state: 'held', reason: 'target_already_available',
      nextCandidateOffset: 0 });
  assert.deepEqual(calls, ['coverage']);
});

test('partial public coverage still searches for missing requested episodes', async () => {
  let searches = 0;
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    readPublicCoverage: () => ({ verifiedTargets: 1, targetCount: 2 }),
    discoverCandidates: async () => { searches++;
      return { state: 'candidates', requestId: 4, anidbId: 42, items: [] }; },
    previewCandidate: async () => { throw Error('no candidate'); },
    loadDetail: async () => { throw Error('no detail'); },
    submitCandidate: async () => { throw Error('no submission'); },
  });
  assert.equal((await process({ requestId: 4 })).reason, 'no_release_candidates');
  assert.equal(searches, 1);
});

test('an already playable first candidate does not hide a later missing episode', async () => {
  const seen = [];
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: [candidate(1), candidate(2)] }),
    previewCandidate: async ({ candidate: item }) => {
      seen.push(item.guid);
      return item.guid === 'candidate-1' ? preflight : {
        ...preflight, episodeIds: [1002],
        files: [{ name: 'Example - 02.mkv', size: 1000, episodeIds: [1002] }],
      };
    },
    loadDetail: async () => detail,
    submitCandidate: async ({ candidate: item }) => item.guid === 'candidate-1'
      ? { state: 'held', reason: 'target_already_available' }
      : { state: 'stopped_observed', attemptId: 12 },
  });
  const first = await process({ requestId: 4 });
  assert.equal(first.reason, 'target_already_available');
  assert.equal(first.nextCandidateOffset, 1);
  assert.deepEqual(await process({ requestId: 4, candidateOffset: 1,
    candidateFingerprint: first.nextCandidateFingerprint }),
    { state: 'stopped_observed', attemptId: 12 });
  assert.deepEqual(seen, ['candidate-1', 'candidate-2']);
});

test('a terminally rejected release yields to a later eligible release', async () => {
  const submitted = [];
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates',
      requestId: 4, anidbId: 42, items: [candidate(1), candidate(2)] }),
    previewCandidate: async () => preflight,
    loadDetail: async () => detail,
    submitCandidate: async ({ candidate: selected }) => {
      submitted.push(selected.guid);
      return selected.guid === 'candidate-1'
        ? { state: 'held', reason: 'candidate_rejected' }
        : { state: 'stopped_observed', attemptId: 12 };
    },
  });
  const first = await process({ requestId: 4 });
  assert.equal(first.reason, 'candidate_rejected');
  assert.equal(first.nextCandidateOffset, 1);
  assert.deepEqual(await process({ requestId: 4,
    candidateOffset: first.nextCandidateOffset,
    candidateFingerprint: first.nextCandidateFingerprint }),
  { state: 'stopped_observed', attemptId: 12 });
  assert.deepEqual(submitted, ['candidate-1', 'candidate-2']);
});

test('an uncertain first-time attempt does not advance to another release', async () => {
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates',
      requestId: 4, anidbId: 42, items: [candidate(1), candidate(2)] }),
    previewCandidate: async () => preflight,
    loadDetail: async () => detail,
    submitCandidate: async () => ({ state: 'held',
      reason: 'uncertain_attempt_exhausted' }),
  });
  assert.deepEqual(await process({ requestId: 4 }),
    { state: 'held', reason: 'uncertain_attempt_exhausted' });
});

test('an import awaiting Plex does not hide a later missing episode candidate', async () => {
  const seen = [];
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: [candidate(1), candidate(2)] }),
    previewCandidate: async ({ candidate: item }) => {
      seen.push(item.guid);
      return item.guid === 'candidate-1' ? preflight : {
        ...preflight, episodeIds: [1002],
        files: [{ name: 'Example - 02.mkv', size: 1000, episodeIds: [1002] }],
      };
    },
    loadDetail: async () => detail,
    submitCandidate: async ({ candidate: item }) => item.guid === 'candidate-1'
      ? { state: 'held', reason: 'target_not_proven_missing', episodeId: 1001 }
      : { state: 'stopped_observed', attemptId: 12 },
  });
  const first = await process({ requestId: 4 });
  assert.equal(first.reason, 'target_not_proven_missing');
  assert.equal(first.nextCandidateOffset, 1);
  assert.deepEqual(await process({ requestId: 4, candidateOffset: 1,
    candidateFingerprint: first.nextCandidateFingerprint }),
    { state: 'stopped_observed', attemptId: 12 });
  assert.deepEqual(seen, ['candidate-1', 'candidate-2']);
});
