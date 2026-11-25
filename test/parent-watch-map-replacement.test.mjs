import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openParentWatchLedger } from '../src/requests/parent-watch-ledger.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { createParentWatchWorker } from '../src/requests/parent-watch-worker.mjs';
import { createAiringScheduler } from '../src/requests/airing-scheduler.mjs';
import { startParentWatchRuntime } from '../src/requests/start-parent-watch-runtime.mjs';

for (const replacementMode of ['omission', 'ambiguity']) test(
  replacementMode === 'omission'
    ? 'valid parent omission retires an old expedited frontier across restart without losing watches'
    : 'ambiguous parent replacement suspends expedited pacing but preserves evidence and watches across restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-parent-omission-'));
  const dbPath = path.join(dir, 'db.sqlite');
  let nowMs = Date.parse('2026-11-25T00:00:00Z');
  let timer, runtime;
  let phase = 'initial';
  let relationReads = 0;
  const visits = [];
  const fullMap = { version: 2, anime: [
    { anidb_id: 11, tvdb_id: 100 }, { anidb_id: 50, tvdb_id: 200 }] };
  let parents = openParentWatchLedger(dbPath);
  for (const tvdbId of [100, 200]) parents.adopt({ tvdbId,
    requesterId: 7, sourceSeriesId: tvdbId + 1, nowMs });
  parents.close();
  const inspect = run => {
    const ledger = openParentWatchLedger(dbPath);
    try { return run(ledger); } finally { ledger.close(); }
  };
  const start = () => startParentWatchRuntime({
    config: { parentWatch: true, dbPath, shokoBaseUrl: 'http://unused', timeZone: 'UTC' },
    shokoApiKey: 'isolated', createArchiveReader: () => ({}),
    createMapReader: () => ({ read: async () => {
      if (phase === 'outage') throw Error('isolated map failure');
      return phase === 'omitted'
        ? { version: 2, anime: replacementMode === 'omission' ? [fullMap.anime[1]] : [
          { anidb_id: 11, tvdb_id: 100, episodes: [{ tvdb: [{ series: 101 }] }] },
          fullMap.anime[1]] }
        : fullMap;
    } }),
    createWorker: input => {
      const worker = createParentWatchWorker({ ...input, now: () => nowMs,
        today: () => new Date(nowMs).toISOString().slice(0, 10),
        readRelations: async id => {
          relationReads++;
          return { state: 'related_titles', anidbId: id, items: id === 50 ? [] : [
            ...(id > 11 ? [{ anidbId: id - 1, relation: 'Prequel' }] : []),
            ...(id < 30 ? [{ anidbId: id + 1, relation: 'Sequel' }] : [])] };
        },
        loadDetail: async ({ anidbId }) => ({ state: 'details', anidbId,
          title: `Isolated ${anidbId}`, kind: 'series', restricted: false,
          complete: true, total: 1, airDate: '2026-11-01',
          endDate: [11, 30, 50].includes(anidbId) ? null : '2026-11-02', episodeCount: 12,
          episodes: [{ id: anidbId * 100, type: 'Episode', airDate: '2026-11-01' }] }) });
      return { async runOnce() {
        relationReads = 0;
        const result = await worker.runOnce();
        assert.ok(relationReads <= 12);
        visits.push({ phase, ...result });
        return result;
      } };
    },
    createScheduler: input => {
      assert.equal(input.initialDelayMs, 120_000);
      assert.equal(input.pageDelayMs, 60_000);
      assert.equal(input.cycleDelayMs, 86_400_000);
      assert.equal(input.failureDelayMs, 300_000);
      return createAiringScheduler({ ...input,
        setTimeoutImpl(callback, delay) { timer = { callback, delay }; return 1; },
        clearTimeoutImpl() { timer = null; } });
    },
  });
  const fire = async () => {
    const next = timer; timer = null; nowMs += next.delay; await next.callback();
  };
  const stop = async () => { await runtime.close(); runtime = null; };
  try {
    runtime = start(); await fire(); await stop();
    const frontier = inspect(ledger => ledger.getRelationFrontier(100));
    assert.equal(frontier.continueSoon, true);
    const original = inspect(ledger => ledger.listInstallments({ tvdbId: 100 }));
    assert.deepEqual(original.map(item => item.anidbId), [11]);
    phase = 'outage'; runtime = start();
    await fire(); await fire();
    assert.equal(timer.delay, 300_000);
    assert.deepEqual(inspect(ledger => ledger.getRelationFrontier(100)), frontier);
    assert.ok(visits.filter(item => item.phase === 'outage')
      .every(item => item.reason === 'parent_map_unavailable'));
    await stop();
    phase = 'omitted'; runtime = start();
    for (let tick = 0; tick < 9 && timer.delay !== 86_400_000; tick++) await fire();
    assert.equal(timer.delay, 86_400_000, 'held mapping must end expedited whole-parent rounds');
    assert.deepEqual(inspect(ledger => ledger.getRelationFrontier(100)),
      replacementMode === 'omission' ? null : { ...frontier, continueSoon: false });
    assert.deepEqual(inspect(ledger => ledger.listInstallments({ tvdbId: 100 })), original);
    assert.equal(inspect(ledger => ledger.listActive().length), 2);
    assert.deepEqual(inspect(ledger => ledger.listInstallments({ tvdbId: 200 })).map(item => item.anidbId), [50]);
    await stop();
    nowMs += 86_400_001; runtime = start();
    await fire(); await fire(); await fire();
    assert.equal(timer.delay, 86_400_000, 'held mapping remains daily after another restart');
    assert.deepEqual(inspect(ledger => ledger.listInstallments({ tvdbId: 100 })), original);
    phase = 'restored';
    await fire(); // The ordinary daily timer re-evaluates the restored mapping.
    assert.equal(timer.delay, 60_000);
    for (let tick = 0; tick < 20 && timer.delay !== 86_400_000; tick++) await fire();
    assert.equal(timer.delay, 86_400_000);
    const restored = inspect(ledger => ledger.listInstallments({ tvdbId: 100 }));
    assert.deepEqual(restored.map(item => item.anidbId), [11, 30]);
    assert.equal(restored[0].requestId, original[0].requestId);
    const requests = openRequestLedger(dbPath);
    try { assert.equal(requests.countRequests(), 3); } finally { requests.close(); }
  } finally { await runtime?.close(); await rm(dir, { recursive: true, force: true }); }
});

