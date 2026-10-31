import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pollAiringWatches } from '../src/requests/airing-watch-poll.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';

const details = (anidbId, extra = {}) => ({ state: 'details', anidbId,
  kind: 'series', airDate: '2026-01-01', endDate: null, episodeCount: 12,
  complete: true, total: 2, episodes: [
    { id: 1001, type: 'Episode', airDate: '2026-01-01' },
    { id: 1002, type: 'Episode', airDate: '2026-02-01' },
  ], ...extra });

test('one unavailable show holds while the next airing show advances', async () => {
  const calls = [];
  const result = await pollAiringWatches({ today: '2026-01-20',
    ledger: { listActiveAirings: () => [
      { requestId: 1, anidbId: 41 }, { requestId: 2, anidbId: 42 }],
      advanceAiring: (value) => { calls.push(value); return { state: 'advanced' }; } },
    loadDetail: async ({ anidbId }) => anidbId === 41
      ? { state: 'unavailable' } : details(anidbId),
    intervalMs: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requestId, 2);
  assert.equal(calls[0].releaseState, 'airing');
  assert.deepEqual(result.results.map((item) => item.state), ['held', 'advanced']);
  assert.equal(result.nextAfterId, null);
});

test('episode-count inference alone cannot close a watch; explicit past end date can', async () => {
  const endings = [details(42, { episodeCount: 2,
    episodes: [{ id: 1001, type: 'Episode', airDate: '2026-01-01' },
      { id: 1002, type: 'Episode', airDate: '2026-01-10' }] }),
  details(43, { endDate: '2026-02-15' })];
  const calls = [];
  const result = await pollAiringWatches({ today: '2026-02-20',
    ledger: { listActiveAirings: () => [
      { requestId: 1, anidbId: 42 }, { requestId: 2, anidbId: 43 }],
      advanceAiring: (value) => { calls.push(value); return { state: 'advanced' }; } },
    loadDetail: async ({ anidbId }) => endings.find((item) => item.anidbId === anidbId),
    intervalMs: 0 });
  assert.deepEqual(result.results.map((item) => item.state), ['advanced', 'advanced']);
  assert.equal(result.results[0].reason, 'completion_unconfirmed');
  assert.deepEqual(calls.map((item) => item.releaseState), ['airing', 'completed']);
});

test('a poll is bounded, serial, and pages by request ID', async () => {
  let active = 0;
  let peak = 0;
  const seen = [];
  const result = await pollAiringWatches({ today: '2026-01-20', afterId: 9,
    limit: 2, intervalMs: 0,
    ledger: { listActiveAirings: ({ afterId, limit }) => {
      assert.deepEqual([afterId, limit], [9, 2]);
      return [{ requestId: 10, anidbId: 42 }, { requestId: 11, anidbId: 43 }];
    }, advanceAiring: ({ requestId }) => { seen.push(requestId); return { state: 'advanced' }; } },
    loadDetail: async ({ anidbId }) => { active++; peak = Math.max(peak, active);
      await Promise.resolve(); active--; return details(anidbId); } });
  assert.equal(peak, 1);
  assert.deepEqual(seen, [10, 11]);
  assert.equal(result.nextAfterId, 11);
});

test('two users watching one installment share one catalogue read per page', async () => {
  let reads = 0;
  const advances = [];
  const result = await pollAiringWatches({ today: '2026-01-20', intervalMs: 0,
    ledger: { listActiveAirings: () => [
      { requestId: 1, anidbId: 42 }, { requestId: 2, anidbId: 42 }],
      advanceAiring: ({ requestId }) => { advances.push(requestId);
        return { state: 'advanced' }; } },
    loadDetail: async () => { reads++; return details(42); } });
  assert.equal(reads, 1);
  assert.deepEqual(advances, [1, 2]);
  assert.deepEqual(result.results.map((item) => item.state), ['advanced', 'advanced']);
});

test('one catalogue poll advances two durable requests without duplicate targets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'negev-airing-poll-'));
  const ledger = openRequestLedger(path.join(root, 'requests.sqlite'));
  try {
    const intent = { state: 'ready', anidbId: 42, kind: 'series',
      monitorFuture: true, episodeIds: [1001] };
    const first = ledger.submit({ requesterId: 1, requestKey: 'first',
      intent, nowMs: 1 });
    const second = ledger.submit({ requesterId: 2, requestKey: 'second',
      intent, nowMs: 2 });
    let reads = 0;
    const result = await pollAiringWatches({ ledger, today: '2026-02-20',
      intervalMs: 0, loadDetail: async () => { reads++; return details(42); } });
    assert.equal(result.state, 'page');
    assert.equal(reads, 1);
    assert.deepEqual(ledger.getRequest(first.requestId).episodeIds, [1001, 1002]);
    assert.deepEqual(ledger.getRequest(second.requestId).episodeIds, [1001, 1002]);
    assert.equal(ledger.countTargets(), 2);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});
