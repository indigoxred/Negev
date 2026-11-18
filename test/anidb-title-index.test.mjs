import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAniDbTitleDump, parseAniDbTitleDumpAsync,
  searchAniDbTitleIndex } from '../src/catalogue/anidb-title-index.mjs';

const fixture = [
  '# aid|type|language|title',
  '10|1|x-jat|Kimi no Na wa.',
  '10|4|en|Your Name',
  '10|3|en|YN',
  '10|2|en|Your Name. | The Movie',
  '11|1|x-jat|Your Name: Another Story',
  '12|1|x-jat|A Different Show',
].join('\n');

test('indexes aliases under one exact AniDB ID and prefers the main title', () => {
  const index = parseAniDbTitleDump(fixture);
  assert.deepEqual(index.get(10).releaseQueries,
    ['Kimi no Na wa.', 'Your Name']);
  assert.equal(index.get(10).englishTitle, 'Your Name');
  assert.equal(index.get(11).englishTitle, null);
  assert.equal(searchAniDbTitleIndex(index, { query: 'Kimi no Na wa.' }).items[0].anidbId, 10);
  assert.deepEqual(searchAniDbTitleIndex(index, { query: 'Your Name', page: 1 }), {
    state: 'results', total: 2, page: 1,
    items: [
      { anidbId: 10, title: 'Kimi no Na wa.', detailState: 'pending', requestable: false },
      { anidbId: 11, title: 'Your Name: Another Story', detailState: 'pending', requestable: false },
    ],
  });
  assert.equal(searchAniDbTitleIndex(index, { query: 'The Movie', page: 1 }).items[0].anidbId, 10);
});

test('includes a shorter romanized same-ID synonym in release queries', () => {
  const index = parseAniDbTitleDump([
    '20|1|x-jat|Saikyou Degarashi Ouji no An`yaku Teii Arasoi: Munou o Enjiru SS Rank Ouji wa Koui Keishou-sen o Kage kara Shihai Suru',
    '20|2|x-jat|Saikyou Degarashi Ouji no Anyaku Teii Arasoi',
    '20|4|en|The Insipid Prince`s Furtive Grab for the Throne',
    '20|2|x-jat|Ouji',
    '21|1|x-jat|A Different Prince',
  ].join('\n'));
  assert.deepEqual(index.get(20).releaseQueries, [
    'Saikyou Degarashi Ouji no An`yaku Teii Arasoi: Munou o Enjiru SS Rank Ouji wa Koui Keishou-sen o Kage kara Shihai Suru',
    'Saikyou Degarashi Ouji no Anyaku Teii Arasoi',
    'The Insipid Prince`s Furtive Grab for the Throne',
  ]);
  assert.deepEqual(index.get(21).releaseQueries, ['A Different Prince']);
});

test('accepts live AniDB kana and title-card rows for search without using them as release queries', () => {
  const index = parseAniDbTitleDump([
    '10|1|x-jat|Main Title',
    '10|5|ja|メインタイトル',
    '10|6|en|Title Card',
  ].join('\n'));
  assert.equal(searchAniDbTitleIndex(index, { query: 'Title Card' }).items[0].anidbId, 10);
  assert.deepEqual(index.get(10).releaseQueries, ['Main Title']);
});

test('uses an English synonym for display when AniDB has no official English title', () => {
  const index = parseAniDbTitleDump([
    '18687|1|x-jat|Dungeon Meshi Season 2',
    '18687|2|en|Delicious in Dungeon Season 2',
    '19977|1|x-jat|Sousou no Frieren (2027)',
    '19977|2|en|Frieren 3',
    '19977|2|en|Frieren: Beyond Journey\'s End (2027)',
    '20291|1|x-jat|One Piece Film: Baad',
  ].join('\n'));
  assert.equal(index.get(18687).englishTitle, 'Delicious in Dungeon Season 2');
  assert.equal(index.get(19977).englishTitle,
    'Frieren: Beyond Journey\'s End (2027)');
  assert.equal(index.get(20291).englishTitle, null);
  assert.deepEqual(index.get(18687).releaseQueries, ['Dungeon Meshi Season 2']);
});

test('normalizes an embedded title tab from the live dump to a searchable space', () => {
  const index = parseAniDbTitleDump('10|1|x-jat|Main Title\n10|4|ja|Japanese\tTitle');
  assert.equal(searchAniDbTitleIndex(index, { query: 'Japanese Title' }).items[0].anidbId, 10);
  assert.deepEqual(index.get(10).releaseQueries, ['Main Title']);
});

test('pages distinct IDs and rejects a stale or malformed dump rather than partial results', () => {
  const index = parseAniDbTitleDump(fixture);
  assert.deepEqual(searchAniDbTitleIndex(index, { query: 'name', page: 2, pageSize: 1 }).items,
    [{ anidbId: 11, title: 'Your Name: Another Story', detailState: 'pending', requestable: false }]);
  for (const bad of ['10|1|x-jat|Title\n0|1|x-jat|Bad',
    '10|1|x-jat|Title\n10|1|x-jat|Conflicting main',
    '10|1|x-jat|Title\n11|4|en|Alias',
    '10|main|x-jat|Title', '10|7|x-jat|Title']) {
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

test('finds shortened title terms in order without requiring an exact phrase', () => {
  const index = parseAniDbTitleDump([
    '21|1|x-jat|Tensei Shitara Slime Datta Ken',
    '21|4|en|That Time I Got Reincarnated as a Slime',
    '22|1|x-jat|Slime Tensei Side Story',
    '23|1|x-jat|Unrelated Slime',
    '24|1|x-jat|Gekijouban Tensei Shitara Slime Datta Ken',
  ].join('\n'));
  assert.deepEqual(searchAniDbTitleIndex(index, { query: 'tensei slime' }).items
    .map((item) => item.anidbId), [21, 24, 22]);
});

test('large title parsing yields while preserving the exact synchronous index', async () => {
  const text = Array.from({ length: 4_100 }, (_, index) =>
    `${index + 1}|1|x-jat|Title ${index + 1}`).join('\n');
  const events = [];
  const parsing = parseAniDbTitleDumpAsync(text).then((index) => {
    events.push('parsed');
    return index;
  });
  await new Promise((resolve) => setImmediate(() => {
    events.push('tick');
    resolve();
  }));
  const index = await parsing;
  assert.deepEqual(events, ['tick', 'parsed']);
  assert.deepEqual(index, parseAniDbTitleDump(text));
});
