import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { stoppedPack } from './helpers/stopped-pack.mjs';
import { createAcquisitionRequestProcessor } from '../src/acquisition/acquisition-request-processor.mjs';
import { previewRequestCandidate } from '../src/acquisition/request-candidate-preflight.mjs';
import { submitMissingCandidate } from '../src/acquisition/submit-missing-candidate.mjs';
import { collectTargetScopedUncertain } from '../src/acquisition/collect-target-scoped-uncertain.mjs';

const publicState = { state: 'healthy_unconfirmed', libraryIds: [102], parts: [],
  complete: false, probeCoverage: 'health_only', sourceVerified: true };
function ownedEvidence(x, owned) {
  return async ({ episodeIds }) => {
    const present = episodeIds.filter(id => owned.has(id));
    return { anidbId: 42, episodeIds, observedAtMs: x.state.clock,
      importFence: { state: 'settled', anidbId: 42, episodeIds,
        beforeObservedAtMs: x.state.clock, afterObservedAtMs: x.state.clock },
      shoko: { state: 'ok', complete: true, files: present.map(id => ({ fileId: id,
        anidbId: 42, episodeIds: [id], coverage: [{ episodeId: id, start: 0, end: 100 }], storageKey: `owned-${id}` })) },
      plex: { state: 'ok', complete: true, sourceVerified: true, libraryIds: [102],
        parts: present.map(id => ({ storageKey: `owned-${id}`, libraryId: 102, readable: true })) } };
  };
}
const coverage = owned => async request => {
  const availableEpisodeIds = request.episodeIds.filter(id => owned.has(id));
  return { targetCount: request.episodeIds.length, verifiedTargets: availableEpisodeIds.length,
    availableEpisodeIds, uncertainEpisodeIds: [] };
};

for (const withSubtitles of [false, true]) for (const reserved of [false, true]) for (const pinned of [false, true]) test(`ownership gained after submission trims only the chosen pack (${pinned ? 'manual' : 'Auto'}, reserved=${reserved}, subtitles=${withSubtitles})`, async t => {
  const x = await stoppedPack(t, { count: 6, selected: [1, 2, 3, 4, 5, 6], reserve: false, priorityFailure: 'none', additionalFiles: withSubtitles ? [
    {name:'Example - 01.en.srt',size:5},{name:'Example - 03.en.srt',size:5}] : [] });
  const detail = { state: 'details', complete: true, total: 6, anidbId: 42,
    kind: 'series', title: 'Example', restricted: false, page: 1, nextPage: null,
    episodes: x.ids.map((id, i) => ({ id, number: i + 1, type: 'Episode', title: `Episode ${i + 1}` })) };
  const readRequest = id => x.requests.getRequest(id);
  const previewCandidate = () => previewRequestCandidate({ requestId: x.requestId,
    candidate: x.candidate, readRequest, loadDetail: async () => detail, prepare: async () => x.prepared });
  if (pinned) {
    const initial = await previewCandidate();
    assert.equal(initial.state, 'preflight', JSON.stringify(initial));
    const current = x.requests.getReleaseControl(x.requestId, x.state.clock);
    assert.equal(x.requests.updateReleaseControl(x.requestId, current.revision,
      { mode: 'manual', phase: 'chosen', selection: { candidate: x.candidate, preview: initial } }, x.state.clock).state, 'updated');
  }
  if (reserved) {
    const initial = await previewCandidate();
    const claim = x.ledger.reserve({ requestId: x.requestId, candidate: x.candidate,
      episodeIds: x.ids, plannedFiles: initial.files, preparedHash: x.hash, nowMs: x.state.clock });
    assert.equal(claim.state, 'reserved', JSON.stringify(claim));
    x.useAttempt(claim.attemptId);
    x.ledger.bindPreparedTorrent({ attemptId: x.attemptId, candidate: x.candidate, hash: x.hash, nowMs: x.state.clock });
    x.ledger.recordFilePlan({ attemptId: x.attemptId, hash: x.hash, plannedFiles: initial.files, nowMs: x.state.clock });
    x.ledger.recordTorrentSelection({attemptId:x.attemptId,hash:x.hash,files:x.prepared.files,excludedFileNames:[],nowMs:x.state.clock});
    x.reopen();
  }
  const owned = new Set(x.ids.slice(0, 2));
  const readPublicCoverage = coverage(owned), readEvidence = ownedEvidence(x, owned);
  const proxy = 'http://prowlarr.invalid/7/download?apikey=synthetic&link=pack&file=Example';
  const prowlarrFetch = async url => new URL(url).pathname.includes('/download')
    ? new Response(x.bytes, { headers: { 'content-type': 'application/x-bittorrent' } })
    : Response.json([{ ...x.candidate, protocol: 'torrent', downloadUrl: proxy }]);
  const process = createAcquisitionRequestProcessor({ readRequest, readPublicCoverage,
    readReleaseControl: (id, now) => x.requests.getReleaseControl(id, now),
    consumeReleaseChoice: (id, revision) => x.requests.consumeReleaseChoice(id, revision),
    discoverCandidates: async () => ({ state: 'candidates', requestId: x.requestId, anidbId: 42, items: [x.candidate] }),
    previewCandidate, loadDetail: async () => detail, now: () => x.state.clock,
    submitCandidate: input => submitMissingCandidate({ ...input, ledger: x.ledger,
      readEvidence, readPublicCoverage, publicLibraryIds: [102], authorizeRequest: x.authorizeRequest,
      now: () => x.state.clock,
      prowlarr: { baseUrl: 'http://prowlarr.invalid/', apiKey: 'synthetic', indexerIds: [7], fetchImpl: prowlarrFetch },
      qbittorrent: { hostPath: '/staging', baseUrl: 'http://qbit.invalid/', sessionId: 'syntheticSID',
        saveRoot: x.saveRoot, verifyStagingRoot: x.verifyStagingRoot, fetchImpl: x.fetchImpl } }),
  });
  const result = await process({ requestId: x.requestId });
  assert.equal(result.state, 'stopped_observed', JSON.stringify(result));
  x.useAttempt(result.attemptId);
  assert.deepEqual(x.ledger.getAttempt(x.attemptId).episodeIds, x.ids.slice(2));
  assert.deepEqual(x.requests.getRequest(x.requestId).episodeIds, x.ids, 'the season request retains its complete history');
  assert.deepEqual(x.files.map(file => file.priority), [0, 0, 1, 1, 1, 1, ...(withSubtitles ? [0, 1] : [])]);
  assert.equal((await x.start({ readPublicCoverage, readEvidence })).state, 'start_unknown');
  assert.equal(x.state.adds, 1); assert.equal(x.state.starts, 1);
});

