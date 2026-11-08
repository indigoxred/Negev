import assert from 'node:assert/strict';
import test from 'node:test';
import { readAniDbRelatedTitles } from '../src/catalogue/anidb-related-titles.mjs';
import { createCachedDisplayRelations, preferDisplayRelations,
  readDisplayRelations } from '../src/catalogue/anidb-related-titles.mjs';

test('related-title reads coalesce and reuse a successful result', async () => {
  let calls = 0;
  const result = { state: 'related_titles', anidbId: 42,
    completeness: 'unproven', items: [{ anidbId: 43,
      title: 'Sequel', relation: 'Sequel' }] };
  const reader = createCachedDisplayRelations({
    read: async () => { calls++; return result; }, now: () => 1_000,
  });
  assert.deepEqual(await Promise.all([
    reader({ anidbId: 42 }), reader({ anidbId: 42 }),
  ]), [result, result]);
  assert.deepEqual(await reader({ anidbId: 42 }), result);
  assert.equal(calls, 1);
});

test('related-title cache serves recent proof during a provider outage', async () => {
  let clock = 1_000;
  let online = true;
  const result = { state: 'related_titles', anidbId: 42,
    completeness: 'unproven', items: [{ anidbId: 43,
      title: 'Sequel', relation: 'Sequel' }] };
  const reader = createCachedDisplayRelations({
    read: async () => online ? result : { state: 'unavailable' },
    now: () => clock, freshMs: 100, staleMs: 1_000,
  });
  assert.deepEqual(await reader({ anidbId: 42 }), result);
  online = false;
  clock += 150;
  assert.deepEqual(await reader({ anidbId: 42 }), result);
  clock += 1_000;
  assert.deepEqual(await reader({ anidbId: 42 }), { state: 'unavailable' });
  assert.deepEqual(await reader({ anidbId: 43 }), { state: 'unavailable' });
});

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
  assert.equal(archiveCalls, 1);
});

test('display combines distinct exact AniDB relations while preferring Shoko titles', async () => {
  const local = { state: 'related_titles', anidbId: 42,
    completeness: 'unproven', items: [{ anidbId: 43,
      title: 'Local sequel', relation: 'Sequel' }] };
  const archive = { state: 'related_titles', anidbId: 42,
    completeness: 'unproven', items: [{ anidbId: 43,
      title: 'Archive sequel', relation: 'Prequel' }, { anidbId: 44,
      title: 'Other installment', relation: 'SideStory' }] };
  assert.deepEqual(await readDisplayRelations({
    readLocal: async () => local, readArchive: async () => archive,
  }), { ...local, items: [local.items[0], archive.items[1]] });
});

test('archive relations do not wait for a slow Shoko display read', async () => {
  let releaseLocal;
  const archive = { state: 'related_titles', anidbId: 42,
    completeness: 'unproven', items: [{ anidbId: 43,
      title: 'Sequel', relation: 'Sequel' }] };
  const read = readDisplayRelations({
    readLocal: () => new Promise((resolve) => { releaseLocal = resolve; }),
    readArchive: async () => archive,
    mergeWaitMs: 10,
  });
  const result = await Promise.race([read, new Promise((resolve) =>
    setTimeout(() => resolve('late'), 40))]);
  releaseLocal({ state: 'unavailable' });
  assert.deepEqual(result, archive);
});

test('cached Shoko relations do not wait for a slow archive read', async () => {
  let releaseArchive;
  const local = { state: 'related_titles', anidbId: 42,
    completeness: 'unproven', items: [{ anidbId: 44,
      title: 'Local sequel', relation: 'Sequel' }] };
  const read = readDisplayRelations({ readLocal: async () => local,
    readArchive: () => new Promise((resolve) => { releaseArchive = resolve; }),
    mergeWaitMs: 10 });
  const result = await Promise.race([read, new Promise((resolve) =>
    setTimeout(() => resolve('late'), 40))]);
  releaseArchive({ state: 'unavailable' });
  assert.deepEqual(result, local);
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
