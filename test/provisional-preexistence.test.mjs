import assert from 'node:assert/strict';
import test from 'node:test';
import { checkProvisionalHashesAbsent } from '../src/acquisition/provisional-preexistence.mjs';

const videos = [
  { ed2k: 'A'.repeat(32), size: 3, episodeIds: [1001] },
  { ed2k: 'B'.repeat(32), size: 4, episodeIds: [1002] },
];

test('every provisional file must be absent from Shoko before publication', async () => {
  const seen = [];
  assert.deepEqual(await checkProvisionalHashesAbsent({ videos,
    readShokoHash: async (query) => { seen.push(query); return { state: 'not_imported' }; } }),
  { state: 'all_absent' });
  assert.deepEqual(seen, videos.map(({ ed2k, size }) => ({ ed2k, size })));
});

test('a preexisting second file holds the entire provisional pack', async () => {
  let count = 0;
  const result = await checkProvisionalHashesAbsent({ videos,
    readShokoHash: async () => ++count === 1
      ? { state: 'not_imported' } : { state: 'imported_recognized' } });
  assert.deepEqual(result, { state: 'held', reason: 'shoko_file_preexisting' });
  assert.equal(count, 2);
});