for (const firstTime of [false, true]) test(`ownership gained after stopped add journals a safe smaller selection (${firstTime ? 'first-time collector' : 'exact snapshot'})`, async t => {
  const x = await stoppedPack(t, { count: 6, selected: [1, 2, 3, 4, 5, 6], priorityFailure: 'none',
    evidencePolicy: firstTime ? 'first_time_permissive' : 'strict' });
  assert.equal((await x.submit()).state, 'stopped_observed');
  const owned = new Set(x.ids.slice(0, 2));
  const readPublicCoverage = coverage(owned);
  const readEvidence = firstTime ? input => collectTargetScopedUncertain({ ...input, kind: 'series',
    publicLibraryIds: [102], now: () => x.state.clock,
    readEpisode: async target => owned.has(target.episodeId) ? { state: 'ok', files: [{}], ...target }
      : { state: 'not_imported', ...target }, probePublic: async () => publicState }) : ownedEvidence(x, owned);
  const revised = await x.start({ readPublicCoverage, readEvidence });
  assert.equal(revised.reason, 'file_selection_changed', JSON.stringify(revised));
  assert.equal(x.state.starts, 0);
  x.reopen();
  assert.deepEqual(x.ledger.getAttempt(x.attemptId).episodeIds, x.ids.slice(2));
  assert.deepEqual(x.requests.getRequest(x.requestId).episodeIds, x.ids);
  const raw = new DatabaseSync(x.dbPath);
  try {
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM acquisition_target_claims WHERE attempt_id=?').get(x.attemptId).n, 6,
      'original claim history remains recorded');
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM acquisition_target_claims WHERE attempt_id=? AND active=1').get(x.attemptId).n, 4);
  } finally { raw.close(); }
  x.state.clock += 60000;
  assert.equal((await x.start({ readPublicCoverage, readEvidence })).state, 'start_unknown');
  assert.deepEqual(x.files.map(file => file.priority), [0, 0, 1, 1, 1, 1]);
  assert.equal(x.state.adds, 1); assert.equal(x.state.starts, 1);
});

