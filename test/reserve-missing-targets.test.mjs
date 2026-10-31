import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { reserveMissingTargets } from '../src/acquisition/reserve-missing-targets.mjs';

const candidate = { indexerId: 7, guid: 'candidate-for-two-episodes' };
const file = { fileId: 91, anidbId: 42, episodeIds: [1001],
  coverage: [{ episodeId: 1001, start: 0, end: 100 }], storageKey: 'same-video' };
const part = { storageKey: 'same-video', libraryId: 102, readable: true };

async function withLedgers(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-missing-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'missing-gate', nowMs: 10,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
      episodeIds: [1001, 1002] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  try { await run({ request: requests.getRequest(saved.requestId), acquisitions }); }
  finally { acquisitions.close(); requests.close(); await rm(dir, { recursive: true, force: true }); }
}

function evidence(overrides = {}) {
  return { anidbId: 42, episodeIds: [1001, 1002], observedAtMs: 100,
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

test('freshness clock is read after the observer finishes', async () =>
  withLedgers(async ({ request, acquisitions }) => {
    let observed = false;
    const result = await reserveMissingTargets({ request, candidate, episodeIds: [1001],
      readEvidence: async () => { observed = true; return evidence({ episodeIds: [1001] }); },
      publicLibraryIds: [102], ledger: acquisitions,
      now: () => { assert.equal(observed, true); return 101; } });
    assert.equal(result.state, 'reserved');
  }));
