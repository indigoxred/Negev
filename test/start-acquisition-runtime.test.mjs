import assert from 'node:assert/strict';
import test from 'node:test';
import { startAcquisitionRuntime } from '../src/acquisition/start-acquisition-runtime.mjs';

const acquisition = { stagingHostPath: '/staging', holdingRoot: '/holding',
  importRoot: '/import/Negev', mountWitnessSocket: '/data/mount-witness/mount.sock',
  shokoProviderId: '11111111-2222-3333-4444-555555555555' };

test('disabled account startup never constructs a mount witness or acquisition worker', async () => {
  const result = await startAcquisitionRuntime({
    config: { acquisitionRuntime: false },
    service: { openAcquisitionWorkers: () => { throw Error('worker opened'); } },
    sessionGate: null,
    makeInspector: () => { throw Error('witness opened'); },
  });
  assert.equal(result, null);
});

test('enabled startup passes only guarded paths and waits for journal reconciliation', async () => {
  const calls = [];
  const inspector = async () => ({ state: 'mount_evidence' });
  const runtime = { start: async () => {
    calls.push('reconcile');
    return { state: 'reconciled' };
  } };
  const sessionGate = { run: async () => {} };
  const realpathImpl = async (value) => value;
  const result = await startAcquisitionRuntime({
    config: { acquisitionRuntime: true, acquisition,
      qbitSidecar: { baseUrl: 'http://qbit.internal:8080' } },
    service: { openAcquisitionWorkers: (input) => {
      calls.push(input);
      return runtime;
    } },
    sessionGate,
    makeInspector: ({ socketPath }) => {
      assert.equal(socketPath, acquisition.mountWitnessSocket);
      return inspector;
    },
    realpathImpl,
  });
  assert.equal(result, runtime);
  assert.deepEqual(calls, [{ qbBaseUrl: 'http://qbit.internal:8080', sessionGate,
    stagingHostPath: acquisition.stagingHostPath,
    holdingRoot: acquisition.holdingRoot, importRoot: acquisition.importRoot,
    inspectMounts: inspector, realpathImpl,
    shokoProviderId: acquisition.shokoProviderId }, 'reconcile']);
});

test('enabled startup fails closed when recovery does not finish', async () => {
  let stopped = 0;
  await assert.rejects(startAcquisitionRuntime({
    config: { acquisitionRuntime: true, acquisition,
      qbitSidecar: { baseUrl: 'http://qbit.internal:8080' } },
    service: { openAcquisitionWorkers: () => ({
      start: async () => ({ state: 'held' }),
      stop: async () => { stopped++; },
    }) },
    sessionGate: {}, makeInspector: () => async () => {},
    realpathImpl: async (value) => value,
  }), /reconciliation/);
  assert.equal(stopped, 1);
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
    sessionGate: {}, makeInspector: () => async () => {},
    realpathImpl: async (value) => value,
  }), /journal unavailable/);
  assert.equal(stopped, 1);
});