for (const priorityFailure of ['before', 'after']) test(`revised selection recovers a failed priority acknowledgement ${priorityFailure} application`, async t => {
  const x = await stoppedPack(t, { count: 3, selected: [1, 2, 3], priorityFailure });
  assert.equal((await x.submit()).state, 'stopped_observed');
  const owned = new Set(x.ids.slice(0, 1));
  const options = { readPublicCoverage: coverage(owned), readEvidence: ownedEvidence(x, owned) };
  assert.equal((await x.start(options)).reason, 'file_selection_changed');
  x.reopen();
  const first = await x.start(options);
  if (priorityFailure === 'before') {
    assert.equal(first.state, 'held');
    assert.equal(first.reason, 'passive_exclusion_unconfirmed');
    assert.equal(x.state.starts, 0);
    x.reopen(); x.state.clock += 60000;
    assert.equal((await x.start(options)).state, 'start_unknown');
  } else assert.equal(first.state, 'start_unknown');
  assert.deepEqual(x.files.map(file => file.priority), [0, 1, 1]);
  assert.equal(x.state.adds, 1); assert.equal(x.state.starts, 1);
});

for (const change of ['name', 'size', 'owner', 'access', 'mount', 'unavailable', 'contradictory', 'withdrawn', 'all-owned'])
  test(`ownership reconciliation refuses ${change} without narrowing the saved plan`, async t => {
    const x = await stoppedPack(t, { count: 3, selected: [1, 2, 3], priorityFailure: 'none' });
    await x.submit();
    const owned = new Set(x.ids.slice(0, 1));
    let readPublicCoverage = coverage(owned);
    if (change === 'name') x.files[0].name = 'foreign.mkv';
    if (change === 'size') x.files[0].size++;
    if (change === 'owner') x.torrent.category = 'foreign';
    if (change === 'access') x.state.ownerAllowed = false;
    if (change === 'mount') x.state.mountReady = false;
    if (change === 'unavailable') readPublicCoverage = async () => { throw Error('provider unavailable'); };
    if (change === 'contradictory') readPublicCoverage = async () => ({ targetCount: 3, verifiedTargets: 1, availableEpisodeIds: [99999] });
    if (change === 'withdrawn') { let reads = 0; readPublicCoverage = input => coverage(++reads === 1 ? owned : new Set())(input); }
    if (change === 'all-owned') readPublicCoverage = coverage(new Set(x.ids));
    const result = await x.start({ readPublicCoverage, readEvidence: ownedEvidence(x, owned) });
    assert.equal(result.state, 'held', JSON.stringify(result));
    assert.deepEqual(x.ledger.getAttempt(x.attemptId).episodeIds, x.ids);
    assert.equal(x.state.priorities, 0); assert.equal(x.state.starts, 0); assert.equal(x.state.adds, 1);
  });

test('an older observed full pack can journal a narrower selection from exact exported metadata', async t => {
  const x = await stoppedPack(t, { count: 3, selected: [1, 2, 3], priorityFailure: 'none' });
  await x.submit(); x.dropSelection(); x.reopen();
  const owned = new Set(x.ids.slice(0, 1));
  const options = { readPublicCoverage: coverage(owned), readEvidence: ownedEvidence(x, owned) };
  assert.equal((await x.start(options)).reason, 'file_selection_changed');
  x.reopen();
  assert.equal((await x.start(options)).state, 'start_unknown');
  assert.equal(x.state.exports, 1); assert.equal(x.state.adds, 1); assert.equal(x.state.starts, 1);
});
import { openStartQueue, createStartWorker } from '../src/acquisition/start-queue.mjs';
import { selectMissingFiles } from '../src/acquisition/select-missing-files.mjs';

