import assert from 'node:assert/strict';
import test from 'node:test';
import { runStalledRetirement } from '../src/acquisition/run-stalled-retirement.mjs';

const hash = 'a'.repeat(40);
const input = { attemptId: 7, hash, baseUrl: 'http://qb.local/',
  stagingRoot: '/staging', saveRoot: '/Downloads/negev',
  now: () => 300, verifyStagingRoot: async () => ({ state: 'verified_staging_root' }),
  sessionGate: { get: async () => ({ state: 'authenticated', sessionId: 'SID123' }) } };

test('operator retirement requests, sends once, then proves absence before freeing claim', async () => {
  const order = [];
  const ledger = {
    getAttempt: () => ({ id: 7, status: 'torrent_observed',
      expectedHash: hash, torrentHash: hash }),
    requestStalledRetirement: () => { order.push('request');
      return { state: 'retirement_requested' }; },
    cancelStalledRetirement: () => { throw Error('unexpected cancel'); },
  };
  const result = await runStalledRetirement({ ...input, ledger,
    deleteImpl: async () => { order.push('delete');
      return { state: 'delete_unknown', sendNow: true }; },
    reconcileImpl: async () => { order.push('reconcile');
      return { state: 'retired_stalled' }; } });
  assert.deepEqual(result, { state: 'retired_stalled' });
  assert.deepEqual(order, ['request', 'delete', 'reconcile']);
});

test('failed preflight cancels the unsent request and preserves the torrent', async () => {
  const order = [];
  const ledger = {
    getAttempt: () => ({ id: 7, status: 'torrent_observed',
      expectedHash: hash, torrentHash: hash }),
    requestStalledRetirement: () => { order.push('request');
      return { state: 'retirement_requested' }; },
    cancelStalledRetirement: () => { order.push('cancel');
      return { state: 'retirement_cancelled' }; },
  };
  const result = await runStalledRetirement({ ...input, ledger,
    deleteImpl: async () => { order.push('preflight');
      return { state: 'held', reason: 'torrent_ownership_changed' }; },
    reconcileImpl: async () => { throw Error('unexpected reconcile'); } });
  assert.deepEqual(result, { state: 'held', reason: 'torrent_ownership_changed' });
  assert.deepEqual(order, ['request', 'preflight', 'cancel']);
});

test('an uncertain saved delete only reconciles and never sends again', async () => {
  const result = await runStalledRetirement({ ...input,
    ledger: { getAttempt: () => ({ id: 7, status: 'torrent_observed',
      expectedHash: hash, torrentHash: hash }),
      requestStalledRetirement: () => ({ state: 'delete_unknown' }),
      cancelStalledRetirement: () => { throw Error('unexpected cancel'); } },
    deleteImpl: async () => ({ state: 'delete_unknown', sendNow: false }),
    reconcileImpl: async () => ({ state: 'held', reason: 'torrent_still_present' }) });
  assert.deepEqual(result, { state: 'held', reason: 'torrent_still_present' });
});

test('a pre-intent error cancels, but a post-intent error preserves uncertainty', async () => {
  for (const status of ['requested', 'delete_unknown']) {
    let cancelled = 0;
    const result = await runStalledRetirement({ ...input,
      ledger: { getAttempt: () => ({ id: 7, status: 'torrent_observed',
        expectedHash: hash, torrentHash: hash }),
        requestStalledRetirement: () => ({ state: 'retirement_requested' }),
        getStalledRetirementIntent: () => ({ hash, status }),
        cancelStalledRetirement: () => { cancelled++; return { state: 'retirement_cancelled' }; } },
      deleteImpl: async () => { throw Error('injected failure'); },
      reconcileImpl: async () => { throw Error('unexpected reconcile'); } });
    assert.deepEqual(result, { state: 'held', reason: 'delete_observation_unavailable' });
    assert.equal(cancelled, status === 'requested' ? 1 : 0);
  }
});
