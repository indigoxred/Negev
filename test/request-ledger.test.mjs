import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';

const intent = { state: 'ready', anidbId: 1234, kind: 'series',
  episodeIds: [1001, 1002], monitorFuture: true };

async function withPath(run) {
  const base = path.resolve(tmpdir());
  const dir = await mkdtemp(path.join(base, 'negev-requests-'));
  try { await run(path.join(dir, 'requests.sqlite')); }
  finally {
    assert.equal(path.dirname(path.resolve(dir)), base);
    await rm(dir, { recursive: true, force: true });
  }
}

test('an exact request and targets survive restart in a held state', async () => withPath(async (dbPath) => {
  const first = openRequestLedger(dbPath);
  const saved = first.submit({ requesterId: 7, requestKey: 'first', intent, nowMs: 1_000 });
  assert.equal(saved.state, 'held');
  assert.equal(saved.reason, 'awaiting_availability_evidence');
  assert.equal(saved.created, true);
  first.close();
  const second = openRequestLedger(dbPath);
  try {
    assert.deepEqual(second.getRequest(saved.requestId), {
      id: saved.requestId, requesterId: 7, anidbId: 1234, kind: 'series',
      monitorFuture: true, watchClosed: false,
      episodeIds: [1001, 1002], status: 'held',
      reason: 'awaiting_availability_evidence', createdMs: 1_000,
    });
  } finally { second.close(); }
}));

test('verified title survives restart and a legacy request remains readable', async () => withPath(async (dbPath) => {
  const first = openRequestLedger(dbPath);
  const named = first.submit({ requesterId: 7, requestKey: 'named',
    intent: { ...intent, title: 'A Film & a Series' }, nowMs: 1_000 });
  const legacy = first.submit({ requesterId: 7, requestKey: 'legacy', intent, nowMs: 1_001 });
  first.close();
  const second = openRequestLedger(dbPath);
  try {
    assert.equal(second.getRequest(named.requestId).title, 'A Film & a Series');
    assert.equal('title' in second.getRequest(legacy.requestId), false);
    assert.deepEqual(second.listRequests({ requesterId: 7 }).items.map((item) =>
      item.title ?? null), [null, 'A Film & a Series']);
  } finally { second.close(); }
}));

