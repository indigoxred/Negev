import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { createAiringPageWorker } from '../src/requests/airing-page-worker.mjs';

test('one page per tick reaches later requests, then returns to the start', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-airing-page-'));
  const ledger = openRequestLedger(path.join(dir, 'requests.sqlite'));
  try {
    const visited = [];
    const worker = createAiringPageWorker({ ledger, pollPage: async ({ afterId, limit }) => {
      visited.push([afterId, limit]);
      return { state: 'page', results: [], nextAfterId: afterId === 0 ? 3 : null };
    } });
    assert.equal((await worker.runOnce()).afterId, 3);
    assert.equal((await worker.runOnce()).afterId, 0);
    assert.equal((await worker.runOnce()).afterId, 3);
    assert.deepEqual(visited, [[0, 3], [3, 3], [0, 3]]);
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('provider failure preserves the page cursor and overlapping ticks do not poll twice', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-airing-page-'));
  const ledger = openRequestLedger(path.join(dir, 'requests.sqlite'));
  try {
    let release;
    let calls = 0;
    const worker = createAiringPageWorker({ ledger, pollPage: () => {
      calls++;
      return new Promise((resolve) => { release = resolve; });
    } });
    const first = worker.runOnce();
    assert.deepEqual(await worker.runOnce(), { state: 'held', reason: 'poll_in_progress' });
    assert.equal(calls, 1);
    release({ state: 'held', reason: 'provider_unavailable' });
    assert.deepEqual(await first, { state: 'held', reason: 'provider_unavailable' });
    assert.equal(ledger.getAiringCursor(), 0);
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});