import { reconcileParentWatch } from '../src/requests/parent-watch-reconcile.mjs';

for (const [reason, map] of [
  ['parent_mapping_invalid', { version: 3, anime: [] }],
  ['ambiguous_parent_mapping', { version: 2, anime: [{ anidb_id: 11, tvdb_id: 100,
    episodes: [{ tvdb: [{ series: 200 }] }] }] }],
]) test(`${reason} preserves persisted evidence instead of treating it as omission`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-parent-map-hold-'));
  const dbPath = path.join(dir, 'db.sqlite');
  let parents = openParentWatchLedger(dbPath);
  const requests = openRequestLedger(dbPath);
  try {
    parents.adopt({ tvdbId: 100, requesterId: 7, sourceSeriesId: 101, nowMs: 1000 });
    // Existing v318 frontier format: no schema or timestamp migration is needed.
    const prior = { seeds: [11], relations: [], pass: 1,
      candidateAfterId: 11, continueSoon: true };
    parents.saveRelationFrontier(100, prior);
    parents.close(); parents = openParentWatchLedger(dbPath);
    const result = await reconcileParentWatch({ parent: parents.listActive()[0],
      map, parents, requests, today: '2026-11-25', nowMs: 2000,
      loadDetail: async () => assert.fail('held mapping must not read details'),
      readRelations: async () => assert.fail('held mapping must not read relations') });
    assert.equal(result.reason, reason);
    assert.deepEqual(parents.getRelationFrontier(100),
      reason === 'ambiguous_parent_mapping' ? { ...prior, continueSoon: false } : prior);
    assert.equal(requests.countRequests(), 0);
  } finally { parents.close(); requests.close(); await rm(dir, { recursive: true, force: true }); }
});

