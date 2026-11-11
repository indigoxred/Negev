import assert from 'node:assert/strict';
import test from 'node:test';
import { readRelatedEvidence } from '../src/acquisition/read-related-evidence.mjs';

test('uses a resolved AniDB relation when Shoko has not cached an unowned title', async () => {
  const result = await readRelatedEvidence({ anidbId: 15464,
    readLocal: async () => ({ state: 'detail_pending' }),
    readArchive: async () => ({ state: 'related_titles', anidbId: 15464,
      completeness: 'unproven', items: [{ anidbId: 14523,
        title: 'Itai no wa Iya nano de Bougyoryoku ni Kyokufuri Shitai to Omoimasu.',
        relation: 'Prequel' }] }) });
  assert.equal(result.state, 'related_titles');
  assert.equal(result.items[0].anidbId, 14523);
});

test('an unresolved fallback relation remains unavailable', async () => {
  const result = await readRelatedEvidence({ anidbId: 15464,
    readLocal: async () => ({ state: 'detail_pending' }),
    readArchive: async () => ({ state: 'related_titles', anidbId: 15464,
      items: [{ anidbId: 14523, title: 'AniDB 14523' }] }) });
  assert.deepEqual(result, { state: 'unavailable' });
});

test('keeps Shoko relations when available', async () => {
  let archiveRead = false;
  const local = { state: 'related_titles', anidbId: 15464, items: [] };
  const result = await readRelatedEvidence({ anidbId: 15464,
    readLocal: async () => local,
    readArchive: async () => { archiveRead = true; return null; } });
  assert.equal(result, local);
  assert.equal(archiveRead, false);
});
