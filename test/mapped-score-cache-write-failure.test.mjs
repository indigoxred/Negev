import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openMappedScoreCache } from '../src/catalogue/mapped-score-cache.mjs';

test('a failed score write is contained instead of crashing the service', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-score-write-'));
  const dbPath = path.join(dir, 'scores.sqlite');
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  let reads = 0;
  const cache = openMappedScoreCache({ dbPath, minGapMs: 0,
    fetchImpl: async () => { reads++; return new Response(JSON.stringify({ mal_id: 99,
      score: 8.1, scored_by: 10, members: 20 }), { status: 200 }); } });
  try {
    // Simulate the database rejecting writes (locked or full) while reads work.
    const other = new DatabaseSync(dbPath);
    other.exec(`CREATE TRIGGER reject_score_writes BEFORE INSERT ON catalogue_score_snapshots
      BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
    other.close();
    cache.prime([{ anidbId: 1, malId: 99 }, { anidbId: 2, malId: 99 }]);
    await cache.whenIdle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'no unhandled rejection reaches the process');
    assert.equal(reads, 2, 'one failed write does not stop the rest of the queue');
    assert.equal(cache.prime([{ anidbId: 1, malId: 99 }]).ready, false);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    cache.close();
    await rm(dir, { recursive: true, force: true });
  }
});
