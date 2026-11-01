import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { reserveMissingTargets } from '../src/acquisition/reserve-missing-targets.mjs';
import { collectUnimportedTargets } from '../src/acquisition/collect-unimported-targets.mjs';

const candidate = { indexerId: 7, guid: 'candidate-for-two-episodes' };
const file = { fileId: 91, anidbId: 42, episodeIds: [1001],
  coverage: [{ episodeId: 1001, start: 0, end: 100 }], storageKey: 'same-video' };
const part = { storageKey: 'same-video', libraryId: 102, readable: true };

async function withLedgers(run, kind = 'series') {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-missing-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'missing-gate', nowMs: 10,
    intent: { state: 'ready', anidbId: 42, kind, monitorFuture: false,
      episodeIds: [1001, 1002] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  try { await run({ request: requests.getRequest(saved.requestId), acquisitions }); }
  finally { acquisitions.close(); requests.close(); await rm(dir, { recursive: true, force: true }); }
}

function evidence(overrides = {}) {
  const episodeIds = overrides.episodeIds ?? [1001, 1002];
  return { anidbId: 42, episodeIds, observedAtMs: 100,
    importFence: { state: 'settled', anidbId: 42, episodeIds,
      beforeObservedAtMs: 99, afterObservedAtMs: 100 },
    shoko: { state: 'ok', complete: true, files: [] },
    plex: { state: 'ok', complete: true, parts: [] }, ...overrides };
}

test('reserves only when all selected episodes are absent in one fresh complete observation', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    const result = await reserveMissingTargets({ request, candidate, episodeIds: [1001, 1002],
      readEvidence: async () => evidence(), publicLibraryIds: [102],
      ledger: acquisitions, now: () => 101 });
    assert.equal(result.state, 'reserved');
    assert.deepEqual(acquisitions.getAttempt(result.attemptId).episodeIds, [1001, 1002]);
  }));

test('an empty Shoko and Plex snapshot without a settled import fence cannot reserve', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    const result = await reserveMissingTargets({ request, candidate,
      episodeIds: [1001], readEvidence: async () => evidence({ episodeIds: [1001],
        importFence: null }),
      publicLibraryIds: [102], ledger: acquisitions, now: () => 101 });
    assert.deepEqual(result, { state: 'held', reason: 'import_activity_unverified' });
    assert.equal(acquisitions.getAttempt(1), null);
  }));

test('an observed quiet window authorizes only the explicit one-attempt first-time policy', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    const snapshot = evidence({ episodeIds: [1001], observedAtMs: 120_100,
      shoko: { state: 'unimported_targets', anidbId: 42, episodeIds: [1001] },
      plex: { state: 'healthy_unconfirmed', libraryIds: [102], parts: [],
        complete: false, probeCoverage: 'health_only', sourceVerified: true },
      importFence: { state: 'quiet_window_observed', anidbId: 42,
        episodeIds: [1001], beforeObservedAtMs: 100,
        afterObservedAtMs: 120_100 } });
    const input = { request, candidate, episodeIds: [1001],
      readEvidence: async () => snapshot, publicLibraryIds: [102],
      ledger: acquisitions, now: () => 120_101 };
    assert.deepEqual(await reserveMissingTargets(input),
      { state: 'held', reason: 'target_not_proven_missing', episodeId: 1001 });
    const allowed = await reserveMissingTargets({ ...input,
      firstTimePolicy: 'single_uncertain_attempt' });
    assert.equal(allowed.state, 'reserved');
    assert.equal(acquisitions.getAttempt(allowed.attemptId).evidencePolicy,
      'first_time_permissive');
  }));

test('queue idleness, wrong-target and out-of-order import fences do not prove absence', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    for (const importFence of [
      { state: 'queue_idle_unverified', anidbId: 42,
        episodeIds: [1001], beforeObservedAtMs: 99, afterObservedAtMs: 100 },
      { state: 'settled', anidbId: 99,
        episodeIds: [1001], beforeObservedAtMs: 99, afterObservedAtMs: 100 },
      { state: 'settled', anidbId: 42,
        episodeIds: [1001], beforeObservedAtMs: 101, afterObservedAtMs: 102 },
    ]) {
      const result = await reserveMissingTargets({ request, candidate,
        episodeIds: [1001], readEvidence: async () => evidence({
          episodeIds: [1001], importFence }),
        publicLibraryIds: [102], ledger: acquisitions, now: () => 101 });
      assert.deepEqual(result, { state: 'held', reason: 'import_activity_unverified' });
    }
    assert.equal(acquisitions.getAttempt(1), null);
  }));

