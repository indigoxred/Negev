import assert from 'node:assert/strict';
import test from 'node:test';
import { readAniDbRelations } from '../src/catalogue/shoko-relations.mjs';

const config = { baseUrl: 'http://shoko:8111/', apiKey: 'synthetic', anidbId: 42 };
test('reads verified AniDB relation IDs without requiring local Shoko series', async () => {
  const result = await readAniDbRelations({ ...config, fetchImpl: async (url, init) => {
    assert.equal(url.pathname, '/api/v3/Series/AniDB/42/Relations');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    return Response.json([{ IDs: { AniDB: 42, Shoko: null },
      RelatedIDs: { AniDB: 43, Shoko: null }, Type: 'Sequel',
      Source: 'AniDB', Verified: true }]);
  } });
  assert.deepEqual(result, { state: 'relations', anidbId: 42,
    items: [{ relatedId: 43, type: 'Sequel', verified: true }] });
});

test('a reversed relation is rejected instead of mislabelled', async () => {
  const result = await readAniDbRelations({ ...config, fetchImpl: async () =>
    Response.json([{ IDs: { AniDB: 41, Shoko: 9 },
      RelatedIDs: { AniDB: 42, Shoko: null }, Type: 'Prequel',
      Source: 'AniDB', Verified: true }]) });
  assert.deepEqual(result, { state: 'unavailable' });
});

test('missing metadata, malformed IDs, and unsupported sources never make an empty franchise', async () => {
  for (const response of [new Response(null, { status: 404 }),
    Response.json([{ IDs: { AniDB: 42 }, RelatedIDs: { AniDB: 42 },
      Type: 'Sequel', Source: 'AniDB', Verified: true }]),
    Response.json([{ IDs: { AniDB: 42 }, RelatedIDs: { AniDB: 43 },
      Type: 'Sequel', Source: 'Other', Verified: true }])]) {
    const result = await readAniDbRelations({ ...config,
      fetchImpl: async () => response.clone() });
    assert.notEqual(result.state, 'relations');
  }
});
