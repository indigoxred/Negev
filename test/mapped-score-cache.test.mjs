import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openMappedScoreCache } from '../src/catalogue/mapped-score-cache.mjs';

test('bounded MAL snapshots persist across restarts and leave unrated titles visible', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'negev-score-'));
  try {
    const dbPath = path.join(dir, 'scores.sqlite');
    const seen = [];
    const first = openMappedScoreCache({ dbPath, minGapMs: 1,
      fetchImpl: async (url) => {
        seen.push(url);
        const malId = Number(url.match(/\/(\d+)\/raw$/)?.[1]);
        return new Response(JSON.stringify({ mal_id: malId,
          score: malId === 11 ? 8.2 : null,
          scored_by: malId === 11 ? 1400 : 32,
          members: malId === 11 ? 8000 : 300 }), { status: 200 });
      } });
    const entries = [{ anidbId: 1, malId: 11 },
      { anidbId: 2, malId: 12 }];
    assert.equal(first.prime(entries).ready, false);
    await first.whenIdle();
    assert.equal(first.prime(entries).ready, true);
    assert.deepEqual(first.get(1, 11), { state: 'rated', score: 8.2,
      votes: 1400, members: 8000 });
    assert.deepEqual(first.get(2, 12), { state: 'unrated', score: null,
      votes: 32, members: 300 });
    assert.equal(seen.length, 2);
    first.close();
    const reopened = openMappedScoreCache({ dbPath,
      fetchImpl: async () => { throw new Error('unexpected refresh'); } });
    assert.equal(reopened.prime(entries).ready, true);
    assert.equal(reopened.get(1, 11).score, 8.2);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a mismatched MAL record cannot supply a score to another AniDB title', async () => {
  const cache = openMappedScoreCache({ dbPath: ':memory:', minGapMs: 1,
    fetchImpl: async () => new Response(JSON.stringify({ mal_id: 99,
      score: 9.9, scored_by: 1000, members: 2000 }), { status: 200 }) });
  cache.prime([{ anidbId: 1, malId: 11 }]);
  await cache.whenIdle();
  assert.deepEqual(cache.get(1, 11), { state: 'unavailable', score: null,
    votes: null, members: null });
  assert.equal(cache.get(1, 12), null);
  cache.close();
});
