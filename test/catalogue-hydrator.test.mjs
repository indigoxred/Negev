import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCatalogueHydrator } from '../src/catalogue/catalogue-hydrator.mjs';
import { openHydrationLedger } from '../src/catalogue/hydration-ledger.mjs';

const nowMs = 1_000_000_000;
const detail = { state: 'details', anidbId: 1234, title: 'Example', kind: 'series',
  complete: true, total: 1, episodes: [{ id: 1001, number: 1, type: 'Episode', title: 'First' }] };

async function withLedger(run) {
  const base = path.resolve(tmpdir());
  const dir = await mkdtemp(path.join(base, 'negev-hydrator-'));
  const ledger = openHydrationLedger(path.join(dir, 'ledger.sqlite'));
  try { await run(ledger); }
  finally {
    ledger.close();
    assert.equal(path.dirname(path.resolve(dir)), base);
    await rm(dir, { recursive: true, force: true });
  }
}

test('one title gets one refresh and a later exact detail closes the claim', async () => withLedger(async (ledger) => {
  let currentDetail = { state: 'detail_pending', anidbId: 1234 };
  let posts = 0;
  const hydrator = createCatalogueHydrator({
    isKnownTitle: async () => true,
    loadDetail: async () => currentDetail,
    ledger, requestHydration: async () => { posts++; return { state: 'queued' }; },
    now: () => nowMs,
  });
  const first = await hydrator.load({ anidbId: 1234 });
  assert.equal(first.state, 'pending');
  assert.equal(first.reason, 'refresh_queued');
  assert.equal(posts, 1);
  assert.deepEqual(await hydrator.load({ anidbId: 1234 }),
    { state: 'pending', reason: 'active_refresh' });
  assert.equal(posts, 1);
  currentDetail = detail;
  const loaded = await hydrator.load({ anidbId: 1234 });
  assert.equal(loaded.state, 'detail_ready');
  assert.equal(loaded.requestable, false);
  assert.equal(ledger.getClaim(first.claimId).status, 'completed');
}));

test('unknown title, Shoko outage and partial detail never submit refreshes', async () => withLedger(async (ledger) => {
  let known = false;
  let currentDetail = { state: 'detail_pending', anidbId: 1234 };
  let posts = 0;
  const hydrator = createCatalogueHydrator({
    isKnownTitle: async () => known,
    loadDetail: async () => currentDetail,
    ledger, requestHydration: async () => { posts++; return { state: 'queued' }; },
    now: () => nowMs,
  });
  assert.deepEqual(await hydrator.load({ anidbId: 1234 }),
    { state: 'held', reason: 'unknown_title' });
  known = true;
  currentDetail = { state: 'unavailable' };
  assert.deepEqual(await hydrator.load({ anidbId: 1234 }),
    { state: 'held', reason: 'detail_unavailable' });
  currentDetail = { ...detail, complete: false };
  assert.deepEqual(await hydrator.load({ anidbId: 1234 }),
    { state: 'pending', reason: 'detail_pagination_required' });
  assert.equal(posts, 0);
}));

test('wrong detail identity and failed POST remain held', async () => withLedger(async (ledger) => {
  let currentDetail = { state: 'detail_pending', anidbId: 1234 };
  const hydrator = createCatalogueHydrator({
    isKnownTitle: async () => true,
    loadDetail: async () => currentDetail,
    ledger, requestHydration: async () => ({ state: 'unavailable' }),
    now: () => nowMs,
  });
  const first = await hydrator.load({ anidbId: 1234 });
  assert.equal(first.state, 'held');
  assert.equal(first.reason, 'refresh_unavailable');
  currentDetail = { ...detail, anidbId: 9999 };
  assert.deepEqual(await hydrator.load({ anidbId: 1234 }),
    { state: 'held', reason: 'invalid_detail_evidence' });
  assert.equal(ledger.getClaim(first.claimId).status, 'reserved');
}));