test('suspending an ambiguous parent retains another parent\'s legitimate runtime continuation through outage', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-peer-continuation-'));
  const dbPath = path.join(dir, 'db.sqlite');
  let nowMs = Date.parse('2026-11-25T00:00:00Z');
  let runtime, timer, phase = 'valid';
  const inspect = () => {
    const ledger = openParentWatchLedger(dbPath);
    try { return [100, 200].map(id => ledger.getRelationFrontier(id)); }
    finally { ledger.close(); }
  };
  const parents = openParentWatchLedger(dbPath);
  for (const tvdbId of [100, 200]) parents.adopt({ tvdbId,
    requesterId: 7, sourceSeriesId: tvdbId + 1, nowMs });
  parents.close();
  const start = () => startParentWatchRuntime({
    config: { parentWatch: true, dbPath, shokoBaseUrl: 'http://unused', timeZone: 'UTC' },
    shokoApiKey: 'isolated', createArchiveReader: () => ({}),
    createMapReader: () => ({ read: async () => {
      if (phase === 'outage') throw Error('provider unavailable');
      return { version: 2, anime: [
        { anidb_id: 11, tvdb_id: 100, ...(phase === 'ambiguous'
          ? { episodes: [{ tvdb: [{ series: 101 }] }] } : {}) },
        { anidb_id: 50, tvdb_id: 200 }] };
    } }),
    createWorker: input => createParentWatchWorker({ ...input, now: () => nowMs,
      today: () => new Date(nowMs).toISOString().slice(0, 10),
      readRelations: async id => {
        const first = id < 50 ? 11 : 50, last = id < 50 ? 30 : 90;
        return { state: 'related_titles', anidbId: id, items: [
          ...(id > first ? [{ anidbId: id - 1, relation: 'Prequel' }] : []),
          ...(id < last ? [{ anidbId: id + 1, relation: 'Sequel' }] : [])] };
      },
      loadDetail: async ({ anidbId }) => ({ state: 'details', anidbId,
        title: `Isolated ${anidbId}`, kind: 'series', restricted: false,
        complete: true, total: 1, airDate: '2026-11-01', endDate: '2026-11-02',
        episodeCount: 1, episodes: [{ id: anidbId * 100, type: 'Episode', airDate: '2026-11-01' }] }) }),
    createScheduler: input => createAiringScheduler({ ...input,
      setTimeoutImpl(callback, delay) { timer = { callback, delay }; return 1; },
      clearTimeoutImpl() { timer = null; } }),
  });
  const fire = async () => { const next = timer; timer = null; nowMs += next.delay; await next.callback(); };
  const stop = async () => { await runtime.close(); runtime = null; };
  try {
    runtime = start(); await fire(); await fire(); await fire(); await stop();
    const initial = inspect();
    assert.ok(initial.every(frontier => frontier.continueSoon === true));
    phase = 'ambiguous'; runtime = start(); await fire(); await fire(); await fire();
    const held = inspect();
    assert.deepEqual(held[0], { ...initial[0], continueSoon: false });
    assert.equal(held[1].continueSoon, true);
    assert.equal(timer.delay, 60_000, 'healthy peer still needs an expedited round');
    await stop();
    phase = 'outage'; runtime = start(); await fire(); await fire();
    assert.equal(timer.delay, 300_000);
    assert.deepEqual(inspect(), held, 'provider outage preserves both suspended and legitimate frontiers');
    await stop();
    phase = 'ambiguous'; runtime = start();
    for (let tick = 0; tick < 20 && timer.delay !== 86_400_000; tick++) await fire();
    assert.equal(timer.delay, 86_400_000, 'daily pacing resumes once the healthy peer finishes');
    assert.deepEqual(inspect()[0], held[0]);
    const requests = openRequestLedger(dbPath);
    try { assert.equal(requests.countRequests(), 0, 'no ambiguous evidence creates a watch'); }
    finally { requests.close(); }
  } finally { await runtime?.close(); await rm(dir, { recursive: true, force: true }); }
});
