import assert from 'node:assert/strict';
import test from 'node:test';
import { readAniDbRelatedTitles } from '../src/catalogue/shoko-related-titles.mjs';

const relation = (relatedId, type = 'Sequel', verified = true) =>
  ({ IDs: { AniDB: 42 }, RelatedIDs: { AniDB: relatedId },
    Type: type, Source: 'AniDB', Verified: verified });
const input = { baseUrl: 'http://shoko:8111/', apiKey: 'synthetic', anidbId: 42 };

test('returns named, verified direct installments with incomplete scope', async () => {
  const calls = [];
  const result = await readAniDbRelatedTitles({ ...input, fetchImpl: async (url) => {
    calls.push(url.pathname);
    return url.pathname.endsWith('/Relations') ?
      Response.json([relation(43), relation(99, 'SharedCharacters')]) :
      Response.json([{ ID: 43, Title: 'Second installment' },
        { ID: 99, Title: 'Unrelated crossover' }]);
  } });
  assert.deepEqual(calls, ['/api/v3/Series/AniDB/42/Relations',
    '/api/v3/Series/AniDB/42/Related']);
  assert.deepEqual(result, { state: 'related_titles', anidbId: 42,
    completeness: 'unproven', items: [{ anidbId: 43,
      title: 'Second installment', relation: 'Sequel' }] });
});

test('missing or unverified relations hold without a title request', async () => {
  let calls = 0;
  const missing = await readAniDbRelatedTitles({ ...input,
    fetchImpl: async () => { calls++; return new Response(null, { status: 404 }); } });
  assert.equal(missing.state, 'detail_pending');
  assert.equal(calls, 1);
  const unverified = await readAniDbRelatedTitles({ ...input,
    fetchImpl: async () => { calls++; return Response.json([relation(43, 'Sequel', false)]); } });
  assert.deepEqual(unverified, { state: 'held', reason: 'relation_review_required' });
  assert.equal(calls, 2);
});

test('a title mismatch cannot quietly omit a relationship', async () => {
  const result = await readAniDbRelatedTitles({ ...input,
    fetchImpl: async (url) => url.pathname.endsWith('/Relations') ?
      Response.json([relation(43)]) : Response.json([{ ID: 44, Title: 'Wrong' }]) });
  assert.deepEqual(result, { state: 'unavailable' });
});