test('existing database without a title column migrates without losing requests', async () => withPath(async (dbPath) => {
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE requests (
    id INTEGER PRIMARY KEY, requester_id INTEGER NOT NULL,
    request_key TEXT NOT NULL, command_key TEXT, anidb_id INTEGER NOT NULL,
    kind TEXT NOT NULL, episode_key TEXT NOT NULL, monitor_future INTEGER NOT NULL,
    watch_closed INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL,
    status TEXT NOT NULL, reason TEXT NOT NULL,
    UNIQUE(requester_id,request_key)) STRICT`);
  old.exec(`INSERT INTO requests VALUES
    (1,7,'old',NULL,1234,'series','1001',0,0,1000,'held','awaiting_availability_evidence')`);
  old.close();
  const ledger = openRequestLedger(dbPath);
  try {
    assert.equal(ledger.getRequest(1).anidbId, 1234);
    assert.equal('title' in ledger.getRequest(1), false);
    const saved = ledger.submit({ requesterId: 7, requestKey: 'new',
      intent: { ...intent, title: 'New Title' }, nowMs: 1_001 });
    assert.equal(ledger.getRequest(saved.requestId).title, 'New Title');
  } finally { ledger.close(); }
}));

test('same-user retries are idempotent while different users share targets', async () => withPath(async (dbPath) => {
  const ledger = openRequestLedger(dbPath);
  try {
    const first = ledger.submit({ requesterId: 7, requestKey: 'first', intent, nowMs: 1_000 });
    const repeat = ledger.submit({ requesterId: 7, requestKey: 'first', intent: { ...intent, episodeIds: [1002, 1001] }, nowMs: 2_000 });
    assert.equal(repeat.requestId, first.requestId);
    assert.equal(repeat.created, false);
    const other = ledger.submit({ requesterId: 8, requestKey: 'first', intent, nowMs: 3_000 });
    assert.notEqual(other.requestId, first.requestId);
    assert.deepEqual(other.targetIds, first.targetIds);
    assert.equal(ledger.countRequests(), 2);
    assert.equal(ledger.countTargets(), 2);
  } finally { ledger.close(); }
}));

test('request history pages only the authenticated owner and survives restart', async () => withPath(async (dbPath) => {
  const first = openRequestLedger(dbPath);
  first.submit({ requesterId: 7, requestKey: 'one', intent, nowMs: 1_000 });
  first.submit({ requesterId: 8, requestKey: 'other', intent, nowMs: 1_001 });
  first.submit({ requesterId: 7, requestKey: 'two', intent, nowMs: 1_002 });
  first.submit({ requesterId: 7, requestKey: 'three', intent, nowMs: 1_003 });
  first.close();
  const ledger = openRequestLedger(dbPath);
  try {
    const firstPage = ledger.listRequests({ requesterId: 7, limit: 2 });
    assert.deepEqual(firstPage.items.map((item) => item.id), [4, 3]);
    assert.equal(firstPage.nextBeforeId, 3);
    assert.deepEqual(ledger.listRequests({ requesterId: 7,
      beforeId: firstPage.nextBeforeId, limit: 2 }).items.map((item) => item.id), [1]);
    assert.deepEqual(ledger.listRequests({ requesterId: 8 }).items.map((item) => item.id), [2]);
    assert.throws(() => ledger.listRequests({ requesterId: 0 }), TypeError);
    assert.throws(() => ledger.listRequests({ requesterId: 7, limit: 1000 }), TypeError);
  } finally { ledger.close(); }
}));

test('overlapping scopes share only common episode targets', async () => withPath(async (dbPath) => {
  const ledger = openRequestLedger(dbPath);
  try {
    const first = ledger.submit({ requesterId: 7, requestKey: 'first', intent, nowMs: 1_000 });
    const second = ledger.submit({ requesterId: 8, requestKey: 'second', intent: { ...intent,
      episodeIds: [1002, 1003], monitorFuture: false }, nowMs: 2_000 });
    assert.equal(first.targetIds[1], second.targetIds[0]);
    assert.equal(ledger.countTargets(), 3);
  } finally { ledger.close(); }
}));

test('malformed intent or requester is rejected before writes', async () => withPath(async (dbPath) => {
  const ledger = openRequestLedger(dbPath);
  try {
    for (const input of [
      { requesterId: 0, intent },
      { requesterId: 7, requestKey: '', intent },
      { requesterId: 7, intent: { ...intent, episodeIds: [1001, 1001] } },
      { requesterId: 7, intent: { ...intent, kind: 'movie', monitorFuture: true } },
      { requesterId: 7, intent: { ...intent, anidbId: null } },
      { requesterId: 7, intent: { ...intent, title: 'bad\nname' } },
    ]) assert.throws(() => ledger.submit({ requestKey: 'first', ...input, nowMs: 1_000 }), TypeError);
    assert.equal(ledger.countRequests(), 0);
  } finally { ledger.close(); }
}));

test('two connections cannot create duplicate rows for the same submission key', async () => withPath(async (dbPath) => {
  const one = openRequestLedger(dbPath);
  const two = openRequestLedger(dbPath);
  try {
    const a = one.submit({ requesterId: 7, requestKey: 'first', intent, nowMs: 1_000 });
    const b = two.submit({ requesterId: 7, requestKey: 'first', intent, nowMs: 1_001 });
    assert.equal(a.requestId, b.requestId);
    assert.equal(one.countRequests(), 1);
    assert.equal(two.countTargets(), 2);
  } finally { one.close(); two.close(); }
}));

test('a new submission key preserves a later request while sharing exact targets', async () => withPath(async (dbPath) => {
  const ledger = openRequestLedger(dbPath);
  try {
    const first = ledger.submit({ requesterId: 7, requestKey: 'first', intent, nowMs: 1_000 });
    const later = ledger.submit({ requesterId: 7, requestKey: 'later', intent, nowMs: 2_000 });
    assert.notEqual(first.requestId, later.requestId);
    assert.deepEqual(first.targetIds, later.targetIds);
    assert.equal(ledger.countRequests(), 2);
    const conflict = ledger.submit({ requesterId: 7, requestKey: 'first',
      intent: { ...intent, episodeIds: [1001] }, nowMs: 3_000 });
    assert.deepEqual(conflict, { state: 'held', reason: 'idempotency_key_conflict' });
    assert.equal(ledger.countRequests(), 2);
  } finally { ledger.close(); }
}));

test('airing watch adds only aired regular episodes and survives restart', async () => withPath(async (dbPath) => {
  const one = openRequestLedger(dbPath);
  const saved = one.submit({ requesterId: 7, requestKey: 'airing', intent,
    nowMs: 1_000 });
  const detail = { state: 'details', anidbId: 1234, kind: 'series',
    complete: true, total: 5, episodes: [
      { id: 1001, type: 'Episode', airDate: '2026-01-01' },
      { id: 1002, type: 'Episode', airDate: '2026-01-08' },
      { id: 1003, type: 'Episode', airDate: '2026-01-15' },
      { id: 1004, type: 'Episode', airDate: '2026-02-01' },
      { id: 1099, type: 'Special', airDate: '2026-01-15' },
    ] };
  assert.deepEqual(one.advanceAiring({ requestId: saved.requestId,
    detail, releaseState: 'airing', today: '2026-01-20' }),
  { state: 'advanced', addedEpisodeIds: [1003], deferredEpisodeIds: [1004], watchClosed: false });
  one.close();
  const two = openRequestLedger(dbPath);
  try {
    assert.deepEqual(two.getRequest(saved.requestId).episodeIds, [1001, 1002, 1003]);
    assert.deepEqual(two.listActiveAirings(), [{ requestId: saved.requestId,
      anidbId: 1234 }]);
    assert.deepEqual(two.advanceAiring({ requestId: saved.requestId,
      detail, releaseState: 'airing', today: '2026-01-20' }).addedEpisodeIds, []);
    assert.equal(two.countTargets(), 3);
    const retry = two.submit({ requesterId: 7, requestKey: 'airing', intent, nowMs: 2_000 });
    assert.equal(retry.created, false);
    assert.equal(retry.targetIds.length, 3);
  } finally { two.close(); }
}));

test('future-only Airing request waits durably without an acquisition target', async () => withPath(async (dbPath) => {
  const one = openRequestLedger(dbPath);
  const futureIntent = { ...intent, episodeIds: [] };
  const saved = one.submit({ requesterId: 7, requestKey: 'future',
    intent: futureIntent, nowMs: 1_000 });
  assert.equal(saved.created, true);
  assert.deepEqual(saved.targetIds, []);
  assert.equal(one.countTargets(), 0);
  one.close();
  const two = openRequestLedger(dbPath);
  try {
    assert.deepEqual(two.getRequest(saved.requestId).episodeIds, []);
    assert.deepEqual(two.listActiveAirings(), [{ requestId: saved.requestId,
      anidbId: 1234 }]);
    const detail = { state: 'details', anidbId: 1234, kind: 'series',
      complete: true, total: 1, episodes: [
        { id: 1001, type: 'Episode', airDate: '2026-11-01' },
      ] };
    assert.deepEqual(two.advanceAiring({ requestId: saved.requestId,
      detail, releaseState: 'airing', today: '2026-10-31' }).addedEpisodeIds, []);
    assert.deepEqual(two.advanceAiring({ requestId: saved.requestId,
      detail, releaseState: 'airing', today: '2026-11-01' }).addedEpisodeIds, [1001]);
    assert.deepEqual(two.getRequest(saved.requestId).episodeIds, [1001]);
    assert.equal(two.countTargets(), 1);
    assert.equal(two.submit({ requesterId: 7, requestKey: 'future',
      intent: futureIntent, nowMs: 2_000 }).created, false);
    assert.throws(() => two.submit({ requesterId: 8, requestKey: 'empty-film',
      intent: { ...futureIntent, kind: 'movie', monitorFuture: false },
      nowMs: 3_000 }), TypeError);
  } finally { two.close(); }
}));

test('completed detail adds final episodes once and closes only that airing watch', async () => withPath(async (dbPath) => {
  const one = openRequestLedger(dbPath);
  const airing = one.submit({ requesterId: 7, requestKey: 'airing', intent, nowMs: 1_000 });
  const completed = one.submit({ requesterId: 8, requestKey: 'completed',
    intent: { ...intent, monitorFuture: false }, nowMs: 1_001 });
  const detail = { state: 'details', anidbId: 1234, kind: 'series',
    complete: true, total: 3, episodes: [
      { id: 1001, type: 'Episode' }, { id: 1002, type: 'Episode' },
      { id: 1003, type: 'Episode' },
    ] };
  try {
    assert.deepEqual(one.advanceAiring({ requestId: airing.requestId,
      detail, releaseState: 'completed', today: '2026-02-01' }),
    { state: 'advanced', addedEpisodeIds: [1003], deferredEpisodeIds: [], watchClosed: true });
    assert.deepEqual(one.listActiveAirings(), []);
    assert.equal(one.getRequest(airing.requestId).watchClosed, true);
    assert.equal(one.listRequests({ requesterId: 7 }).items[0].watchClosed, true);
    assert.equal(one.getRequest(completed.requestId).watchClosed, false);
    assert.deepEqual(one.getRequest(completed.requestId).episodeIds, [1001, 1002]);
    assert.deepEqual(one.advanceAiring({ requestId: airing.requestId,
      detail, releaseState: 'airing', today: '2026-02-02' }),
    { state: 'held', reason: 'watch_closed' });
  } finally { one.close(); }
}));

test('incomplete or wrong-title detail cannot add watched targets', async () => withPath(async (dbPath) => {
  const ledger = openRequestLedger(dbPath);
  const saved = ledger.submit({ requesterId: 7, requestKey: 'airing', intent,
    nowMs: 1_000 });
  const detail = { state: 'details', anidbId: 1234, kind: 'series',
    complete: true, total: 3, episodes: [
      { id: 1001, type: 'Episode' }, { id: 1002, type: 'Episode' },
      { id: 1003, type: 'Episode', airDate: '2026-01-15' },
    ] };
  try {
    for (const changed of [{ ...detail, anidbId: 9999 },
      { ...detail, complete: false }, { ...detail, kind: 'movie' }]) {
      assert.equal(ledger.advanceAiring({ requestId: saved.requestId,
        detail: changed, releaseState: 'airing', today: '2026-02-01' }).state, 'held');
    }
    assert.equal(ledger.countTargets(), 2);
  } finally { ledger.close(); }
}));

test('a changed catalogue cannot erase known episodes or close an airing watch', async () => withPath(async (dbPath) => {
  const ledger = openRequestLedger(dbPath);
  try {
    const saved = ledger.submit({ requesterId: 7, requestKey: 'airing', intent, nowMs: 1_000 });
    const detail = { state: 'details', anidbId: 1234, kind: 'series',
      complete: true, total: 2, episodes: [
        { id: 1001, type: 'Episode' },
        { id: 1003, type: 'Episode' },
      ] };
    assert.deepEqual(ledger.advanceAiring({ requestId: saved.requestId, detail,
      releaseState: 'completed', today: '2026-02-01' }),
    { state: 'held', reason: 'catalogue_regression' });
    assert.deepEqual(ledger.listActiveAirings(), [{ requestId: saved.requestId,
      anidbId: 1234 }]);
    assert.equal(ledger.countTargets(), 2);
  } finally { ledger.close(); }
}));

test('a completed season with a long backlog advances in bounded batches before closing', async () => withPath(async (dbPath) => {
  const ledger = openRequestLedger(dbPath);
  try {
    const saved = ledger.submit({ requesterId: 7, requestKey: 'airing', intent, nowMs: 1_000 });
    const episodes = Array.from({ length: 32 }, (_, i) => ({ id: 1001 + i, type: 'Episode' }));
    const detail = { state: 'details', anidbId: 1234, kind: 'series',
      complete: true, total: episodes.length, episodes };
    const first = ledger.advanceAiring({ requestId: saved.requestId, detail,
      releaseState: 'completed', today: '2026-02-01' });
    assert.equal(first.addedEpisodeIds.length, 25);
    assert.equal(first.watchClosed, false);
    const second = ledger.advanceAiring({ requestId: saved.requestId, detail,
      releaseState: 'completed', today: '2026-02-01' });
    assert.deepEqual(second.addedEpisodeIds, [1028, 1029, 1030, 1031, 1032]);
    assert.equal(second.watchClosed, true);
    assert.equal(ledger.countTargets(), 32);
    assert.deepEqual(ledger.listActiveAirings(), []);
  } finally { ledger.close(); }
}));

test('invalid or unknown air dates stay deferred while later valid episodes advance', async () => withPath(async (dbPath) => {
  const ledger = openRequestLedger(dbPath);
  try {
    const saved = ledger.submit({ requesterId: 7, requestKey: 'airing', intent, nowMs: 1_000 });
    const detail = { state: 'details', anidbId: 1234, kind: 'series',
      complete: true, total: 5, episodes: [
        { id: 1001, type: 'Episode' }, { id: 1002, type: 'Episode' },
        { id: 1003, type: 'Episode', airDate: null },
        { id: 1004, type: 'Episode', airDate: '2026-02-99' },
        { id: 1005, type: 'Episode', airDate: '2026-01-20' },
      ] };
    assert.deepEqual(ledger.advanceAiring({ requestId: saved.requestId, detail,
      releaseState: 'airing', today: '2026-02-01' }),
    { state: 'advanced', addedEpisodeIds: [1005],
      deferredEpisodeIds: [1003, 1004], watchClosed: false });
    assert.throws(() => ledger.advanceAiring({ requestId: saved.requestId,
      detail, releaseState: 'airing', today: '2026-02-99' }), TypeError);
  } finally { ledger.close(); }
}));

test('two ledger connections cannot append the same airing episode twice', async () => withPath(async (dbPath) => {
  const one = openRequestLedger(dbPath);
  const two = openRequestLedger(dbPath);
  try {
    const saved = one.submit({ requesterId: 7, requestKey: 'airing', intent, nowMs: 1_000 });
    const detail = { state: 'details', anidbId: 1234, kind: 'series',
      complete: true, total: 3, episodes: [
        { id: 1001, type: 'Episode' }, { id: 1002, type: 'Episode' },
        { id: 1003, type: 'Episode', airDate: '2026-01-20' },
      ] };
    const first = one.advanceAiring({ requestId: saved.requestId, detail,
      releaseState: 'airing', today: '2026-02-01' });
    const second = two.advanceAiring({ requestId: saved.requestId, detail,
      releaseState: 'airing', today: '2026-02-01' });
    assert.deepEqual(first.addedEpisodeIds, [1003]);
    assert.deepEqual(second.addedEpisodeIds, []);
    assert.equal(one.countTargets(), 3);
    assert.deepEqual(two.getRequest(saved.requestId).episodeIds, [1001, 1002, 1003]);
  } finally { one.close(); two.close(); }
}));

test('airing page cursor survives restart and rejects stale concurrent advancement', async () => withPath(async (dbPath) => {
  const one = openRequestLedger(dbPath);
  const two = openRequestLedger(dbPath);
  let oneClosed = false;
  try {
    assert.equal(one.getAiringCursor(), 0);
    assert.deepEqual(one.advanceAiringCursor({ expectedAfterId: 0, nextAfterId: 17 }),
      { state: 'advanced', afterId: 17 });
    assert.deepEqual(two.advanceAiringCursor({ expectedAfterId: 0, nextAfterId: 23 }),
      { state: 'held', reason: 'stale_cursor' });
    assert.equal(two.getAiringCursor(), 17);
    one.close();
    oneClosed = true;
    const reopened = openRequestLedger(dbPath);
    try {
      assert.equal(reopened.getAiringCursor(), 17);
      assert.deepEqual(reopened.advanceAiringCursor({ expectedAfterId: 17, nextAfterId: 0 }),
        { state: 'advanced', afterId: 0 });
    } finally { reopened.close(); }
  } finally { if (!oneClosed) one.close(); two.close(); }
}));
