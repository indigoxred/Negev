import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';
import { ed2kFile } from '../src/identity/ed2k.mjs';
import { processCompletedAttempt } from '../src/acquisition/process-completed-attempt.mjs';
import { processRecordedHandoff } from '../src/acquisition/process-recorded-handoff.mjs';
import { previewAniDbRelease } from '../src/identity/shoko-preview.mjs';
import { openHandoffPublishQueue, createHandoffPublishWorker } from
  '../src/acquisition/handoff-publish-queue.mjs';
import { createCompletionWorker, openCompletionQueue } from '../src/acquisition/completion-queue.mjs';

const torrentHash = 'a'.repeat(40);
const providerId = '11111111-2222-4333-8444-555555555555';

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-completed-'));
  const dbPath = path.join(root, 'state.sqlite');
  const stagingHostPath = path.join(root, 'staging');
  const holdingRoot = path.join(root, 'holding');
  const importRoot = path.join(root, 'import');
  await Promise.all([path.join(stagingHostPath, torrentHash), holdingRoot, importRoot]
    .map((dir) => mkdir(dir, { recursive: true })));
  const filePath = path.join(stagingHostPath, torrentHash, '01.mkv');
  await writeFile(filePath, Buffer.from('registered exact file'));
  const identity = await ed2kFile(filePath);
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'completed', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
      episodeIds: [1001] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const candidate = { indexerId: 7, guid: 'exact-candidate' };
  const claimed = acquisitions.reserve({ requestId: saved.requestId, candidate,
    episodeIds: [1001], nowMs: 200 });
  acquisitions.bindPreparedTorrent({ attemptId: claimed.attemptId, candidate,
    hash: torrentHash, nowMs: 201 });
  acquisitions.recordFilePlan({ attemptId: claimed.attemptId, hash: torrentHash,
    plannedFiles: [{ name: '01.mkv', size: identity.size, episodeIds: [1001] }], nowMs: 202 });
  acquisitions.beginDispatch({ attemptId: claimed.attemptId, nowMs: 203 });
  acquisitions.recordTorrent({ attemptId: claimed.attemptId, hash: torrentHash, nowMs: 204 });
  acquisitions.beginStart({ attemptId: claimed.attemptId, hash: torrentHash,
    manifestDigest: 'b'.repeat(64), nowMs: 205 });
  const handoffs = openHandoffLedger(dbPath);
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method });
    if (u.pathname.startsWith('/api/v2/torrents/')) {
      const body = u.pathname.endsWith('/info') ? [{ hash: torrentHash,
        category: 'negev', save_path: `/negev-staging/${torrentHash}`,
        auto_tmm: false, force_start: false, state: 'uploading', progress: 1,
        amount_left: 0 }] : u.pathname.endsWith('/properties')
        ? { save_path: `/negev-staging/${torrentHash}`, download_path: '' }
        : [{ index: 0, name: '01.mkv', size: identity.size,
          priority: 1, progress: 1, is_seed: true }];
      return { status: 200, text: async () => JSON.stringify(body) };
    }
    if (u.pathname.endsWith('/Preview/By-Release')) {
      const body = { ProviderName: 'AniDB', ID: `anidb://${identity.ed2k}+${identity.size}`,
        ReleaseURI: 'https://anidb.net/file/51', FileSize: identity.size,
        IsCorrupted: false, Hashes: [{ Type: 'ED2K', Value: identity.ed2k }],
        CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
          PercentageStart: 0, PercentageEnd: 100 }] };
      return { status: 200, text: async () => JSON.stringify(body) };
    }
    throw Error('unexpected request');
  };
  try {
    await run({ dbPath, requests, acquisitions, handoffs, attemptId: claimed.attemptId,
      stagingHostPath, holdingRoot, importRoot, identity, calls,
      config: { qbittorrent: { baseUrl: 'http://qbit.internal:8080/', sessionId: 'session' },
        shoko: { baseUrl: 'http://shoko.internal:8111/', providerId, apiKey: 'test-key' },
        fetchImpl, nowMs: 206, readPacer: { afterBytes: async () => {} } } });
  } finally {
    handoffs.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('one explicit completed-attempt tick verifies AniDB bytes and journals private holding', async () => {
  await fixture(async (context) => {
    const { calls, handoffs, importRoot, attemptId, config, ...stores } = context;
    const first = await processCompletedAttempt({ ...stores, handoffs, attemptId, importRoot, ...config });
    assert.equal(first.state, 'handoff_prepared', JSON.stringify(first));
    assert.equal(handoffs.getHandoff(attemptId).status, 'prepared');
    assert.deepEqual(await readdir(importRoot), []);
    assert.equal(calls.filter((call) => call.path.endsWith('/Preview/By-Release')).length, 1);
    const again = await processCompletedAttempt({ ...stores, handoffs, attemptId, importRoot, ...config });
    assert.deepEqual(again, { state: 'held', reason: 'handoff_already_recorded' });
    assert.equal(calls.filter((call) => call.path.endsWith('/Preview/By-Release')).length, 1);
  });
});

test('incomplete torrent holds before reading staged bytes or Shoko', async () => {
  await fixture(async (context) => {
    const { calls, handoffs, attemptId, config, ...stores } = context;
    const result = await processCompletedAttempt({ ...stores, handoffs, attemptId,
      ...config, fetchImpl: async (url, init) => {
        const response = await config.fetchImpl(url, init);
        if (new URL(url).pathname.endsWith('/info')) {
          const body = JSON.parse(await response.text());
          body[0].progress = 0.5;
          return { status: 200, text: async () => JSON.stringify(body) };
        }
        return response;
      } });
    assert.deepEqual(result, { state: 'held', reason: 'incomplete' });
    assert.equal(calls.some((call) => call.path.endsWith('/Preview/By-Release')), false);
    assert.equal(handoffs.getHandoff(attemptId), null);
  });
});

test('AniDB provider uncertainty stays retryable and a wrong-show match is terminally held', async () => {
  for (const outcome of ['unavailable', 'wrong_show']) {
    await fixture(async (context) => {
      const { handoffs, acquisitions, attemptId, config, ...stores } = context;
      const result = await processCompletedAttempt({ ...stores, handoffs, acquisitions,
        attemptId, ...config, fetchImpl: async (url, init) => {
          const response = await config.fetchImpl(url, init);
          if (!new URL(url).pathname.endsWith('/Preview/By-Release')) return response;
          if (outcome === 'unavailable') return { status: 204 };
          const body = JSON.parse(await response.text());
          body.CrossReferences[0].AnidbAnimeID = 99;
          return { status: 200, text: async () => JSON.stringify(body) };
        } });
      assert.deepEqual(result, outcome === 'unavailable'
        ? { state: 'held', reason: 'file_lookup_inconclusive' }
        : { state: 'rejected_held', reason: 'file_wrong_identity' });
      assert.equal(acquisitions.getAttempt(attemptId).status,
        outcome === 'unavailable' ? 'torrent_observed' : 'rejected_held');
      assert.equal(handoffs.getHandoff(attemptId), null);
    });
  }
});

test('a registered but corrupt AniDB release never consumes private holding space', async () => {
  await fixture(async (context) => {
    const { handoffs, attemptId, config, holdingRoot, ...stores } = context;
    const result = await processCompletedAttempt({ ...stores, handoffs, attemptId,
      holdingRoot, ...config, fetchImpl: async (url, init) => {
        const response = await config.fetchImpl(url, init);
        if (!new URL(url).pathname.endsWith('/Preview/By-Release')) return response;
        const body = JSON.parse(await response.text());
        body.IsCorrupted = true;
        return { status: 200, text: async () => JSON.stringify(body) };
      } });
    assert.deepEqual(result, { state: 'held', reason: 'file_corrupt_release' });
    assert.deepEqual(await readdir(holdingRoot), []);
    assert.equal(handoffs.getHandoff(attemptId), null);
  });
});

test('one durable completion tick reaches a verified private handoff', async () => {
  await fixture(async (context) => {
    const { dbPath, handoffs, attemptId, config, ...stores } = context;
    const queue = openCompletionQueue(dbPath);
    try {
      const worker = createCompletionWorker({ queue, now: () => 206,
        processAttempt: ({ attemptId: claimedId }) => processCompletedAttempt({
          ...stores, handoffs, attemptId: claimedId, ...config,
        }) });
      assert.deepEqual(await worker.runOnce(), { state: 'processed',
        attemptId, result: { state: 'handoff_prepared' } });
      assert.equal(queue.getResult(attemptId).state, 'handoff_prepared');
      assert.equal(handoffs.getHandoff(attemptId).status, 'prepared');
      assert.deepEqual(await readdir(stores.importRoot), []);
      assert.deepEqual(await worker.runOnce(), { state: 'pass_complete', pass: 1 });
    } finally { queue.close(); }
  });
});

test('a reopened handoff journal can publish once and observe the exact destination',
  { skip: process.platform === 'win32' ? 'Windows sandbox denies directory rename' : false },
  async () => fixture(async (context) => {
    const { dbPath, attemptId, config, holdingRoot, importRoot } = context;
    const prepared = await processCompletedAttempt({ ...context, ...config });
    assert.equal(prepared.state, 'handoff_prepared');
    const reopened = openHandoffLedger(dbPath);
    const queue = openHandoffPublishQueue(dbPath);
    const lookup = ({ ed2k, size }) => previewAniDbRelease({
      baseUrl: config.shoko.baseUrl, providerId: config.shoko.providerId,
      apiKey: config.shoko.apiKey, ed2k, size, fetchImpl: config.fetchImpl });
    try {
      let nowMs = 207;
      const worker = createHandoffPublishWorker({ queue, now: () => nowMs,
        processAttempt: ({ attemptId: selected }) => processRecordedHandoff({
          attemptId: selected, ledger: reopened, holdingRoot, importRoot,
          lookup, nowMs, readPacer: config.readPacer }) });
      assert.deepEqual(await worker.runOnce(), { state: 'processed', attemptId,
        result: { state: 'published_observed' } });
      nowMs = 60_208;
      assert.deepEqual(await worker.runOnce(), { state: 'pass_complete', pass: 1 });
      assert.deepEqual(await readdir(importRoot),
        [reopened.getHandoff(attemptId).publishName]);
    } finally { queue.close(); reopened.close(); }
  }));
