import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcquisitionRequestProcessor } from
  '../src/acquisition/acquisition-request-processor.mjs';

const assertAttempt = (result, attemptId) => {
  assert.equal(result.state, 'stopped_observed');
  assert.equal(result.attemptId, attemptId);
};

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

test('rotates missing regular episode search by queue pass', async () => {
  const targeted = [];
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    readPublicCoverage: () => ({ verifiedTargets: 0, targetCount: 2,
      availableEpisodeIds: [] }),
    discoverCandidates: async ({ searchTargetEpisodeId }) => {
      targeted.push(searchTargetEpisodeId);
      return { state: 'candidates', requestId: 4, anidbId: 42, items: [] };
    },
    previewCandidate: async () => { throw Error('no candidate'); },
    loadDetail: async () => detail,
    submitCandidate: async () => { throw Error('no candidate'); },
  });
  assert.equal((await process({ requestId: 4, pass: 1 })).reason, 'no_release_candidates');
  assert.equal((await process({ requestId: 4, pass: 2 })).reason, 'no_release_candidates');
  assert.deepEqual(targeted, [1001, 1002]);
});

test('preflights a more seeded release first without weakening exact checks', async () => {
  const inspected = [];
  let submitted;
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: [
        { ...candidate(1), seeders: 1 },
        { ...candidate(2), seeders: 36 },
        { ...candidate(3), seeders: 0 },
      ] }),
    previewCandidate: async ({ candidate: item }) => {
      inspected.push(item.guid);
      return preflight;
    },
    loadDetail: async () => detail,
    submitCandidate: async ({ candidate: item }) => {
      submitted = item.guid;
      return { state: 'stopped_observed', attemptId: 11 };
    },
  });
  assertAttempt(await process({ requestId: 4 }), 11);
  assert.deepEqual(inspected, ['candidate-2']);
  assert.equal(submitted, 'candidate-2');
});

test('a submitted episode advances the saved candidate cursor for other episodes', async () => {
  const seen = [];
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: [candidate(1), candidate(2)] }),
    previewCandidate: async ({ candidate: item }) => {
      const episodeId = item.guid === 'candidate-1' ? 1001 : 1002;
      return { ...preflight, episodeIds: [episodeId],
        files: [{ name: `Example - ${episodeId === 1001 ? '01' : '02'}.mkv`, size: 1000,
          episodeIds: [episodeId] }] };
    },
    loadDetail: async () => detail,
    submitCandidate: async ({ candidate: item }) => {
      seen.push(item.guid);
      return { state: 'stopped_observed', attemptId: seen.length + 10 };
    },
  });
  const first = await process({ requestId: 4 });
  assert.equal(first.nextCandidateOffset, 1);
  const second = await process({ requestId: 4,
    candidateOffset: first.nextCandidateOffset,
    candidateFingerprint: first.nextCandidateFingerprint });
  assertAttempt(second, 12);
  assert.deepEqual(seen, ['candidate-1', 'candidate-2']);
});

test('an owned busy target yields to another episode without a second grab', async () => {
  const seen = [];
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: [candidate(1), candidate(2)] }),
    previewCandidate: async ({ candidate: item }) => {
      const episodeId = item.guid === 'candidate-1' ? 1001 : 1002;
      return { ...preflight, episodeIds: [episodeId],
        files: [{ name: `Example - ${episodeId === 1001 ? '01' : '02'}.mkv`,
          size: 1000, episodeIds: [episodeId] }] };
    },
    loadDetail: async () => detail,
    submitCandidate: async ({ candidate: item }) => {
      seen.push(item.guid);
      return item.guid === 'candidate-1'
        ? { state: 'held', reason: 'target_busy' }
        : { state: 'stopped_observed', attemptId: 12 };
    },
  });
  const first = await process({ requestId: 4 });
  assert.equal(first.reason, 'target_busy');
  assert.equal(first.nextCandidateOffset, 1);
  const second = await process({ requestId: 4,
    candidateOffset: first.nextCandidateOffset,
    candidateFingerprint: first.nextCandidateFingerprint });
  assertAttempt(second, 12);
  assert.deepEqual(seen, ['candidate-1', 'candidate-2']);
});

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
  assertAttempt(await process({ requestId: 4 }), 11);
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
    { detail: { ...detail, restricted: null } },
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
  assert.match(first.nextCandidateFingerprint, /^[0-9a-f]{64}:/);
  assertAttempt(await process({ requestId: 4, candidateOffset: 3,
    candidateFingerprint: first.nextCandidateFingerprint }), 12);
  assert.deepEqual(seen, ['candidate-1', 'candidate-2',
    'candidate-3', 'candidate-4']);
});

