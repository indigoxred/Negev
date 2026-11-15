import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAniListRankingCache } from '../src/catalogue/anilist-ranking-cache.mjs';

const media = (idMal, averageScore, popularity) =>
  ({ idMal, averageScore, popularity });
const payload = (score, popular) => ({ data: {
  s1: { media: score }, s2: { media: [] }, s3: { media: [] },
  p1: { media: popular }, p2: { media: [] }, p3: { media: [] },
} });
const reply = (value) => new Response(JSON.stringify(value), { status: 200 });

test('a bounded AniList top list is cached across restart and keeps exact MAL IDs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'negev-anilist-'));
  const dbPath = join(dir, 'test.sqlite');
  let calls = 0;
  try {
    const source = openAniListRankingCache({ dbPath, now: () => 1_000,
      fetchImpl: async (_url, options) => {
        calls++;
        assert.equal(options.method, 'POST');
        assert.match(JSON.parse(options.body).query, /SCORE_DESC/);
        return reply(payload([media(52991, 90, 499125), media(null, 89, 100)],
          [media(5114, 90, 744418)]));
      } });
    const first = await source.read('all');
    assert.equal(first.state, 'ready');
    assert.deepEqual(first.score, [{ malId: 52991, rank: 1,
      score: 9, members: 499125 }]);
    assert.deepEqual(first.popular, [{ malId: 5114, rank: 1,
      score: 9, members: 744418 }]);
    await source.read('all');
    assert.equal(calls, 1);
    source.close();
    const reopened = openAniListRankingCache({ dbPath, now: () => 2_000,
      fetchImpl: async () => { throw new Error('offline'); } });
    assert.deepEqual(await reopened.read('all'), first);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an outage retains the last good list, but malformed source cannot be cached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'negev-anilist-'));
  const dbPath = join(dir, 'test.sqlite');
  let time = 1_000;
  let response = reply(payload([media(52991, 90, 499125)],
    [media(5114, 90, 744418)]));
  try {
    const source = openAniListRankingCache({ dbPath, now: () => time,
      fetchImpl: async () => response });
    assert.equal((await source.read('all')).state, 'ready');
    time += 13 * 60 * 60_000;
    response = reply(payload([media(52991, 900, 1)], []));
    assert.equal((await source.read('all')).state, 'stale');
    await source.whenIdle();
    assert.equal((await source.read('all')).score[0].malId, 52991);
    source.close();
    const empty = openAniListRankingCache({ dbPath: join(dir, 'empty.sqlite'),
      now: () => 1_000, fetchImpl: async () => new Response('', { status: 503 }) });
    assert.deepEqual(await empty.read('all'), { state: 'unavailable' });
    empty.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
