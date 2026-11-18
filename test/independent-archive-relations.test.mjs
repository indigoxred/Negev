import assert from 'node:assert/strict';
import test from 'node:test';
import { readRelatedEvidence } from '../src/acquisition/read-related-evidence.mjs';
import { createArchiveRelationReader } from '../src/acquisition/independent-archive-relations.mjs';
import { createMetadataLimiter } from '../src/web/metadata-limiter.mjs';

test('AniDB archive relation fallback remains available while Shoko metadata is busy', async () => {
  const metadata = createMetadataLimiter();
  let releaseBusy;
  const busy = metadata.run(() => new Promise((resolve) => { releaseBusy = resolve; }));
  const archive = createArchiveRelationReader({
    titleSource: { refresh: async () => ({ state: 'ready' }),
      getTitle: () => 'Neighboring season' },
    readArchive: async ({ anidbId, titleForId }) => ({
      state: 'related_titles', anidbId,
      items: [{ anidbId: 200, title: titleForId(200), relation: 'Sequel' }],
    }),
  });
  try {
    const result = await readRelatedEvidence({ anidbId: 100,
      readLocal: () => metadata.run(() => { throw new Error('unexpected Shoko read'); }),
      readArchive: () => archive({ anidbId: 100 }),
    });
    assert.equal(result.state, 'related_titles');
    assert.deepEqual(result.items, [{ anidbId: 200,
      title: 'Neighboring season', relation: 'Sequel' }]);
  } finally { releaseBusy(); await busy; }
});

test('archive relation fallback stays unavailable without a ready title source', async () => {
  let queried = false;
  const reader = createArchiveRelationReader({
    titleSource: { refresh: async () => ({ state: 'unavailable' }) },
    readArchive: async () => { queried = true; return null; },
  });
  assert.deepEqual(await reader({ anidbId: 100 }), { state: 'unavailable' });
  assert.equal(queried, false);
});
