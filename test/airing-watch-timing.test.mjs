import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';

test('distant metadata watch sleeps until due and an RSS signal wakes it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-airing-timing-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  let ledger;
  try {
    ledger = openRequestLedger(dbPath);
    const saved = ledger.submit({ requesterId: 1, requestKey: 'early',
      intent: { state: 'ready', anidbId: 777, kind: 'series',
        title: 'Example Anime', episodeIds: [], monitorFuture: true }, nowMs: 100 });
    assert.equal(ledger.listActiveAirings({ nowMs: 1_000 }).length, 1);
    ledger.recordAiringTiming({ requestId: saved.requestId,
      nextMetadataMs: 7_000, feedIntervalMs: 86_400_000, nowMs: 1_000 });
    assert.deepEqual(ledger.listActiveAirings({ nowMs: 6_999 }), []);
    assert.equal(ledger.listActiveAirings({ nowMs: 7_000 }).length, 1);
    const db = new (await import('node:sqlite')).DatabaseSync(dbPath);
    db.prepare('UPDATE rss_watch_timing SET rush_until_ms=? WHERE request_id=?')
      .run(100_000_000, saved.requestId);
    db.close();
    ledger.recordAiringTiming({ requestId: saved.requestId,
      nextMetadataMs: 500_000_000, feedIntervalMs: 86_400_000, nowMs: 10_000 });
    assert.equal(ledger.listActiveAirings({ nowMs: 3_610_000 }).length, 1);
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});
