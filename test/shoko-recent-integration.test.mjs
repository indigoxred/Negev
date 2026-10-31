import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openShokoRecentLedger } from '../src/availability/shoko-recent-ledger.mjs';
import { createShokoRecentWorker } from '../src/availability/shoko-recent-worker.mjs';
import { createShokoRecentScheduler } from
  '../src/availability/shoko-recent-scheduler.mjs';

const cursor = (fileId) => ({ fileId,
  importedNs: String(1_800_000_000_000_000_000n + BigInt(fileId)) });

function fakeClock() {
  const timers = new Map();
  let next = 0;
  return {
    timers,
    setTimer(callback) { const id = ++next; timers.set(id, callback); return id; },
    clearTimer(id) { timers.delete(id); },
    async fire() {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      await callback();
    },
  };
}

test('offline Shoko arrivals journal before cursor, retry provisional, and survive restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-recent-restart-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  let ledger;
  let scheduler;
  try {
    ledger = openShokoRecentLedger(dbPath);
    assert.deepEqual(ledger.bootstrap(cursor(10)), { state: 'baseline_saved' });
    let head = [12, 11, 10];
    let reads = 0;
    const readPage = async ({ page }) => {
      reads++;
      return { state: 'page', page, total: head.length,
        items: head.map(cursor) };
    };
    let nowMs = 100;
    let linked11 = false;
    const seen = [];
    const makeWorker = () => createShokoRecentWorker({ ledger, readPage,
      now: () => nowMs,
      refreshFile: async (fileId) => {
        seen.push(fileId);
        return { state: 'recorded_file', recognition:
          fileId === 11 && !linked11 ? 'provisional' : 'linked' };
      } });
    let worker = makeWorker();
    let clock = fakeClock();
    scheduler = createShokoRecentScheduler({
      scan: worker.scan, drainOne: worker.drainOne, ...clock });
    assert.equal(reads, 0);
    scheduler.start();
    assert.equal(reads, 0);
    scheduler.requestSoon();
    await clock.fire();
    assert.equal(reads, 2);
    assert.deepEqual(ledger.getCursor(), cursor(12));
    assert.deepEqual(ledger.nextDue(nowMs), { fileId: 11 });
    await clock.fire(); // 11 is observed before Shoko finishes recognition.
    await clock.fire(); // 12 is linked and acknowledged.
    assert.deepEqual(seen, [11, 12]);
    assert.equal(ledger.nextDue(nowMs), null);
    assert.deepEqual(ledger.nextDue(300_100), { fileId: 11 });
    await scheduler.close();
    scheduler = null;
    ledger.close();

    ledger = openShokoRecentLedger(dbPath);
    assert.deepEqual(ledger.getCursor(), cursor(12));
    head = [13, 12, 11, 10];
    nowMs = 300_100;
    linked11 = true;
    worker = makeWorker();
    clock = fakeClock();
    scheduler = createShokoRecentScheduler({
      scan: worker.scan, drainOne: worker.drainOne, ...clock });
    scheduler.start();
    scheduler.requestSoon();
    await clock.fire();
    assert.deepEqual(ledger.getCursor(), cursor(13));
    await clock.fire(); // previously provisional 11 is now linked.
    await clock.fire(); // new 13 also proceeds.
    assert.deepEqual(seen, [11, 12, 11, 13]);
    assert.equal(ledger.nextDue(nowMs), null);
  } finally {
    await scheduler?.close();
    ledger?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
