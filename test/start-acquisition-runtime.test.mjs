import assert from 'node:assert/strict';
import test from 'node:test';
import { startAcquisitionRuntime } from '../src/acquisition/start-acquisition-runtime.mjs';

const acquisition = { stagingHostPath: '/staging', holdingRoot: '/holding',
  importRoot: '/import/Negev', qbitStagingRoot: '/data/torrents/negev',
  shokoSourcePath: '/negev/source', shokoSourceFolderId: 2,
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
      shokoBaseUrl: 'http://shoko.internal:8111/',
      qbitSidecar: { baseUrl: 'http://qbit.internal:8080' } },
    shokoApiKey: 'synthetic',
    service: { openAcquisitionWorkers: (input) => {
      calls.push(input);
      return runtime;
    } },
    sessionGate,
    verifySource: async (input) => {
      assert.deepEqual(input, { baseUrl: 'http://shoko.internal:8111/',
        apiKey: 'synthetic', folderId: 2, shokoPath: '/negev/source' });
      calls.push('source');
      return { state: 'verified_shoko_source' };
    },
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
  const { verifyStagingRoot, verifyShokoSource, ...providers } = calls[0];
  assert.equal(typeof verifyShokoSource, 'function');
  assert.deepEqual(await verifyStagingRoot(), { state: 'verified_staging_root' });
  assert.deepEqual([providers, calls[1]], [{ qbBaseUrl: 'http://qbit.internal:8080', sessionGate,
    stagingHostPath: acquisition.stagingHostPath,
    qbitStagingRoot: acquisition.qbitStagingRoot,
    holdingRoot: acquisition.holdingRoot, importRoot: acquisition.importRoot,
    realpathImpl,
    shokoProviderId: acquisition.shokoProviderId }, 'reconcile']);
  assert.equal(calls[2], 'source');
});

test('private provisional pilot passes the verified Shoko path and explicit opt-in', async () => {
  let opened;
  await startAcquisitionRuntime({
    config: { acquisitionRuntime: true,
      acquisition: { ...acquisition, provisionalFallback: true },
      shokoBaseUrl: 'http://shoko.internal:8111/',
      qbitSidecar: { baseUrl: 'http://qbit.internal:8080' } },
    shokoApiKey: 'synthetic',
    service: { openAcquisitionWorkers: (input) => {
      opened = input;
      return { start: async () => ({ state: 'reconciled' }) };
    } },
    verifySource: async () => ({ state: 'verified_shoko_source' }),
  });
  assert.equal(opened.provisionalFallback, true);
  assert.equal(opened.shokoSourcePath, '/negev/source');
});

test('unverified Shoko source holds before creating a watched import child', async () => {
  let childCalls = 0;
  let gate;
  await startAcquisitionRuntime({
    config: { acquisitionRuntime: true, acquisition,
      shokoBaseUrl: 'http://shoko.internal:8111/',
      qbitSidecar: { baseUrl: 'http://qbit.internal:8080' } },
    shokoApiKey: 'synthetic',
    service: { openAcquisitionWorkers: ({ verifyStagingRoot }) => {
      gate = verifyStagingRoot;
      return { start: async () => ({ state: 'held' }) };
    } },
    sessionGate: {},
    verifySource: async () => ({ state: 'held' }),
    ensureChild: async () => { childCalls++; return { state: 'import_child_ready' }; },
  });
  assert.deepEqual(await gate(), { state: 'held', reason: 'shoko_source_unverified' });
  assert.equal(childCalls, 0);
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
    verifySource: async () => ({ state: 'verified_shoko_source' }),
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
