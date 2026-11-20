import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionRequestQueue, createAcquisitionPageWorker } from '../src/acquisition/acquisition-request-queue.mjs';
import { openCandidateCheckCache } from '../src/acquisition/candidate-check-cache.mjs';
import { createRequestCandidateDiscovery } from '../src/acquisition/request-candidate-discovery.mjs';
import { createAcquisitionRequestProcessor } from '../src/acquisition/acquisition-request-processor.mjs';

test('a fifty-candidate pack decision reuses checks across phases and restart and finishes within fifteen minutes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-bounded-decision-'));
  const dbPath = path.join(dir, 'state.sqlite');
  let clock = 100, previews = 0, searches = 0;
  const requests = openRequestLedger(dbPath);
  requests.submit({ requesterId: 1, requestKey: 'bounded', nowMs: clock,
    intent: { state: 'ready', anidbId: 42, kind: 'series',
      episodeIds: [1001, 1002], monitorFuture: false } });
  const detail = { state: 'details', anidbId: 42, page: 1, total: 2, complete: true,
    nextPage: null, title: 'Example', restricted: false, kind: 'series',
    airDate: '2016-01-01', endDate: '2016-04-01', episodes: [
      { id: 1001, number: 1, type: 'Episode', title: 'First' },
      { id: 1002, number: 2, type: 'Episode', title: 'Second' }] };
  const candidates = Array.from({ length: 50 }, (_, index) => ({
    indexerId: 7, guid: `pack-${index}`, title: `Example Season 1 1080p release ${index}`,
    size: 2000, seeders: 100 - index, evidence: 'unverified' }));
  let checks = openCandidateCheckCache(dbPath, { now: () => clock });
  let queue = openAcquisitionRequestQueue(dbPath);
  const makeDiscovery = () => createRequestCandidateDiscovery({ now: () => clock,
    readRequest: () => requests.getRequest(1), loadDetail: async () => detail,
    pause: async () => {}, searchReleases: async () => {
      searches++; clock += 20_000;
      return { state: 'candidates', items: candidates };
    } });
  let discover = makeDiscovery(), picked;
  const process = () => createAcquisitionRequestProcessor({
    readRequest: () => requests.getRequest(1), discoverCandidates: discover,
    requireReleasePolicy: true, preferShokoPreview: true, now: () => clock,
    loadDetail: async () => detail,
    previewCandidate: async ({ candidate }) => {
      const request = requests.getRequest(1);
      const prior = checks.get({ request, candidate });
      if (prior) return { ...prior, cacheHit: true };
      previews++; clock += 4_000;
      const result = candidate.guid === 'pack-49' ? {
        state: 'preflight', requestId: 1, anidbId: 42, torrentHash: 'a'.repeat(40),
        shokoPreview: 'uncertain', episodeIds: [1001, 1002], files: [
          { name: 'Example - 01.mkv', size: 1000, episodeIds: [1001] },
          { name: 'Example - 02.mkv', size: 1000, episodeIds: [1002] }] } :
        { state: 'held', reason: 'shoko_preview_wrong_identity' };
      checks.put({ request, candidate, result }); return result;
    },
    submitCandidate: async ({ candidate }) => {
      picked = candidate.guid; return { state: 'stopped_observed', attemptId: 1 };
    },
  });
  try {
    for (let turn = 0; turn < 30 && !picked; turn++) {
      const worker = createAcquisitionPageWorker({ queue, limit: 1, now: () => clock,
        processRequest: process() });
      await worker.runOnce({ priorityRequestId: 1 });
      if (turn === 7) {
        const started = queue.getScanStartedMs(1);
        checks.close(); queue.close();
        checks = openCandidateCheckCache(dbPath, { now: () => clock });
        queue = openAcquisitionRequestQueue(dbPath); discover = makeDiscovery();
        assert.equal(queue.getScanStartedMs(1), started);
      }
      clock += 16_000; // Allow completion/start/publication turns between pages.
    }
    assert.equal(picked, 'pack-49');
    assert.equal(previews, 50); // Not another 50 reads for each pack phase.
    assert.ok(searches <= 6);
    const timing = queue.getDecisionTiming(1);
    assert.equal(timing.startedMs, 100);
    assert.ok(timing.elapsedMs < 15 * 60_000, JSON.stringify(timing));
  } finally { checks.close(); queue.close(); requests.close();
    await rm(dir, { recursive: true, force: true }); }
});
