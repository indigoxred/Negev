import assert from 'node:assert/strict';
import test from 'node:test';
import { runPrestartMismatchRetirement } from
  '../src/acquisition/run-prestart-mismatch-retirement.mjs';

const hash = 'a'.repeat(40);
const attempt = { id: 7, status: 'torrent_observed',
  expectedHash: hash, torrentHash: hash };
const config = { attemptId: 7, hash, baseUrl: 'http://qb.local/',
  stagingRoot: '/staging', saveRoot: '/downloads/negev', now: () => 300,
  verifyStagingRoot: async () => ({ state: 'verified_staging_root' }),
  sessionGate: { get: async () => ({ state: 'authenticated', sessionId: 'SID123' }) } };

test('a proved never-started mismatch removes only its record then reconciles', async () => {
  const steps = [];
  const ledger = { getAttempt: () => attempt,
    requestPrestartMismatchRetirement: () => { steps.push('intent');
      return { state: 'retirement_requested' }; },
    getStalledRetirementIntent: () => ({ hash, status: 'delete_unknown' }),
    cancelStalledRetirement: () => { throw Error('unexpected cancel'); } };
  const result = await runPrestartMismatchRetirement({ ...config, ledger,
    deleteImpl: async () => { steps.push('delete');
      return { state: 'delete_unknown', sendNow: true }; },
    reconcileImpl: async () => { steps.push('reconcile');
      return { state: 'retired_prestart_mismatch' }; } });
  assert.deepEqual(result, { state: 'retired_prestart_mismatch' });
  assert.deepEqual(steps, ['intent', 'delete', 'reconcile']);
});

test('a failed pre-send check cancels intent; an uncertain delete does not', async () => {
  let intentStatus = 'requested';
  let cancellations = 0;
  const ledger = { getAttempt: () => attempt,
    requestPrestartMismatchRetirement: () => ({ state: 'retirement_requested' }),
    getStalledRetirementIntent: () => ({ hash, status: intentStatus }),
    cancelStalledRetirement: () => { cancellations++;
      return { state: 'retirement_cancelled' }; } };
  assert.deepEqual(await runPrestartMismatchRetirement({ ...config, ledger,
    deleteImpl: async () => ({ state: 'held', reason: 'staging_not_empty' }),
    reconcileImpl: async () => { throw Error('unexpected'); } }),
  { state: 'held', reason: 'staging_not_empty' });
  assert.equal(cancellations, 1);
  intentStatus = 'delete_unknown';
  assert.deepEqual(await runPrestartMismatchRetirement({ ...config, ledger,
    deleteImpl: async () => { throw Error('uncertain'); },
    reconcileImpl: async () => { throw Error('unexpected'); } }),
  { state: 'held', reason: 'delete_observation_unavailable' });
  assert.equal(cancellations, 1);
});
