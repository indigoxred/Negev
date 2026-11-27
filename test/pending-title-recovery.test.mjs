import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openPendingTitleLedger } from '../src/requests/pending-title-ledger.mjs';
import { createPendingTitleWorker } from '../src/requests/pending-title-worker.mjs';

async function fixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-prep-recovery-'));
  const dbPath = path.join(dir, 'requests.sqlite');
  let ledger = openPendingTitleLedger(dbPath);
  const enqueue = (extra = {}) => ledger.enqueue({ requesterId: 4, anidbId: 42,
    title: 'Synthetic title', requestKey: 'original', nowMs: 1_000, ...extra });
  const finishOld = () => {
    const claim = ledger.claimDue({ nowMs: 1_000, leaseMs: 1_000 });
    ledger.finish({ intentId: claim.id, version: claim.version,
      reason: 'account_access_changed', nowMs: 1_000 });
    return claim;
  };
  const reopen = () => { ledger.close(); ledger = openPendingTitleLedger(dbPath); return ledger; };
  try { await run({ enqueue, finishOld, reopen, dbPath, get ledger() { return ledger; } }); }
  finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
}

test('old disabled-account preparation resumes after restart with its original identity and choice',
  async () => fixture(async (f) => {
    f.enqueue({ releaseMode: 'manual' });
    const old = f.finishOld();
    const ledger = f.reopen();
    assert.equal(ledger.get(old.id).state, 'pending');
    assert.equal(ledger.get(old.id).version, old.version + 1);
    const version = ledger.get(old.id).version;
    assert.equal(f.reopen().get(old.id).version, version, 'recovery is idempotent');
    let input;
    const worker = createPendingTitleWorker({ ledger: f.ledger, now: () => 2_000,
      authorize: async () => true,
      submitRequest: async (value) => { input = value; return { state: 'held', requestId: 8 }; } });
    assert.equal((await worker.runOnce()).state, 'resolved');
    assert.deepEqual(input, { requesterId: 4, anidbId: 42, scope: 'installment',
      requestKey: 'original', releaseMode: 'manual' });
    assert.equal((await worker.runOnce()).state, 'idle');
  }));

test('recovered preparation still waits while its owner is disabled',
  async () => fixture(async (f) => {
    f.enqueue(); f.finishOld(); f.reopen();
    let allowed = false;
    let nowMs = 2_000;
    let submissions = 0;
    const worker = createPendingTitleWorker({ ledger: f.ledger, now: () => nowMs,
      authorize: async () => allowed,
      submitRequest: async () => { submissions++; return { state: 'held', requestId: 8 }; } });
    const paused = await worker.runOnce();
    assert.equal(paused.state, 'pending');
    assert.equal(submissions, 0);
    allowed = true; nowMs = paused.nextDueMs;
    assert.equal((await worker.runOnce()).state, 'resolved');
    assert.equal(submissions, 1);
  }));

test('recovery preserves cancellations, resolved requests, unrelated outcomes and newer preparations',
  async () => fixture(async (f) => {
    f.enqueue(); f.finishOld();
    f.enqueue({ requestKey: 'replacement' });
    for (const [index, state, reason, normal] of [
      [2, 'cancelled', 'account_access_changed', null],
      [3, 'resolved', 'account_access_changed', 8],
      [4, 'complete', 'already_available', null],
    ]) {
      f.enqueue({ anidbId: 42 + index, requestKey: `other-${index}` });
      const db = new DatabaseSync(f.dbPath);
      try { db.prepare('UPDATE pending_title_intents SET state=?,reason=?,normal_request_id=? WHERE request_key=?')
        .run(state, reason, normal, `other-${index}`); } finally { db.close(); }
    }
    const ledger = f.reopen();
    assert.equal(ledger.get(1).state, 'complete', 'do not revive a superseded intent');
    assert.equal(ledger.get(2).state, 'pending');
    assert.equal(ledger.get(3).state, 'cancelled');
    assert.equal(ledger.get(4).state, 'resolved');
    assert.equal(ledger.get(5).reason, 'already_available');
  }));
