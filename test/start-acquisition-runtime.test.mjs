import assert from 'node:assert/strict';
import test from 'node:test';
import { startAcquisitionRuntime } from '../src/acquisition/start-acquisition-runtime.mjs';

const acquisition = { stagingHostPath: '/staging', holdingRoot: '/holding',
  importRoot: '/import/Negev', qbitStagingRoot: '/data/torrents/negev',
  shokoProviderId: '11111111-2222-3333-4444-555555555555' };

test('disabled account startup never constructs an acquisition worker', async () => {
  const result = await startAcquisitionRuntime({
    config: { acquisitionRuntime: false },
    service: { openAcquisitionWorkers: () => { throw Error('worker opened'); } },
    sessionGate: null,
  });
  assert.equal(result, null);
});

test('enabled startup passes only guarded paths and waits for journal reconciliation', async () => {
  const calls = [];
  const runtime = { start: async () => {
    calls.push('reconcile');
    return { state: 'reconciled' };
  } };
  const sessionGate = { run: async () => {} };
  const realpathImpl = async (value) => value;
  let childReady = false;
  const result = await startAcquisitionRuntime({
    config: { acquisitionRuntime: true, acquisition,
      qbitSidecar: { baseUrl: 'http://qbit.internal:8080' } },
    service: { openAcquisitionWorkers: (input) => {
      calls.push(input);
      return runtime;
    } },
    sessionGate,
    ensureChild: async (input) => {
      assert.deepEqual(input, { holdingRoot: '/holding',
        importRoot: '/import/Negev' });
      childReady = true;
      return { state: 'import_child_ready' };
    },
    verifyRoot: async (input) => {
      assert.equal(childReady, true);
      assert.deepEqual(input, { stagingRoot: '/staging',
        holdingRoot: '/holding', importRoot: '/import/Negev' });
      return { state: 'verified_staging_root' };
    },
    realpathImpl,
  });
  assert.equal(result, runtime);
  const { verifyStagingRoot, ...providers } = calls[0];
  assert.deepEqual(await verifyStagingRoot(), { state: 'verified_staging_root' });
  assert.deepEqual([providers, calls[1]], [{ qbBaseUrl: 'http://qbit.internal:8080', sessionGate,
    stagingHostPath: acquisition.stagingHostPath,
    qbitStagingRoot: acquisition.qbitStagingRoot,
    holdingRoot: acquisition.holdingRoot, importRoot: acquisition.importRoot,
    realpathImpl,
    shokoProviderId: acquisition.shokoProviderId }, 'reconcile']);
});

test('a missing Import child holds the staging gate before any root approval', async () => {
  let checked = 0;
  let gate;
  await startAcquisitionRuntime({
    config: { acquisitionRuntime: true, acquisition,
      qbitSidecar: { baseUrl: 'http://qbit.internal:8080' } },
    service: { openAcquisitionWorkers: ({ verifyStagingRoot }) => {
      gate = verifyStagingRoot;
      return { start: async () => ({ state: 'held' }) };
    } },
    sessionGate: {},
    ensureChild: async () => ({ state: 'held' }),
    verifyRoot: async () => { checked++; return { state: 'verified_staging_root' }; },
  });
  assert.deepEqual(await gate(), { state: 'held',
    reason: 'import_child_unavailable' });
  assert.equal(checked, 0);
});

test('held acquisition recovery leaves the request site able to start while retrying', async () => {
  let stopped = 0;
  const runtime = {
    start: async () => ({ state: 'held', reason: 'reconciliation_incomplete' }),
    stop: async () => { stopped++; },
  };
  const result = await startAcquisitionRuntime({
    config: { acquisitionRuntime: true, acquisition,
      qbitSidecar: { baseUrl: 'http://qbit.internal:8080' } },
    service: { openAcquisitionWorkers: () => runtime },
    sessionGate: {},
    realpathImpl: async (value) => value,
  });
  assert.equal(result, runtime);
  assert.equal(stopped, 0);
});

test('startup stops its worker when reconciliation throws', async () => {
  let stopped = 0;
  await assert.rejects(startAcquisitionRuntime({
    config: { acquisitionRuntime: true, acquisition,
      qbitSidecar: { baseUrl: 'http://qbit.internal:8080' } },
    service: { openAcquisitionWorkers: () => ({
      start: async () => { throw new Error('journal unavailable'); },
      stop: async () => { stopped++; },
    }) },
    sessionGate: {},
    realpathImpl: async (value) => value,
  }), /journal unavailable/);
  assert.equal(stopped, 1);
});
