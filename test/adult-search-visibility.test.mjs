import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdultSearchVerifier } from '../src/web/public/adult-search-visibility.mjs';

test('search reveals only verified nonadult titles while 18+ is off', async () => {
  const seen = [];
  const verifier = createAdultSearchVerifier({ readDisplay: async (id) => {
    if (id === 14974) return { state: 'display', anidbId: id, restricted: true };
    if (id === 11003) return { state: 'display', anidbId: id + 1, restricted: false };
    if (id === 2498) return { state: 'display', anidbId: id, restricted: false };
    throw new Error('temporarily unavailable');
  } });
  await verifier.verify([14974, 11003, 2498, 18447], (id, adult) =>
    seen.push({ id, adult }));
  assert.deepEqual(seen, [
    { id: 14974, adult: true }, { id: 2498, adult: false },
  ]);
});