test('changed provider order preserves the saved candidate sweep', async () => {
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

test('a newly discovered release cannot restart the current candidate sweep', async () => {
  let items = [candidate(1), candidate(2), candidate(3), candidate(4)];
  const seen = [];
  const process = createAcquisitionRequestProcessor({
    maxPreflights: 1,
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items }),
    previewCandidate: async ({ candidate: item }) => {
      seen.push(item.guid);
      return item.guid === 'candidate-5' ? preflight :
        { state: 'held', reason: 'unsafe_or_unselected_file' };
    },
    loadDetail: async () => detail,
    submitCandidate: async () => ({ state: 'stopped_observed', attemptId: 12 }),
  });
  const first = await process({ requestId: 4 });
  assert.equal(first.nextCandidateOffset, 1);
  items = [{ ...candidate(5), seeders: 30 }, ...items];
  const second = await process({ requestId: 4,
    candidateOffset: first.nextCandidateOffset,
    candidateFingerprint: first.nextCandidateFingerprint });
  assert.equal(second.nextCandidateOffset, 2);
  assert.equal(second.reason, 'no_safe_release');
  const third = await process({ requestId: 4,
    candidateOffset: second.nextCandidateOffset,
    candidateFingerprint: second.nextCandidateFingerprint });
  assert.equal(third.nextCandidateOffset, 3);
  const fourth = await process({ requestId: 4,
    candidateOffset: third.nextCandidateOffset,
    candidateFingerprint: third.nextCandidateFingerprint });
  assert.equal(fourth.nextCandidateOffset, 4);
  assertAttempt(await process({ requestId: 4,
    candidateOffset: fourth.nextCandidateOffset,
    candidateFingerprint: fourth.nextCandidateFingerprint }), 12);
  assert.deepEqual(seen, ['candidate-1', 'candidate-2', 'candidate-3',
    'candidate-4', 'candidate-5']);
});

test('removed and added releases do not make a changing catalogue starve older candidates', async () => {
  let items = [candidate(1), candidate(2), candidate(3), candidate(4)];
  const seen = [];
  const process = createAcquisitionRequestProcessor({
    maxPreflights: 1,
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items }),
    previewCandidate: async ({ candidate: item }) => {
      seen.push(item.guid);
      return item.guid === 'candidate-4' ? preflight :
        { state: 'held', reason: 'unsafe_or_unselected_file' };
    },
    loadDetail: async () => detail,
    submitCandidate: async () => ({ state: 'stopped_observed', attemptId: 12 }),
  });
  const first = await process({ requestId: 4 });
  items = [{ ...candidate(5), seeders: 30 }, candidate(2), candidate(3), candidate(4)];
  const second = await process({ requestId: 4,
    candidateOffset: first.nextCandidateOffset,
    candidateFingerprint: first.nextCandidateFingerprint });
  items = [{ ...candidate(6), seeders: 40 }, candidate(3), candidate(4), candidate(5)];
  const third = await process({ requestId: 4,
    candidateOffset: second.nextCandidateOffset,
    candidateFingerprint: second.nextCandidateFingerprint });
  assertAttempt(await process({ requestId: 4,
    candidateOffset: third.nextCandidateOffset,
    candidateFingerprint: third.nextCandidateFingerprint }), 12);
  assert.deepEqual(seen, ['candidate-1', 'candidate-2', 'candidate-3', 'candidate-4']);
});

test('a saved cursor from the previous fingerprint format resets safely once', async () => {
  const seen = [];
  const process = createAcquisitionRequestProcessor({
    maxPreflights: 1,
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: [candidate(1), candidate(2)] }),
    previewCandidate: async ({ candidate: item }) => {
      seen.push(item.guid);
      return { state: 'held', reason: 'unsafe_or_unselected_file' };
    },
    loadDetail: async () => detail,
    submitCandidate: async () => { throw Error('must not submit'); },
  });
  const first = await process({ requestId: 4, candidateOffset: 1,
    candidateFingerprint: `${'a'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)}` });
  assert.equal(first.nextCandidateOffset, 1);
  const second = await process({ requestId: 4,
    candidateOffset: first.nextCandidateOffset,
    candidateFingerprint: first.nextCandidateFingerprint });
  assert.equal(second.nextCandidateOffset, 0);
  assert.deepEqual(seen, ['candidate-1', 'candidate-2']);
});

