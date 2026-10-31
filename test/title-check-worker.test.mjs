import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openTitleCheckLedger } from '../src/availability/title-check-ledger.mjs';
import { createTitleCheckWorker } from '../src/availability/title-check-worker.mjs';

const cleanup = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((dir) => rm(dir,
  { recursive: true, force: true }))));
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-title-worker-'));
  cleanup.push(dir);
  const ledger = openTitleCheckLedger(path.join(dir, 'negev.sqlite'));
  ledger.start({ anidbId: 42, nowMs: 1 });
  return ledger;
}

test('one paced tick loads a page or verifies one exact target', async () => {
  const ledger = await setup();
  let clock = 2;
  const observed = [];
  const worker = createTitleCheckWorker({ ledger, now: () => clock++,
    loadDetail: async ({ anidbId, page }) => ({ state: 'details',
      anidbId, page, kind: 'series', total: 2, nextPage: null,
      episodes: [{ id: 1001 }, { id: 1002 }] }),
    observeTarget: async (target) => {
      observed.push(target);
      return target.episodeId === 1001 ? { state: 'available' } :
        { state: 'unknown' };
    },
  });
  assert.deepEqual(await worker.runOnce(), { state: 'page_loaded',
    anidbId: 42, page: 1 });
  assert.deepEqual(await worker.runOnce(), { state: 'target_checked',
    anidbId: 42, episodeId: 1001, result: 'available' });
  assert.deepEqual(await worker.runOnce(), { state: 'target_checked',
    anidbId: 42, episodeId: 1002, result: 'unknown' });
  assert.deepEqual(observed, [
    { anidbId: 42, episodeId: 1001, kind: 'series' },
    { anidbId: 42, episodeId: 1002, kind: 'series' },
  ]);
  assert.equal(ledger.getProgress({ anidbId: 42, nowMs: clock }).state, 'done');
  ledger.close();
});

test('transient Shoko page outage defers without inventing a title result', async () => {
  const ledger = await setup();
  let clock = 2;
  let ready = false;
  const worker = createTitleCheckWorker({ ledger, now: () => clock,
    loadDetail: async () => ready ? { state: 'details', anidbId: 42,
      page: 1, kind: 'movie', total: 1, nextPage: null,
      episodes: [{ id: 1001 }] } : { state: 'unavailable' },
    observeTarget: async () => ({ state: 'unknown' }),
  });
  assert.deepEqual(await worker.runOnce(), { state: 'deferred',
    reason: 'catalogue_unavailable' });
  assert.deepEqual(await worker.runOnce(), { state: 'idle' });
  clock += 5 * 60_000;
  ready = true;
  assert.equal((await worker.runOnce()).state, 'page_loaded');
  ledger.close();
});
