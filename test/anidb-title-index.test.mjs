import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAniDbTitleDump, searchAniDbTitleIndex } from '../src/catalogue/anidb-title-index.mjs';

const fixture = [
  '# aid|type|language|title',
  '10|1|x-jat|Kimi no Na wa.',
  '10|4|en|Your Name',
  '10|2|en|Your Name. | The Movie',
  '11|1|x-jat|Your Name: Another Story',
  '12|1|x-jat|A Different Show',
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
  for (const bad of ['10|1|x-jat|Title\n0|1|x-jat|Bad',
    '10|1|x-jat|Title\n10|1|x-jat|Conflicting main',
    '10|1|x-jat|Title\n11|4|en|Alias',
    '10|main|x-jat|Title', '10|5|x-jat|Title']) {
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