test('seeder ranking churn cannot starve a later candidate', async () => {
  let flip = false;
  const seen = [];
  const process = createAcquisitionRequestProcessor({
    maxPreflights: 2,
    readRequest: () => request,
    discoverCandidates: async () => {
      flip = !flip;
      return { state: 'candidates', requestId: 4, anidbId: 42,
        items: [
          { ...candidate(1), seeders: flip ? 10 : 9 },
          { ...candidate(2), seeders: flip ? 9 : 10 },
          { ...candidate(3), seeders: 8 },
          { ...candidate(4), seeders: 7 },
        ] };
    },
    previewCandidate: async ({ candidate: item }) => {
      seen.push(item.guid);
      return item.guid === 'candidate-4' ? preflight :
        { state: 'held', reason: 'unsafe_or_unselected_file' };
    },
    loadDetail: async () => detail,
    submitCandidate: async () => ({ state: 'stopped_observed', attemptId: 12 }),
  });
  const first = await process({ requestId: 4 });
  assert.equal(first.nextCandidateOffset, 2);
  assertAttempt(await process({ requestId: 4,
    candidateOffset: first.nextCandidateOffset,
    candidateFingerprint: first.nextCandidateFingerprint }), 12);
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
  assertAttempt(await process({ requestId: 4,
    candidateOffset: first.nextCandidateOffset,
    candidateFingerprint: first.nextCandidateFingerprint }), 12);
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
    { state: 'held', reason: 'request_fully_available',
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

test('preflight skips an exact already playable episode within the same bounded run', async () => {
  const previews = [];
  const submissions = [];
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    readPublicCoverage: () => ({ verifiedTargets: 1, targetCount: 2,
      availableEpisodeIds: [1001] }),
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: [candidate(1), candidate(2)] }),
    previewCandidate: async ({ candidate: item }) => {
      previews.push(item.guid);
      return item.guid === 'candidate-1' ? preflight : {
        ...preflight, episodeIds: [1002],
        files: [{ name: 'Example - 02.mkv', size: 1000, episodeIds: [1002] }],
      };
    },
    loadDetail: async () => detail,
    submitCandidate: async ({ candidate: item }) => {
      submissions.push(item.guid);
      return { state: 'stopped_observed', attemptId: 12 };
    },
  });
  assertAttempt(await process({ requestId: 4 }), 12);
  assert.deepEqual(previews, ['candidate-1', 'candidate-2']);
  assert.deepEqual(submissions, ['candidate-2']);
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
  assertAttempt(await process({ requestId: 4, candidateOffset: 1,
    candidateFingerprint: first.nextCandidateFingerprint }), 12);
  assert.deepEqual(seen, ['candidate-1', 'candidate-2']);
});

test('a Shoko hold on a recently playable candidate yields to a missing episode', async () => {
  const submitted = [];
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    readPublicCoverage: () => ({ verifiedTargets: 1, targetCount: 2,
      availableEpisodeIds: [1001] }),
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: [candidate(1), candidate(2)] }),
    previewCandidate: async ({ candidate: item }) => item.guid === 'candidate-1'
      ? preflight : { ...preflight, episodeIds: [1002],
        files: [{ name: 'Example - 02.mkv', size: 1000,
          episodeIds: [1002] }] },
    loadDetail: async () => detail,
    submitCandidate: async ({ candidate: item }) => {
      submitted.push(item.guid);
      return item.guid === 'candidate-1'
        ? { state: 'held', reason: 'target_not_proven_unimported', episodeId: 1001 }
        : { state: 'stopped_observed', attemptId: 12 };
    },
  });
  assertAttempt(await process({ requestId: 4 }), 12);
  assert.deepEqual(submitted, ['candidate-2']);
});

test('an unproven Shoko hold does not skip a candidate', async () => {
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    readPublicCoverage: () => ({ verifiedTargets: 0, targetCount: 2,
      availableEpisodeIds: [] }),
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: [candidate(1), candidate(2)] }),
    previewCandidate: async () => preflight,
    loadDetail: async () => detail,
    submitCandidate: async () => ({ state: 'held',
      reason: 'target_not_proven_unimported', episodeId: 1001 }),
  });
  assert.deepEqual(await process({ requestId: 4 }),
    { state: 'held', reason: 'target_not_proven_unimported' });
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
  assertAttempt(await process({ requestId: 4,
    candidateOffset: first.nextCandidateOffset,
    candidateFingerprint: first.nextCandidateFingerprint }), 12);
  assert.deepEqual(submitted, ['candidate-1', 'candidate-2']);
});

test('a retired stalled release yields to a later candidate', async () => {
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates',
      requestId: 4, anidbId: 42, items: [candidate(1), candidate(2)] }),
    previewCandidate: async () => preflight,
    loadDetail: async () => detail,
    submitCandidate: async ({ candidate: selected }) => selected.guid === 'candidate-1'
      ? { state: 'held', reason: 'candidate_retired' }
      : { state: 'stopped_observed', attemptId: 12 },
  });
  const first = await process({ requestId: 4 });
  assert.equal(first.reason, 'candidate_retired');
  assert.equal(first.nextCandidateOffset, 1);
  assertAttempt(await process({ requestId: 4,
    candidateOffset: first.nextCandidateOffset,
    candidateFingerprint: first.nextCandidateFingerprint }), 12);
});

