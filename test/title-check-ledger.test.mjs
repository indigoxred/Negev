import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openTitleCheckLedger } from '../src/availability/title-check-ledger.mjs';

const cleanup = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((dir) => rm(dir,
  { recursive: true, force: true }))));
async function ledger() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-title-check-'));
  cleanup.push(dir);
  const dbPath = path.join(dir, 'negev.sqlite');
  return { dbPath, job: openTitleCheckLedger(dbPath) };
}
const detail = ({ page = 1, ids = [1001, 1002], total = ids.length,
  nextPage = null } = {}) => ({ state: 'details', anidbId: 42,
  kind: 'series', page, total, nextPage,
  episodes: ids.map((id) => ({ id })) });

test('two users share one durable title check and a restart resumes it', async () => {
  const { dbPath, job } = await ledger();
  assert.deepEqual(job.start({ anidbId: 42, nowMs: 1 }),
    { state: 'queued', generation: 1 });
  assert.deepEqual(job.start({ anidbId: 42, nowMs: 2 }),
    { state: 'shared', generation: 1 });
  const page = job.claimNext({ nowMs: 3 });
  assert.deepEqual({ state: page.state, page: page.page },
    { state: 'claimed_page', page: 1 });
  assert.deepEqual(job.recordPage({ claim: page, detail: detail(),
    checkedMs: 4 }), { state: 'recorded_page' });
  job.close();
  const reopened = openTitleCheckLedger(dbPath);
  const target = reopened.claimNext({ nowMs: 5 });
  assert.deepEqual({ state: target.state, episodeId: target.episodeId },
    { state: 'claimed_target', episodeId: 1001 });
  assert.deepEqual(reopened.recordTarget({ claim: target,
    status: 'available', checkedMs: 6 }), { state: 'recorded_target' });
  assert.equal(reopened.getProgress({ anidbId: 42,
    nowMs: 7 }).checkedCount, 1);
  reopened.close();
});

test('a crashed claim is retried after its lease; stale result is rejected', async () => {
  const { job } = await ledger();
  job.start({ anidbId: 42, nowMs: 1 });
  const stale = job.claimNext({ nowMs: 2 });
  assert.deepEqual(job.claimNext({ nowMs: 3 }), { state: 'idle' });
  const current = job.claimNext({ nowMs: 2 + 10 * 60_000 });
  assert.equal(current.state, 'claimed_page');
  assert.deepEqual(job.recordPage({ claim: stale, detail: detail(),
    checkedMs: 2 + 10 * 60_000 }),
  { state: 'held', reason: 'stale_claim' });
  assert.deepEqual(job.recordPage({ claim: current, detail: detail(),
    checkedMs: 2 + 10 * 60_000 + 1 }), { state: 'recorded_page' });
  job.close();
});

test('page identity and total must remain stable across catalogue pages', async () => {
  const { job } = await ledger();
  job.start({ anidbId: 42, nowMs: 1 });
  const first = job.claimNext({ nowMs: 2 });
  assert.deepEqual(job.recordPage({ claim: first,
    detail: detail({ ids: [1001], total: 2, nextPage: 2 }),
    checkedMs: 3 }), { state: 'recorded_page' });
  const second = job.claimNext({ nowMs: 4 });
  assert.equal(second.page, 2);
  assert.deepEqual(job.recordPage({ claim: second,
    detail: detail({ page: 2, ids: [1001], total: 2 }),
    checkedMs: 5 }), { state: 'held', reason: 'catalogue_changed' });
  assert.equal(job.getProgress({ anidbId: 42, nowMs: 6 }).state, 'held');
  job.close();
});

test('finished positive results expire without turning Unknown into Missing', async () => {
  const { job } = await ledger();
  job.start({ anidbId: 42, nowMs: 1 });
  const page = job.claimNext({ nowMs: 2 });
  job.recordPage({ claim: page, detail: detail({ ids: [1001] }), checkedMs: 3 });
  const target = job.claimNext({ nowMs: 4 });
  job.recordTarget({ claim: target, status: 'available', checkedMs: 5 });
  assert.deepEqual(job.getProgress({ anidbId: 42, nowMs: 6 }),
    { state: 'done', generation: 1, totalCount: 1, checkedCount: 1,
      recentAvailableCount: 1 });
  assert.equal(job.getProgress({ anidbId: 42,
    nowMs: 30 * 60_000 + 6 }).recentAvailableCount, 0);
  assert.deepEqual(job.start({ anidbId: 42, nowMs: 30 * 60_000 + 7 }),
    { state: 'queued', generation: 2 });
  job.close();
});

test('malformed or oversized catalogue page becomes held without partial targets', async () => {
  for (const invalid of [null, { state: 'unavailable' },
    detail({ ids: [1001], total: 10_001 }),
    detail({ ids: [0] }),
    detail({ ids: [], total: 1, nextPage: 2 })]) {
    const { job } = await ledger();
    job.start({ anidbId: 42, nowMs: 1 });
    const page = job.claimNext({ nowMs: 2 });
    assert.deepEqual(job.recordPage({ claim: page, detail: invalid,
      checkedMs: 3 }), { state: 'held', reason: 'catalogue_changed' });
    assert.equal(job.getProgress({ anidbId: 42, nowMs: 4 }).checkedCount, 0);
    job.close();
  }
});

test('a result from an earlier generation cannot overwrite a restarted title', async () => {
  const { job } = await ledger();
  job.start({ anidbId: 42, nowMs: 1 });
  const page = job.claimNext({ nowMs: 2 });
  job.recordPage({ claim: page, detail: detail({ ids: [1001] }), checkedMs: 3 });
  const old = job.claimNext({ nowMs: 4 });
  job.recordTarget({ claim: old, status: 'unknown', checkedMs: 5 });
  job.start({ anidbId: 42, nowMs: 6 });
  assert.deepEqual(job.recordTarget({ claim: old,
    status: 'available', checkedMs: 7 }),
  { state: 'held', reason: 'stale_claim' });
  assert.equal(job.getProgress({ anidbId: 42, nowMs: 8 }).generation, 2);
  job.close();
});
