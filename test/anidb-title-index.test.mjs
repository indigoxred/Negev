import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAniDbTitleDump, searchAniDbTitleIndex } from '../src/catalogue/anidb-title-index.mjs';

const fixture = [
  '# aid|type|language|title',
  '10|main|x-jat|Kimi no Na wa.',
  '10|official|en|Your Name',
  '10|synonym|en|Your Name. | The Movie',
  '11|main|x-jat|Your Name: Another Story',
  '12|main|x-jat|A Different Show',
].join('\n');

test('indexes aliases under one exact AniDB ID and prefers the main title', () => {
  const index = parseAniDbTitleDump(fixture);
  assert.deepEqual(searchAniDbTitleIndex(index, { query: 'Your Name', page: 1 }), {
    state: 'results', total: 2, page: 1,
    items: [
      { anidbId: 10, title: 'Kimi no Na wa.', detailState: 'pending', requestable: false },
      { anidbId: 11, title: 'Your Name: Another Story', detailState: 'pending', requestable: false },
    ],
  });
  assert.equal(searchAniDbTitleIndex(index, { query: 'The Movie', page: 1 }).items[0].anidbId, 10);
});

test('pages distinct IDs and rejects a stale or malformed dump rather than partial results', () => {
  const index = parseAniDbTitleDump(fixture);
  assert.deepEqual(searchAniDbTitleIndex(index, { query: 'name', page: 2, pageSize: 1 }).items,
    [{ anidbId: 11, title: 'Your Name: Another Story', detailState: 'pending', requestable: false }]);
  for (const bad of ['10|main|en|Title\n0|main|en|Bad',
    '10|main|en|Title\n10|main|en|Conflicting main',
    '10|main|en|Title\n11|official|en|Alias']) {
    assert.throws(() => parseAniDbTitleDump(bad), TypeError);
  }
  assert.throws(() => parseAniDbTitleDump('x'.repeat(101), { maxBytes: 100 }), TypeError);
});

test('search validates user input and never treats a title as file evidence', () => {
  const index = parseAniDbTitleDump(fixture);
  for (const query of ['', 'x', 'x'.repeat(121)]) {
    assert.deepEqual(searchAniDbTitleIndex(index, { query }), { state: 'invalid_query' });
  }
  assert.deepEqual(searchAniDbTitleIndex(index, { query: 'missing' }),
    { state: 'results', total: 0, page: 1, items: [] });
});
