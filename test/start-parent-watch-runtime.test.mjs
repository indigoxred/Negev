import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeParentRelations, startParentWatchRuntime } from
  '../src/requests/start-parent-watch-runtime.mjs';

test('local and archive relation edges are merged by exact AniDB ID', () => {
  assert.deepEqual(mergeParentRelations(10,
    { state: 'related_titles', anidbId: 10, items: [
      { anidbId: 11, relation: 'Prequel', title: 'Local' }] },
    { state: 'related_titles', anidbId: 10, items: [
      { anidbId: 11, relation: 'Prequel', title: 'Archive' },
      { anidbId: 12, relation: 'Sequel', title: 'New season' }] }),
  { state: 'related_titles', anidbId: 10, items: [
    { anidbId: 11, relation: 'Prequel', title: 'Local' },
    { anidbId: 12, relation: 'Sequel', title: 'New season' }] });
});

test('parent-watch runtime is inert unless explicitly enabled', async () => {
  const result = startParentWatchRuntime({ config: { parentWatch: false },
    openParents: () => { throw new Error('unexpected open'); } });
  assert.equal(result, null);
});

test('enabled runtime starts a paced worker and closes ledgers after its scheduler', async () => {
  const events = [];
  const parent = { close() { events.push('parent-close'); } };
  const requests = { close() { events.push('request-close'); } };
  const accounts = { close() { events.push('account-close'); },
    getActiveUser: ({ userId }) => (userId === 7 ? { adultAllowed: false } : null) };
  const runtime = startParentWatchRuntime({
    config: { parentWatch: true, dbPath: '/private/negev.sqlite',
      shokoBaseUrl: 'http://shoko:8111', timeZone: 'Australia/Sydney' },
    shokoApiKey: 'private',
    openParents: (path) => { assert.equal(path, '/private/negev.sqlite'); return parent; },
    openRequests: () => requests,
    openAccounts: () => accounts,
    createWorker: (input) => {
      assert.equal(input.parents, parent);
      assert.equal(input.requests, requests);
      assert.equal(typeof input.loadDetail, 'function');
      assert.equal(typeof input.readRelations, 'function');
      assert.equal(input.adultAllowed({ requesterId: 7 }), false, 'the owner 18+ check is wired');
      return { runOnce: async () => ({ state: 'page', afterId: 0 }) };
    },
    createScheduler: ({ runPage, pageDelayMs, cycleDelayMs }) => {
      assert.equal(typeof runPage, 'function');
      assert.equal(pageDelayMs, 60_000);
      assert.equal(cycleDelayMs, 86_400_000);
      return { start() { events.push('start'); },
        async stop() { events.push('stop'); } };
    },
  });
  assert.deepEqual(events, ['start']);
  await runtime.close();
  assert.deepEqual(events, ['start', 'stop', 'parent-close', 'request-close', 'account-close']);
});

test('failed startup closes both opened ledgers', () => {
  const events = [];
  assert.throws(() => startParentWatchRuntime({
    config: { parentWatch: true, dbPath: '/private/negev.sqlite',
      shokoBaseUrl: 'http://shoko:8111', timeZone: 'Australia/Sydney' },
    shokoApiKey: 'private',
    openParents: () => ({ close() { events.push('parent-close'); } }),
    openRequests: () => ({ close() { events.push('request-close'); } }),
    openAccounts: () => ({ close() { events.push('account-close'); } }),
    createWorker: () => { throw new Error('worker failed'); },
  }), /worker failed/);
  assert.deepEqual(events, ['account-close', 'request-close', 'parent-close']);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openParentWatchLedger } from '../src/requests/parent-watch-ledger.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { createParentWatchWorker } from '../src/requests/parent-watch-worker.mjs';
import { createAiringScheduler } from '../src/requests/airing-scheduler.mjs';

test('actual runtime finishes bounded parent traversal before daily expiry, fairly across restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-parent-runtime-'));
  const dbPath = path.join(dir, 'db.sqlite');
  let nowMs = Date.parse('2026-11-12T00:00:00Z');
  let timer;
  let runtime;
  let reads = [];
  const visits = [];
  const map = { version: 2, anime: [{ anidb_id: 11, tvdb_id: 100 }, { anidb_id: 50, tvdb_id: 200 }] };
  let parents = openParentWatchLedger(dbPath);
  parents.adopt({ tvdbId: 100, requesterId: 7, sourceSeriesId: 42, nowMs });
  parents.adopt({ tvdbId: 200, requesterId: 7, sourceSeriesId: 43, nowMs });
  parents.close();
  const start = () => startParentWatchRuntime({
    config: { parentWatch: true, dbPath, shokoBaseUrl: 'http://unused', timeZone: 'UTC' },
    shokoApiKey: 'test', createMapReader: () => ({ read: async () => map }),
    createArchiveReader: () => ({}),
    createWorker: input => {
      const worker = createParentWatchWorker({ ...input, now: () => nowMs,
        today: () => new Date(nowMs).toISOString().slice(0, 10),
        readRelations: async id => {
          reads.push(id);
          return { state: 'related_titles', anidbId: id, items: id === 50 ? [] : [
            ...(id > 11 ? [{ anidbId: id - 1, relation: 'Prequel' }] : []),
            ...(id < 30 ? [{ anidbId: id + 1, relation: 'Sequel' }] : [])] };
        },
        loadDetail: async ({ anidbId }) => ({ state: 'details', anidbId,
          title: `Anime ${anidbId}`, kind: 'series', restricted: false,
          complete: true, total: 1, airDate: '2026-11-01',
          endDate: [30, 50].includes(anidbId) ? null : '2026-11-02', episodeCount: 12,
          episodes: [{ id: anidbId * 100, type: 'Episode', airDate: '2026-11-01' }] }) });
      return { async runOnce() {
        reads = [];
        const result = await worker.runOnce();
        assert.ok(reads.length <= 12);
        if (result.afterId) visits.push(result.afterId);
        return result;
      } };
    },
    createScheduler: input => createAiringScheduler({ ...input,
      setTimeoutImpl(callback, delay) { timer = { callback, delay }; return 1; },
      clearTimeoutImpl() { timer = null; } }) });
  const fire = async () => { const next = timer; timer = null; nowMs += next.delay; await next.callback(); };
  try {
    runtime = start();
    await fire(); // durable first parent's unfinished traversal
    await runtime.close();
    runtime = start();
    await fire(); // second parent receives its turn after restart
    assert.deepEqual(visits.slice(0, 2), [100, 200]);
    for (let i = 0; i < 20 && timer.delay !== 86_400_000; i++) await fire();
    parents = openParentWatchLedger(dbPath);
    assert.deepEqual(parents.listInstallments({ tvdbId: 100 }).map(x => x.anidbId), [30]);
    assert.deepEqual(parents.listInstallments({ tvdbId: 200 }).map(x => x.anidbId), [50]);
    parents.close(); parents = null;
    assert.equal(timer.delay, 86_400_000, 'completed traversal returns to daily pacing');
    const prior = nowMs;
    await fire(); // real configured daily interval: evidence must be fetched again
    assert.equal(nowMs - prior, 86_400_000);
    assert.ok(reads.includes(11), 'next daily sweep revalidates original seed');
    assert.ok(visits.filter(x => x === 200).length >= 2);
  } finally {
    await runtime?.close(); parents?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