test('two first-time provider outages survive queue restart and recover with one real start', async t => {
  const x = await stoppedPack(t, { count: 3, selected: [1, 2, 3], priorityFailure: 'none', evidencePolicy: 'first_time_permissive' });
  await x.submit();
  let healthy = false;
  let queue = openStartQueue(x.dbPath, { acquisitions: x.ledger });
  const readEvidence = input => collectTargetScopedUncertain({ ...input, kind: 'series', publicLibraryIds: [102],
    now: () => x.state.clock, probePublic: async () => publicState,
    readEpisode: async target => healthy ? { state: 'not_imported', ...target } : { state: 'unavailable', ...target } });
  try { for (let turn = 0; turn < 3; turn++) {
    const result = await createStartWorker({ queue, now: () => x.state.clock,
      processAttempt: () => x.start({ readEvidence, readPublicCoverage: coverage(new Set()) }) }).runOnce();
    if (turn < 2) {
      assert.equal(result.result.reason, 'availability_unavailable');
      const check = queue.getResult(x.attemptId);
      assert.ok(check.nextDueMs > x.state.clock);
      x.state.clock = check.nextDueMs;
      queue.close(); x.reopen(); queue = openStartQueue(x.dbPath, { acquisitions: x.ledger });
    } else assert.equal(result.result.state, 'start_unknown');
    if (turn === 1) healthy = true;
  }
  assert.equal(x.state.adds, 1); assert.equal(x.state.starts, 1);
  } finally { queue.close(); }
});

test('a combined video is never split around a publicly owned episode', () => {
  assert.deepEqual(selectMissingFiles([{ name: '01-02.mkv', size: 100, episodeIds: [1, 2] }], [1, 2], [1]),
    { state: 'held', reason: 'target_already_available' });
});

const retainedBonus = { name: 'Example OVA 01.mkv', size: 50, anidbId: 43, episodeIds: [2001],
  kind: 'ova', evidence: 'shoko_filename_prediction' };
test('legacy ownership revision retains an accepted bonus in the exact selection', async t => {
  const x = await stoppedPack(t, { count: 3, selected: [1, 2, 3], priorityFailure: 'none', bonusFiles: [retainedBonus] });
  assert.equal((await x.submit()).state, 'stopped_observed');
  x.dropSelection(); x.reopen();
  const owned = new Set(x.ids.slice(0, 1));
  const options = { readPublicCoverage: coverage(owned), readEvidence: ownedEvidence(x, owned), readBonusOwnership: async () => ({ state: 'missing' }) };
  assert.equal((await x.start(options)).reason, 'file_selection_changed');
  x.reopen();
  assert.equal((await x.start(options)).state, 'start_unknown');
  assert.equal(x.files.at(-1).priority, 1);
  assert.ok(!x.ledger.getTorrentSelection(x.attemptId).excludedFileNames.includes(retainedBonus.name));
  assert.equal(x.state.adds, 1); assert.equal(x.state.starts, 1);
});

for (const legacy of [false, true]) test(`ownership revision excludes only episode-exclusive root subtitles (legacy=${legacy})`, async t => {
  const x = await stoppedPack(t, { count: 3, selected: [1, 2, 3], priorityFailure: 'none', additionalFiles: [
    { name: 'Example - 01.en.srt', size: 5 }, { name: 'Example - 02.en.srt', size: 5 } ] });
  await x.submit();
  if (legacy) { x.dropSelection(); x.reopen(); }
  const owned = new Set(x.ids.slice(0, 1));
  const options = { readPublicCoverage: coverage(owned), readEvidence: ownedEvidence(x, owned) };
  assert.equal((await x.start(options)).reason, 'file_selection_changed');
  x.reopen();
  assert.equal((await x.start(options)).state, 'start_unknown');
  assert.deepEqual(x.files.map(file => file.priority), [0, 1, 1, 0, 1]);
  assert.equal(x.state.adds, 1); assert.equal(x.state.starts, 1);
});

test('a journaled bonus becoming owned is excluded without stranding the main pack', async t => {
  const x = await stoppedPack(t, { count: 3, selected: [1, 2, 3], priorityFailure: 'none', bonusFiles: [retainedBonus] });
  await x.submit(); x.reopen();
  const result = await x.start({ readBonusOwnership: async () => ({ state: 'owned' }) });
  assert.equal(result.state, 'start_unknown', JSON.stringify(result));
  assert.equal(x.files.at(-1).priority, 0); assert.equal(x.state.starts, 1); assert.equal(x.state.adds, 1);
});
