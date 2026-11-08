import assert from 'node:assert/strict';
import test from 'node:test';
import { readAniDbRelatedTitles } from '../src/catalogue/anidb-related-titles.mjs';
import { preferDisplayRelations, readDisplayRelations } from '../src/catalogue/anidb-related-titles.mjs';

test('display can use archive relations when Shoko holds an unverified edge', () => {
  const archive = { state: 'related_titles', anidbId: 42,
    completeness: 'unproven', items: [{ anidbId: 43,
      title: 'Sequel', relation: 'Sequel' }] };
  assert.deepEqual(preferDisplayRelations({ state: 'held',
    reason: 'relation_review_required' }, archive), archive);
});

test('display falls back to exact archive IDs when the Shoko relation call fails', async () => {
  const archive = { state: 'related_titles', anidbId: 42,
    completeness: 'unproven', items: [{ anidbId: 43,
      title: 'Sequel', relation: 'Sequel' }] };
  assert.deepEqual(await readDisplayRelations({
    readLocal: async () => { throw new Error('Shoko unavailable'); },
    readArchive: async () => archive,
  }), archive);
  let archiveCalls = 0;
  assert.deepEqual(await readDisplayRelations({
    readLocal: async () => archive,
    readArchive: async () => { archiveCalls++; return archive; },
  }), archive);
  assert.equal(archiveCalls, 0);
});

test('archive relations retain exact AniDB IDs and distinguish unknown names', async () => {
  const result = await readAniDbRelatedTitles({ anidbId: 1,
    titleForId: (id) => id === 2 ? 'Seikai no Senki' : null,
    fetchImpl: async (url) => {
      assert.equal(url, 'https://animap.id/api/anidb/1');
      return new Response(JSON.stringify({ anidb_id: 1,
        relatedanime: [{ anidb_id: 2, type: 'Sequel' },
          { anidb_id: 3, type: 'Prequel' }] }));
    } });
  assert.deepEqual(result, { state: 'related_titles', anidbId: 1,
    completeness: 'unproven', items: [
      { anidbId: 2, title: 'Seikai no Senki', relation: 'Sequel' },
      { anidbId: 3, title: 'AniDB 3', relation: 'Prequel' },
    ] });
});

test('archive relations reject a mismatched title or malformed relationship', async () => {
  for (const body of [
    { anidb_id: 4, relatedanime: [] },
    { anidb_id: 1, relatedanime: [{ anidb_id: 1, type: 'Sequel' }] },
    { anidb_id: 1, relatedanime: [{ anidb_id: 2, type: 'Sequel' },
      { anidb_id: 2, type: 'Prequel' }] },
  ]) {
    const result = await readAniDbRelatedTitles({ anidbId: 1,
      titleForId: () => null,
      fetchImpl: async () => new Response(JSON.stringify(body)) });
    assert.equal(result.state, 'unavailable');
  }
});
