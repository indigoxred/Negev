import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
      monitorFuture: true, episodeIds: [1001, 1002], status: 'held',
      reason: 'awaiting_availability_evidence', createdMs: 1_000,
    });
  } finally { second.close(); }
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