test('an already playable episode blocks the entire candidate before any claim', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    const blocked = await reserveMissingTargets({ request, candidate, episodeIds: [1001, 1002],
      readEvidence: async () => evidence({ shoko: { state: 'ok', complete: true, files: [file] },
        plex: { state: 'ok', complete: true, parts: [part] } }),
      publicLibraryIds: [102], ledger: acquisitions, now: () => 101 });
    assert.deepEqual(blocked, { state: 'held', reason: 'target_already_available', episodeId: 1001 });
    const next = acquisitions.reserve({ requestId: request.id, candidate,
      episodeIds: [1001], nowMs: 102 });
    assert.equal(next.state, 'reserved');
  }));

test('a generic Shoko 404 never proves its requested episode absent', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    const result = await reserveMissingTargets({ request, candidate,
      episodeIds: [1001], readEvidence: async () => evidence({
        episodeIds: [1001], shoko: { state: 'not_imported' },
      }), publicLibraryIds: [102], ledger: acquisitions, now: () => 101 });
    assert.deepEqual(result, { state: 'held',
      reason: 'target_not_proven_missing', episodeId: 1001 });
    assert.equal(acquisitions.getAttempt(1), null);
  }));

test('exact catalogue-verified first-time targets can reserve only with complete Plex and settled import evidence', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    const result = await reserveMissingTargets({ request, candidate,
      episodeIds: [1001, 1002], readEvidence: async () => evidence({
        shoko: await collectUnimportedTargets({ anidbId: 42,
          episodeIds: [1001, 1002], readEpisode: async (target) =>
            ({ state: 'not_imported', ...target }) }),
        plex: { state: 'ok', complete: true, libraryIds: [102], parts: [] },
      }), publicLibraryIds: [102], ledger: acquisitions, now: () => 101 });
    assert.equal(result.state, 'reserved');
    assert.deepEqual(acquisitions.getAttempt(result.attemptId).episodeIds,
      [1001, 1002]);
  }));

test('first-time evidence for a different episode or an unverified public section remains held', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    for (const override of [
      { shoko: { state: 'unimported_targets', anidbId: 42,
        episodeIds: [1001] } },
      { shoko: { state: 'unimported_targets', anidbId: 99,
        episodeIds: [1001, 1002] } },
      { shoko: { state: 'unimported_targets', anidbId: 42,
        episodeIds: [1001, 1002] }, plex: { state: 'unavailable' } },
      { shoko: { state: 'unimported_targets', anidbId: 42,
        episodeIds: [1001, 1002] }, plex: { state: 'ok', complete: true,
        libraryIds: [103], parts: [] } },
      { shoko: { state: 'unimported_targets', anidbId: 42,
        episodeIds: [1001, 1002] }, plex: { state: 'ok', complete: true,
        libraryIds: [102], parts: [part] } },
    ]) {
      const result = await reserveMissingTargets({ request, candidate,
        episodeIds: [1001, 1002], readEvidence: async () => evidence(override),
        publicLibraryIds: [102], ledger: acquisitions, now: () => 101 });
      assert.equal(result.state, 'held');
    }
    assert.equal(acquisitions.getAttempt(1), null);
  }));

test('an AniDB movie target uses the same first-time gate', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    const result = await reserveMissingTargets({ request, candidate,
      episodeIds: [1001], readEvidence: async () => evidence({
        episodeIds: [1001], shoko: { state: 'unimported_targets',
          anidbId: 42, episodeIds: [1001] },
        plex: { state: 'ok', complete: true,
          libraryIds: [102, 123], parts: [] },
      }), publicLibraryIds: [102, 123], ledger: acquisitions,
      now: () => 101 });
    assert.equal(result.state, 'reserved');
  }, 'movie'));

test('explicit first-time uncertainty policy permits one bounded target attempt with healthy but non-exhaustive Plex', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    const snapshot = evidence({ episodeIds: [1001],
      shoko: { state: 'unimported_targets', anidbId: 42,
        episodeIds: [1001] },
      plex: { state: 'healthy_unconfirmed', libraryIds: [102],
        parts: [], complete: false, probeCoverage: 'health_only',
        sourceVerified: true } });
    const input = { request, episodeIds: [1001],
      readEvidence: async () => snapshot, publicLibraryIds: [102],
      ledger: acquisitions, now: () => 101,
      firstTimePolicy: 'single_uncertain_attempt' };
    const first = await reserveMissingTargets({ ...input, candidate });
    assert.equal(first.state, 'reserved');
    assert.equal(acquisitions.getAttempt(first.attemptId).evidencePolicy,
      'first_time_permissive');
    assert.deepEqual(acquisitions.releaseReserved({ attemptId: first.attemptId,
      nowMs: 102 }), { state: 'released_pre_dispatch' });
    const second = await reserveMissingTargets({ ...input,
      candidate: { indexerId: 7, guid: 'second-uncertain-release' } });
    assert.equal(second.state, 'reserved');
    assert.deepEqual(await reserveMissingTargets({ ...input,
      candidate: { indexerId: 7, guid: 'third-uncertain-release' } }),
    { state: 'held', reason: 'uncertain_attempt_exhausted' });
  }));

