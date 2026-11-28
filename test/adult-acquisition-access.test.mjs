import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openStartQueue } from '../src/acquisition/start-queue.mjs';
const candidate = { indexerId: 7, guid: 'adult-access-fixture' }, hash = 'a'.repeat(40), manifestDigest = 'b'.repeat(64);
async function fixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-adult-acquisition-')), file = path.join(dir, 'state.sqlite');
  const accounts = openAccountLedger(file);
  const owner = await accounts.bootstrapAdmin({ username: 'Fixture', password: 'fixture-password-long' });
  const requests = openRequestLedger(file); let ledger = openAcquisitionLedger(file); const db = new DatabaseSync(file);
  const requestId = requests.submit({ requesterId: owner.id, requestKey: 'fixture', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', episodeIds: [1001], monitorFuture: false } }).requestId;
  const reserve = restricted => ledger.reserve({ requestId, candidate, episodeIds: [1001], nowMs: 101, restricted });
  const revoke = () => db.prepare('UPDATE users SET adult_allowed=0 WHERE id=?').run(owner.id);
  const enable = () => db.prepare('UPDATE users SET adult_allowed=1 WHERE id=?').run(owner.id);
  const dispatch = (attemptId, restricted) => ledger.beginDispatch({ attemptId, restricted, nowMs: 102 });
  const start = (attemptId, restricted) => ledger.beginStart({ attemptId, hash, manifestDigest, restricted, nowMs: 104 });
  try { await run({ db, file, requestId, reserve, revoke, enable, dispatch, start,
    get ledger() { return ledger; }, reopen() { ledger.close(); ledger = openAcquisitionLedger(file); },
    bind(attemptId) { ledger.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 101 }); },
    observe(attemptId) { ledger.recordTorrent({ attemptId, hash, nowMs: 103 }); } });
  } finally { ledger.close(); db.close(); requests.close(); accounts.close(); await rm(dir, { recursive: true, force: true }); }
}
for (const boundary of ['reserve', 'dispatch', 'start']) {
  for (const restricted of [true, undefined]) test(`${boundary} holds restricted or unverified new work after 18+ revocation (${restricted})`, () => fixture(async f => {
    let attemptId;
    if (boundary !== 'reserve') { attemptId = f.reserve(true).attemptId; f.bind(attemptId); }
    if (boundary === 'start') { f.dispatch(attemptId, true); f.observe(attemptId); }
    f.revoke(); f.reopen();
    const result = boundary === 'reserve' ? f.reserve(restricted) : f[boundary](attemptId, restricted);
    assert.equal(result.state, 'held');
    assert.equal(result.reason, restricted === true ? 'adult_access_disabled' : 'restricted_or_unverified');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM requests').get().n, 1);
    f.enable();
    assert.notEqual((boundary === 'reserve' ? f.reserve(true) : f[boundary](attemptId, true)).state, 'held');
  }));
  test(`${boundary} still permits verified all-ages work for an adult-blocked account`, () => fixture(async f => {
    let attemptId;
    if (boundary !== 'reserve') { attemptId = f.reserve(false).attemptId; f.bind(attemptId); }
    if (boundary === 'start') { f.dispatch(attemptId, false); f.observe(attemptId); }
    f.revoke();
    assert.notEqual((boundary === 'reserve' ? f.reserve(false) : f[boundary](attemptId, false)).state, 'held');
  }));
}
test('revocation preserves uncertain dispatch and start intents without sending again', () => fixture(async f => {
  const attemptId = f.reserve(true).attemptId; f.bind(attemptId); f.dispatch(attemptId, true); f.revoke(); f.reopen();
  assert.deepEqual(f.dispatch(attemptId, true), { state: 'dispatch_unknown', sendNow: false });
  f.observe(attemptId); f.enable(); assert.equal(f.start(attemptId, true).sendNow, true);
  f.revoke(); f.reopen(); assert.deepEqual(f.start(attemptId, true), { state: 'start_unknown', sendNow: false });
}));
test('an account schema without an 18+ permission is not permission to acquire restricted work', () => fixture(async f => {
  f.db.exec('ALTER TABLE users RENAME COLUMN adult_allowed TO legacy_adult_allowed');
  assert.equal(f.reserve(true).state, 'held');
  assert.equal(f.reserve(false).state, 'reserved');
}));
for (const reason of ['adult_access_disabled', 'restricted_or_unverified'])
  test('access hold remains retryable across multiple claims and restart: ' + reason, () => fixture(async f => {
    const attemptId = f.reserve(true).attemptId; f.bind(attemptId); f.dispatch(attemptId, true); f.observe(attemptId); f.revoke();
    let queue = openStartQueue(f.file), nowMs = 105;
    try {
      for (let i = 0; i < 3; i++) {
        const claim = queue.claimNext({ nowMs }); assert.equal(claim.state, 'claimed');
        assert.equal(queue.recordResult({ ...claim, state: 'held', reason, checkedMs: nowMs }).state, 'recorded');
        queue.releaseOperation(attemptId);
        const due = queue.getResult(attemptId).nextDueMs; assert.ok(due > nowMs);
        queue.close(); queue = openStartQueue(f.file); nowMs = due;
      }
      f.enable(); assert.equal(queue.claimNext({ nowMs }).state, 'claimed');
      assert.equal(f.start(attemptId, true).sendNow, true);
    } finally { queue.close(); }
  }));