test('an uncertain first-time target remains held across another release', async () => {
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates',
      requestId: 4, anidbId: 42, items: [candidate(1), candidate(2)] }),
    previewCandidate: async () => preflight,
    loadDetail: async () => detail,
    submitCandidate: async () => ({ state: 'held',
      reason: 'uncertain_attempt_exhausted' }),
  });
  const first = await process({ requestId: 4 });
  assert.equal(first.reason, 'uncertain_attempt_exhausted');
  assert.equal(first.nextCandidateOffset, 1);
  const second = await process({ requestId: 4,
    candidateOffset: first.nextCandidateOffset,
    candidateFingerprint: first.nextCandidateFingerprint });
  assert.equal(second.reason, 'uncertain_attempt_exhausted');
  assert.equal(second.nextCandidateOffset, 0);
});

test('an exhausted uncertain episode does not starve a later distinct episode', async () => {
  const submitted = [];
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: [candidate(1), candidate(2), candidate(3)] }),
    previewCandidate: async ({ candidate: item }) => {
      const episodeId = item.guid === 'candidate-3' ? 1002 : 1001;
      return { ...preflight, episodeIds: [episodeId],
        files: [{ name: `Example - ${episodeId === 1001 ? '01' : '02'}.mkv`,
          size: 1000, episodeIds: [episodeId] }] };
    },
    loadDetail: async () => detail,
    submitCandidate: async ({ candidate: item }) => {
      submitted.push(item.guid);
      return item.guid === 'candidate-3'
        ? { state: 'stopped_observed', attemptId: 12 }
        : { state: 'held', reason: 'uncertain_attempt_exhausted' };
    },
  });
  const first = await process({ requestId: 4 });
  assert.equal(first.reason, 'uncertain_attempt_exhausted');
  assert.equal(first.nextCandidateOffset, 1);
  const second = await process({ requestId: 4,
    candidateOffset: first.nextCandidateOffset,
    candidateFingerprint: first.nextCandidateFingerprint });
  assert.equal(second.reason, 'uncertain_attempt_exhausted');
  assert.equal(second.nextCandidateOffset, 2);
  const third = await process({ requestId: 4,
    candidateOffset: second.nextCandidateOffset,
    candidateFingerprint: second.nextCandidateFingerprint });
  assertAttempt(third, 12);
  assert.deepEqual(submitted, ['candidate-1', 'candidate-2', 'candidate-3']);
});

test('active old claims are skipped within the bounded preview pass', async () => {
  const inspected = [];
  const submitted = [];
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: [candidate(1), candidate(2), candidate(3)] }),
    previewCandidate: async ({ candidate: item }) => {
      inspected.push(item.guid);
      const episodeId = item.guid === 'candidate-3' ? 1002 : 1001;
      return { ...preflight, episodeIds: [episodeId],
        files: [{ name: `Example - ${episodeId === 1001 ? '01' : '02'}.mkv`,
          size: 1000, episodeIds: [episodeId] }] };
    },
    inspectCandidateTargets: ({ episodeIds }) => ({ state:
      episodeIds[0] === 1001 ? 'skip_active' : 'eligible' }),
    loadDetail: async () => detail,
    submitCandidate: async ({ candidate: item }) => {
      submitted.push(item.guid);
      return { state: 'stopped_observed', attemptId: 12 };
    },
  });
  assertAttempt(await process({ requestId: 4 }), 12);
  assert.deepEqual(inspected, ['candidate-1', 'candidate-2', 'candidate-3']);
  assert.deepEqual(submitted, ['candidate-3']);
});

test('a page of active claims advances the candidate cursor without submission', async () => {
  let submissions = 0;
  const process = createAcquisitionRequestProcessor({
    readRequest: () => request,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4,
      anidbId: 42, items: [candidate(1), candidate(2), candidate(3), candidate(4)] }),
    previewCandidate: async () => preflight,
    inspectCandidateTargets: () => ({ state: 'skip_active' }),
    loadDetail: async () => { throw Error('detail read'); },
    submitCandidate: async () => { submissions++; },
  });
  const result = await process({ requestId: 4 });
  assert.equal(result.reason, 'no_safe_release');
  assert.equal(result.nextCandidateOffset, 3);
  assert.equal(submissions, 0);
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
  assertAttempt(await process({ requestId: 4, candidateOffset: 1,
    candidateFingerprint: first.nextCandidateFingerprint }), 12);
  assert.deepEqual(seen, ['candidate-1', 'candidate-2']);
});