test('first-time uncertainty never treats a Plex outage, visible part, or missing fence as acquisition permission', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    const base = evidence({ episodeIds: [1001],
      shoko: { state: 'unimported_targets', anidbId: 42,
        episodeIds: [1001] },
      plex: { state: 'healthy_unconfirmed', libraryIds: [102],
        parts: [], complete: false, probeCoverage: 'health_only',
        sourceVerified: true } });
    for (const override of [
      { plex: { state: 'unavailable' } },
      { plex: { state: 'healthy_unconfirmed', libraryIds: [103],
        parts: [] } },
      { plex: { state: 'healthy_unconfirmed', libraryIds: [102],
        parts: [part] } },
      { plex: { state: 'healthy_unconfirmed', libraryIds: [102],
        parts: [], complete: false } },
      { importFence: null },
    ]) {
      const result = await reserveMissingTargets({ request, candidate,
        episodeIds: [1001], readEvidence: async () => ({ ...base,
          ...override }), publicLibraryIds: [102], ledger: acquisitions,
        firstTimePolicy: 'single_uncertain_attempt', now: () => 101 });
      assert.equal(result.state, 'held');
    }
    assert.equal(acquisitions.getAttempt(1), null);
  }));

test('incomplete, stale, or unrelated observations never authorize a grab', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    for (const snapshot of [
      evidence({ shoko: { state: 'unavailable' } }),
      evidence({ observedAtMs: 0 }),
      evidence({ episodeIds: [1001] }),
      evidence({ shoko: { state: 'ok', complete: true, files: [file] } }),
    ]) {
      const result = await reserveMissingTargets({ request, candidate, episodeIds: [1001, 1002],
        readEvidence: async () => snapshot, publicLibraryIds: [102],
        ledger: acquisitions, now: () => snapshot.observedAtMs === 0 ? 31_000 : 101 });
      assert.equal(result.state, 'held');
    }
    assert.equal(acquisitions.getAttempt(1), null);
  }));

test('a Plex part without a Shoko identity blocks acquisition as a possible pending import', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    const result = await reserveMissingTargets({ request, candidate,
      episodeIds: [1001, 1002], readEvidence: async () => evidence({
        plex: { state: 'ok', complete: true, parts: [part] },
      }), publicLibraryIds: [102], ledger: acquisitions, now: () => 101 });
    assert.deepEqual(result, { state: 'held', reason: 'unattributed_plex_part' });
    assert.equal(acquisitions.getAttempt(1), null);
  }));

test('an unrelated Shoko file cannot hide an unattributed public Plex part', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    const result = await reserveMissingTargets({ request, candidate,
      episodeIds: [1001, 1002], readEvidence: async () => evidence({
        shoko: { state: 'ok', complete: true, files: [{ ...file,
          anidbId: 99, episodeIds: [9001],
          coverage: [{ episodeId: 9001, start: 0, end: 100 }] }] },
        plex: { state: 'ok', complete: true, parts: [{ ...part,
          storageKey: 'unidentified-video' }] },
      }), publicLibraryIds: [102], ledger: acquisitions, now: () => 101 });
    assert.deepEqual(result, { state: 'held', reason: 'unattributed_plex_part' });
    assert.equal(acquisitions.getAttempt(1), null);
  }));

test('a public part backed by a wrong-show Shoko identity cannot authorize a duplicate', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    const result = await reserveMissingTargets({ request, candidate,
      episodeIds: [1001], readEvidence: async () => evidence({ episodeIds: [1001],
        shoko: { state: 'ok', complete: true, files: [{ ...file,
          anidbId: 99, episodeIds: [9001],
          coverage: [{ episodeId: 9001, start: 0, end: 100 }] }] },
        plex: { state: 'ok', complete: true, parts: [part] },
      }), publicLibraryIds: [102], ledger: acquisitions, now: () => 101 });
    assert.deepEqual(result, { state: 'held', reason: 'unattributed_plex_part' });
    assert.equal(acquisitions.getAttempt(1), null);
  }));

test('freshness clock is read after the observer finishes', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    let observed = false;
    const result = await reserveMissingTargets({ request, candidate, episodeIds: [1001],
      readEvidence: async () => { observed = true; return evidence({ episodeIds: [1001] }); },
      publicLibraryIds: [102], ledger: acquisitions,
      now: () => { assert.equal(observed, true); return 101; } });
    assert.equal(result.state, 'reserved');
  }));
