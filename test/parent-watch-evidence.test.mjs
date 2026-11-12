import assert from 'node:assert/strict';
import test from 'node:test';
import { mapParentInstallments, confirmedSequelIds } from
  '../src/requests/parent-watch-evidence.mjs';

test('maps exact top-level and episode TVDB identities without title matching', () => {
  const map = { version: 2, anime: [
    { anidb_id: 11, tvdb_id: 100 },
    { anidb_id: 12, episodes: [{ tvdb: [{ series: 100, season: 2 }] }] },
    { anidb_id: 13, tvdb_id: 200, title: 'Matching name' },
  ] };
  assert.deepEqual(mapParentInstallments({ map, tvdbId: 100 }),
    { state: 'mapped', anidbIds: [11, 12] });
});

test('holds an AniDB installment claimed by two different TVDB parents', () => {
  const map = { version: 2, anime: [{ anidb_id: 11, tvdb_id: 100,
    episodes: [{ tvdb: [{ series: 200, season: 1 }] }] }] };
  assert.deepEqual(mapParentInstallments({ map, tvdbId: 100 }),
    { state: 'held', reason: 'ambiguous_parent_mapping' });
});

test('malformed or missing mapping holds rather than guessing', () => {
  assert.deepEqual(mapParentInstallments({ map: { version: 2, anime: [] },
    tvdbId: 100 }), { state: 'held', reason: 'parent_mapping_missing' });
  assert.deepEqual(mapParentInstallments({ map: { version: 1, anime: [] },
    tvdbId: 100 }), { state: 'held', reason: 'parent_mapping_invalid' });
});

test('a reciprocal AniDB sequel relation adds the new exact installment', async () => {
  const data = new Map([
    [11, { state: 'related_titles', anidbId: 11,
      items: [{ anidbId: 12, relation: 'Sequel' },
        { anidbId: 13, relation: 'Side Story' }] }],
    [12, { state: 'related_titles', anidbId: 12,
      items: [{ anidbId: 11, relation: 'Prequel' }] }],
  ]);
  assert.deepEqual(await confirmedSequelIds({ sourceId: 11,
    readRelations: async (id) => data.get(id) ?? { state: 'unavailable' } }),
  { state: 'confirmed', anidbIds: [12] });
});

test('one-way or unavailable relations never propose a successor', async () => {
  const data = new Map([
    [11, { state: 'related_titles', anidbId: 11,
      items: [{ anidbId: 12, relation: 'Sequel' }] }],
    [12, { state: 'related_titles', anidbId: 12, items: [] }],
  ]);
  assert.deepEqual(await confirmedSequelIds({ sourceId: 11,
    readRelations: async (id) => data.get(id) ?? { state: 'unavailable' } }),
  { state: 'confirmed', anidbIds: [] });
});
