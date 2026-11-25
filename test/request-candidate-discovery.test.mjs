import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestCandidateDiscovery } from '../src/acquisition/request-candidate-discovery.mjs';

const request = { id: 12, requesterId: 1, anidbId: 1234, kind: 'series',
  episodeIds: [1001], status: 'held' };
const detail = { state: 'details', anidbId: 1234, page: 1, total: 1,
  title: 'Canonical Anime', kind: 'series', restricted: false,
  complete: true, nextPage: null,
  episodes: [{ id: 1001, number: 1, type: 'Episode', title: 'First' }] };

test('interactive search bounds queries and a custom phrase cannot become identity evidence',async()=>{
  const queries=[];
  const discover=createRequestCandidateDiscovery({readRequest:()=>request,loadDetail:async()=>detail,
    releaseQueries:async()=>['Another official name','Another alias','Third alias','Fourth alias'],pause:async()=>{},
    searchReleases:async({query})=>{queries.push(query);return {state:'candidates',items:[{guid:query,indexerId:1,
      title:'Canonical Anime - 01',evidence:'unverified'}]};}});
  assert.ok((await discover({requestId:12,interactive:true})).items.length<=4);
  assert.ok(queries.length<=4);queries.length=0;
  const result=await discover({requestId:12,interactive:true,query:'Canonical Anime 1080p'});
  assert.ok(queries.includes('Canonical Anime 1080p'));assert.ok(queries.every(q=>q.endsWith(' 1080p')));assert.ok(queries.length<=4);assert.equal(result.items[0].sourceQuery,undefined);
  assert.equal((await discover({requestId:12,query:'untrusted'})).reason,'invalid_request');
});

test('overlapping fuzzy queries preserve the later correct episode evidence', async () => {
  const discover = createRequestCandidateDiscovery({
    readRequest: () => ({ ...request, episodeIds: [1001, 1002, 1003] }),
    loadDetail: async () => ({ ...detail, total: 3,
      episodes: [1, 2, 3].map((number) => ({ id: 1000 + number,
        number, type: 'Episode', title: `Episode ${number}` })) }),
    pause: async () => {},
    searchReleases: async () => ({ state: 'candidates', items: [{
      indexerId: 7, guid: 'overlapping', title: 'Canonical Anime - 03 1080p',
      evidence: 'unverified' }] }),
  });
  const result = await discover({ requestId: 12,
    searchTargetEpisodeIds: [1001, 1002, 1003] });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].targetedEpisode, true);
  assert.equal(result.items[0].targetEpisodeId, 1003);
  assert.equal(result.items[0].sourceQuery, 'Canonical Anime 03');
});

test('repeated candidate pages reuse successful queries instead of searching the same titles again', async () => {
  let calls = 0;
  const discover = createRequestCandidateDiscovery({ readRequest: () => request,
    loadDetail: async () => detail, pause: async () => {},
    searchReleases: async () => { calls++; return { state: 'candidates', items: [{
      indexerId: 7, guid: 'same', title: 'Canonical Anime - 01', evidence: 'unverified' }] }; } });
  await discover({ requestId: 12 }); await discover({ requestId: 12 });
  assert.equal(calls, 1);
});

test('a ten-episode request bounds query fanout while checking every canonical episode and broad aliases', async () => {
  const queries = [];
  const episodes = Array.from({ length: 10 }, (_, i) => ({
    id: 1001 + i, number: i + 1, type: 'Episode', title: String(i + 1) }));
  const discover = createRequestCandidateDiscovery({
    readRequest: () => ({ ...request, episodeIds: episodes.map(item => item.id) }),
    loadDetail: async () => ({ ...detail, total: 10, episodes }),
    releaseQueries: async () => ['English Name', 'Another Alias', 'Last Alias'],
    pause: async () => {}, searchReleases: async ({ query }) => {
      queries.push(query); return { state: 'candidates', items: [] };
    } });
  await discover({ requestId: 12, searchTargetEpisodeIds: episodes.map(item => item.id) });
  assert.ok(queries.length <= 16);
  for (let i = 1; i <= 10; i++) assert.ok(queries.includes(`Canonical Anime ${String(i).padStart(2, '0')}`));
  assert.ok(queries.includes('English Name'));
});

test('correct evidence beyond the visible cap upgrades an already visible release', async () => {
  const discover = createRequestCandidateDiscovery({
    readRequest: () => ({ ...request, episodeIds: [1001, 1002] }),
    loadDetail: async () => ({ ...detail, total: 2,
      episodes: [1, 2].map((number) => ({ id: 1000 + number,
        number, type: 'Episode', title: `Episode ${number}` })) }),
    pause: async () => {},
    searchReleases: async ({ query }) => ({ state: 'candidates',
      items: Array.from({ length: 50 }, (_, index) => ({ indexerId: 7,
        guid: query.endsWith('01') && index === 0 || query.endsWith('02') && index === 49
          ? 'overlap' : `${query}:${index}`,
        title: 'Canonical Anime - 02 1080p', evidence: 'unverified' })) }),
  });
  const result = await discover({ requestId: 12, searchTargetEpisodeIds: [1001, 1002] });
  assert.equal(result.items.length, 50);
  const item = result.items.find((item) => item.guid === 'overlap');
  assert.equal(item.targetedEpisode, true);
  assert.equal(item.targetEpisodeId, 1002);
  assert.equal(item.sourceQuery, 'Canonical Anime 02');
});

test('marks a historically completed series for full-season preference', async () => {
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request,
    loadDetail: async () => ({ ...detail, airDate: '2016-04-05',
      endDate: '2016-06-28' }),
    searchReleases: async () => ({ state: 'candidates', items: [] }),
  });
  assert.equal((await discover({ requestId: 12 })).releaseState, 'completed');
});

test('discovers candidates for an existing exact request without authorizing them', async () => {
  const queries = [];
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request,
    loadDetail: async () => detail,
    searchReleases: async (input) => { queries.push(input); return { state: 'candidates', items: [
      { guid: 'candidate-1', title: 'Canonical Anime 01', evidence: 'unverified' }] }; },
  });
  assert.deepEqual(await discover({ requestId: 12 }), {
    state: 'candidates', requestId: 12, anidbId: 1234,
    items: [{ guid: 'candidate-1', title: 'Canonical Anime 01',
      evidence: 'unverified', sourceQuery: 'Canonical Anime' }],
    exhaustive: false,
  });
  assert.deepEqual(queries, [{ query: 'Canonical Anime', targetEpisodeNumber: null }]);
});

test('a failed alias search marks a surviving candidate set incomplete', async () => {
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request, loadDetail: async () => detail,
    releaseQueries: async () => ['Official English'],
    pause: async () => {},
    searchReleases: async ({ query }) => query === 'Official English'
      ? { state: 'unavailable' }
      : { state: 'candidates', items: [{
        indexerId: 7, guid: 'low-quality',
        title: 'Canonical Anime - 01 720p',
        evidence: 'unverified' }] },
  });
  const found = await discover({ requestId: 12 });
  assert.equal(found.state, 'candidates');
  assert.equal(found.searchIncomplete, true);
  assert.deepEqual(found.failedQueries, ['Official English']);
});

test('an empty partial search reports provider uncertainty, not no releases', async () => {
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request, loadDetail: async () => detail,
    releaseQueries: async () => ['Official English'], pause: async () => {},
    searchReleases: async ({ query }) => query === 'Official English'
      ? { state: 'unavailable' } : { state: 'candidates', items: [] },
  });
  assert.deepEqual(await discover({ requestId: 12 }), {
    state: 'held', reason: 'release_search_incomplete',
  });
});

test('a catalogue year does not hide same-title Airing releases', async () => {
  const queries = [];
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request,
    loadDetail: async () => ({ ...detail, title: 'Ice Wall (2026)' }),
    pause: async () => {},
    searchReleases: async ({ query }) => {
      queries.push(query);
      return { state: 'candidates', items: query === 'Ice Wall'
        ? [{ indexerId: 7, guid: 'episode', title: 'Ice Wall S02E01',
          evidence: 'unverified' }] : [] };
    },
  });
  const result = await discover({ requestId: 12 });
  assert.deepEqual(queries, ['Ice Wall (2026)', 'Ice Wall']);
  assert.deepEqual(result.items.map((item) => item.guid), ['episode']);
});

test('a missing episode search reaches older releases without losing title aliases', async () => {
  const queries = [];
  const targetNumbers = [];
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request, loadDetail: async () => detail,
    releaseQueries: async () => ['Official English'],
    pause: async () => {},
    searchReleases: async ({ query, targetEpisodeNumber }) => {
      queries.push(query);
      targetNumbers.push(targetEpisodeNumber);
      return { state: 'candidates', items: Array.from({ length: 25 }, (_, i) => ({
        indexerId: 7, guid: `${query}-${i}`,
        title: query === 'Canonical Anime 01'
          ? `Canonical Anime - ${i === 1 ? '08' : '01'} WEB 1080p release ${i}`
          : `${query} release ${i}`,
        evidence: 'unverified' })) };
    },
  });
  const found = await discover({ requestId: 12, searchTargetEpisodeId: 1001 });
  assert.deepEqual(queries, ['Canonical Anime 01', 'Official English 01',
    'Canonical Anime', 'Official English']);
  assert.deepEqual(targetNumbers, [1, 1, null, null]);
  assert.equal(found.items.length, 50);
  for (const query of queries) {
    assert.ok(found.items.some((item) => item.sourceQuery === query));
  }
  assert.ok(found.items[0].title.startsWith('Canonical Anime - 01'));
  assert.equal(found.items[0].targetedEpisode, true);
  assert.equal(found.items.find((item) => item.guid === 'Canonical Anime 01-1')
    .targetedEpisode, false);
  assert.equal(found.items[0].sourceQuery, 'Canonical Anime 01');
  assert.equal(found.items[0].targetEpisodeId, 1001);
  assert.equal(found.items.find((item) =>
    item.title.startsWith('Canonical Anime release')).targetedEpisode, undefined);
  assert.equal(found.items.find((item) =>
    item.title.startsWith('Official English release')).sourceQuery,
  'Official English');
});

test('one airing search checks every bounded missing episode before reporting no releases', async () => {
  const searches = [];
  const multiRequest = { ...request, episodeIds: [1001, 1002, 1003] };
  const multiDetail = { ...detail, total: 3, episodes: [
    { id: 1001, number: 1, type: 'Episode', title: 'First' },
    { id: 1002, number: 2, type: 'Episode', title: 'Second' },
    { id: 1003, number: 3, type: 'Episode', title: 'Third' },
  ] };
  const discover = createRequestCandidateDiscovery({
    readRequest: () => multiRequest, loadDetail: async () => multiDetail,
    pause: async () => {},
    searchReleases: async ({ query, targetEpisodeNumber }) => {
      searches.push([query, targetEpisodeNumber]);
      return { state: 'candidates', items: query === 'Canonical Anime 03'
        ? [{ indexerId: 7, guid: 'third-episode',
          title: 'Canonical Anime - 03 1080p', evidence: 'unverified' }] : [] };
    },
  });
  const found = await discover({ requestId: 12,
    searchTargetEpisodeIds: [1001, 1002, 1003] });
  assert.equal(found.state, 'candidates', JSON.stringify(found));
  assert.deepEqual(searches.slice(0, 3), [
    ['Canonical Anime 01', 1], ['Canonical Anime 02', 2],
    ['Canonical Anime 03', 3]]);
  assert.equal(found.items[0].guid, 'third-episode');
  assert.equal(found.items[0].targetEpisodeId, 1003);
});

test('a long official title searches its short main title for the exact episode', async () => {
  const japanese = 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu';
  const longTitle = `${japanese}: ${'Long subtitle '.repeat(12)}`;
  const queries = [];
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request,
    loadDetail: async () => ({ ...detail, title: longTitle }),
    releaseQueries: async () => ['Magic Repo Man'],
    pause: async () => {},
    searchReleases: async ({ query }) => {
      queries.push(query);
      return { state: 'candidates', items: query === `${japanese} 01` ?
        [{ indexerId: 7, guid: 'strong-1080',
          title: '[Group] Kashita Maryoku wa Revo Barai de Kyousei Choushuu - 01 1080p',
          seeders: 239, evidence: 'unverified' }] : [] };
    },
  });
  const found = await discover({ requestId: 12, searchTargetEpisodeId: 1001 });
  assert.equal(queries[0], `${japanese} 01`);
  assert.equal(found.items[0].guid, 'strong-1080');
  assert.equal(found.items[0].targetEpisodeId, 1001);
  assert.equal(found.items[0].targetedEpisode, true);
});

test('a punctuation-tolerant same-title query finds seeded 1080p when the exact prefix misses it', async () => {
  const japanese = 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu';
  const longTitle = `${japanese}: ${'Long subtitle '.repeat(12)}`;
  const searches = [];
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request,
    loadDetail: async () => ({ ...detail, title: longTitle }),
    releaseQueries: async () => ['Magic Repo Man'],
    pause: async () => {},
    searchReleases: async ({ query }) => {
      searches.push(query);
      return { state: 'candidates', items:
        query === 'Kashita Maryoku wa 01'
          ? [{ indexerId: 7, guid: 'seeded-1080',
            title: '[SubsPlease] Kashita Maryoku wa Revo Barai de Kyousei Choushuu - 01 (1080p)',
            seeders: 239, evidence: 'unverified' }]
          : query === `${japanese} 01`
            ? [{ indexerId: 7, guid: 'weak-480',
              title: '[SubsPlease] Kashita Maryoku wa Revo Barai de Kyousei Choushuu - 01 (480p)',
              seeders: 1, evidence: 'unverified' }]
            : [] };
    },
  });
  const found = await discover({ requestId: 12, searchTargetEpisodeId: 1001 });
  assert.ok(searches.includes('Kashita Maryoku wa 01'));
  assert.ok(found.items.some((item) => item.guid === 'seeded-1080' &&
    item.targetEpisodeId === 1001 && item.targetedEpisode === true));
});

test('a broad result naming the exact episode gets the same target priority', async () => {
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request, loadDetail: async () => detail,
    pause: async () => {},
    searchReleases: async ({ query }) => ({ state: 'candidates', items:
      query === 'Canonical Anime 01'
        ? [{ indexerId: 7, guid: 'weak',
          title: 'Canonical Anime - 01 WEB 720p', seeders: 1,
          evidence: 'unverified' }]
        : [{ indexerId: 7, guid: 'strong',
          title: 'Canonical Anime - 01 WEB 1080p', seeders: 100,
          evidence: 'unverified' }] }),
  });
  const found = await discover({ requestId: 12,
    searchTargetEpisodeId: 1001 });
  assert.equal(found.items.find((item) => item.guid === 'strong')
    .targetedEpisode, true);
  assert.equal(found.items.find((item) => item.guid === 'strong')
    .sourceQuery, 'Canonical Anime');
});

test('an episode search cannot use a target outside the saved request', async () => {
  let searches = 0;
  const discover = createRequestCandidateDiscovery({ readRequest: () => request,
    loadDetail: async () => detail,
    searchReleases: async () => { searches++; return { state: 'candidates', items: [] }; } });
  assert.deepEqual(await discover({ requestId: 12, searchTargetEpisodeId: 9999 }),
    { state: 'held', reason: 'invalid_request' });
  assert.equal(searches, 0);
});

test('does not search for missing, changed, restricted or incomplete identity', async () => {
  for (const [existing, observation, reason] of [
    [null, detail, 'request_missing'],
    [request, { ...detail, anidbId: 9999 }, 'detail_unavailable'],
    [request, { ...detail, kind: 'movie' }, 'identity_changed'],
    [request, { ...detail, restricted: null }, 'restricted_or_unverified'],
    [request, { ...detail, episodes: [{ ...detail.episodes[0], id: 9999 }] }, 'target_missing'],
    [request, { state: 'detail_pending', anidbId: 1234 }, 'detail_unavailable'],
  ]) {
    let searches = 0;
    const discover = createRequestCandidateDiscovery({ readRequest: () => existing,
      loadDetail: async () => observation,
      searchReleases: async () => { searches++; throw Error('must not search'); } });
    assert.deepEqual(await discover({ requestId: 12 }), { state: 'held', reason });
    assert.equal(searches, 0);
  }
});

test('indexer outage and zero results never mean no release exists', async () => {
  for (const indexer of [{ state: 'unavailable' }, { state: 'candidates', items: [] }]) {
    const discover = createRequestCandidateDiscovery({ readRequest: () => request,
      loadDetail: async () => detail, searchReleases: async () => indexer });
    const result = await discover({ requestId: 12 });
    assert.equal(result.state, indexer.state === 'candidates' ? 'candidates' : 'held');
    if (result.state === 'candidates') assert.equal(result.exhaustive, false);
  }
});

test('searches verified same-ID aliases with a bounded pace and deduplicates releases', async () => {
  const queries = [];
  const waits = [];
  const shared = { indexerId: 7, guid: 'same', title: 'Shared', evidence: 'unverified' };
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request, loadDetail: async () => detail,
    releaseQueries: async ({ anidbId }) => {
      assert.equal(anidbId, 1234);
      return ['Canonical Anime', 'Official English', 'Official English',
        'x'.repeat(121)];
    },
    pause: async (ms) => { waits.push(ms); },
    searchReleases: async ({ query }) => {
      queries.push(query);
      return { state: 'candidates', items: query === 'Canonical Anime'
        ? [shared] : [shared, { indexerId: 7, guid: 'english',
          title: 'Official English 01', evidence: 'unverified' }] };
    },
  });
  const found = await discover({ requestId: 12 });
  assert.deepEqual(queries, ['Canonical Anime', 'Official English']);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(found.items.map((item) => item.guid), ['same', 'english']);
  assert.equal(found.exhaustive, false);
});

test('a long canonical title can search a short verified same-ID alias', async () => {
  const searched = [];
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request,
    loadDetail: async () => ({ ...detail, title: 'L'.repeat(121) }),
    releaseQueries: async ({ anidbId }) => {
      assert.equal(anidbId, 1234);
      return ['Short Alias'];
    },
    searchReleases: async ({ query }) => {
      searched.push(query);
      return { state: 'candidates', items: [] };
    },
  });
  assert.equal((await discover({ requestId: 12 })).state, 'candidates');
  assert.deepEqual(searched, ['Short Alias']);
});

test('a long canonical title without a valid same-ID alias never searches', async () => {
  let searches = 0;
  const discover = createRequestCandidateDiscovery({
    readRequest: () => request,
    loadDetail: async () => ({ ...detail, title: 'L'.repeat(121) }),
    releaseQueries: async () => ['X', 'Y'.repeat(121)],
    searchReleases: async () => { searches++; return { state: 'candidates', items: [] }; },
  });
  assert.deepEqual(await discover({ requestId: 12 }),
    { state: 'held', reason: 'query_too_long' });
  assert.equal(searches, 0);
});

test('interactive filters apply before pagination and reuse the bounded provider window', async () => {
  const calls=[];
  const discover=createRequestCandidateDiscovery({readRequest:()=>request,loadDetail:async()=>detail,pause:async()=>{},
    searchReleases:async input=>{calls.push(input);return {state:'candidates',items:Array.from({length:120},(_,i)=>({indexerId:7,guid:String(i),title:`Canonical Anime - ${i+1} ${i<60?'720p':'1080p'}`,evidence:'unverified'}))};}});
  const filters={quality:'bd1080',audio:'japanese'};
  const first=await discover({requestId:12,interactive:true,filters});
  assert.equal(first.items.length,50);assert.equal(first.filteredOut,60);assert.equal(first.items[0].guid,'60');assert.equal(first.nextOffset,50);
  const second=await discover({requestId:12,interactive:true,filters,resultOffset:50});
  assert.equal(second.items.length,10);assert.equal(second.nextOffset,null);assert.equal(calls.length,1);assert.equal(calls[0].limit,200);
});

test('a catalogue-year-only manual refinement searches both literal and yearless same-ID names',async()=>{
 const queries=[];const discover=createRequestCandidateDiscovery({readRequest:()=>request,
 loadDetail:async()=>({...detail,title:'Canonical Anime (2025)'}),pause:async()=>{},
 searchReleases:async({query})=>{queries.push(query);return {state:'candidates',items:[]};}});
 await discover({requestId:12,interactive:true,query:'Canonical Anime 2025'});
 assert.deepEqual(queries,['Canonical Anime 2025','Canonical Anime']);
 queries.length=0;
 await discover({requestId:12,interactive:true,query:'Unrelated Anime 2025'});
 assert.deepEqual(queries,['Unrelated Anime 2025']);
});

test('manual group refinements search same-ID alternate names without losing the group',async()=>{
 const queries=[];const discover=createRequestCandidateDiscovery({readRequest:()=>request,
 loadDetail:async()=>({...detail,title:'Canonical Anime (2025)'}),releaseQueries:async()=>['Official English Title','Other Canonical Spelling'],pause:async()=>{},
 searchReleases:async({query})=>{queries.push(query);return {state:'candidates',items:[]};}});
 await discover({requestId:12,interactive:true,query:'Canonical Anime Anime Time'});
 assert.ok(queries.includes('Official English Title Anime Time'));assert.ok(queries.every(query=>query.endsWith(' Anime Time')));assert.ok(queries.length<=4);
});

const completedDetail={...detail,airDate:'2016-04-05',endDate:'2016-06-28'};
const manualFilters={quality:'bd1080',audio:'japanese_dual'};

test('completed Manual Pick supplements the capped broad window with batches and deduplicates before pagination',async()=>{
 const calls=[];
 const release=(guid,title)=>({indexerId:7,guid,title,seeders:10,evidence:'unverified'});
 const base=[...Array.from({length:198},(_,i)=>release(`episode-${i}`,`Canonical Anime - ${i+1} 1080p`)),
  release('base-jp','[Group] Canonical Anime 01-24 1080p'),
  release('base-dual','[Group] Canonical Anime Complete BD 1080p Dual Audio')];
 const batch=[base[198],base[199],
  release('subsplus','[SubsPlus+] Canonical Anime S01 Batch 1080p'),
  release('subsplease','[SubsPlease] Canonical Anime 01-24 Unofficial Batch 1080p')];
 const discover=createRequestCandidateDiscovery({readRequest:()=>request,loadDetail:async()=>completedDetail,
  releaseQueries:async()=>['English Alias','Second Alias','Third Alias'],pause:async()=>{},
  searchReleases:async input=>{calls.push(input);return {state:'candidates',items:input.query.endsWith(' batch')?batch:base};}});
 const found=await discover({requestId:12,interactive:true,filters:manualFilters});
 assert.deepEqual(calls.map(call=>call.query),['Canonical Anime','English Alias','Second Alias','Third Alias','Canonical Anime batch','English Alias batch','Second Alias batch','Third Alias batch']);
 assert.ok(calls.every(call=>call.limit===200&&call.targetEpisodeNumber===null));
 assert.equal(found.state,'candidates');
 assert.deepEqual(found.items.map(item=>item.guid).sort(),['base-dual','base-jp','subsplease','subsplus']);
 assert.equal(found.filteredOut,198);assert.equal(found.nextOffset,null);assert.equal(found.exhaustive,false);
 assert.equal(found.searchIncomplete,undefined);
 const repeated=await discover({requestId:12,interactive:true,filters:manualFilters});
 assert.deepEqual(repeated.items,found.items);assert.equal(calls.length,8);
});

test('batch supplementation preserves manual group refinements, skips existing batch terms and obeys the query length bound',async()=>{
 for(const [phrase,expected] of [
  ['Canonical Anime Anime Time',['Canonical Anime Anime Time','English Alias Anime Time','Canonical Anime Anime Time batch','English Alias Anime Time batch']],
  ['Canonical Anime BATCH',['Canonical Anime BATCH','English Alias BATCH']],
  ['x'.repeat(120),['x'.repeat(120)]],
 ]){
  const queries=[];
  const discover=createRequestCandidateDiscovery({readRequest:()=>request,loadDetail:async()=>completedDetail,
   releaseQueries:async()=>['English Alias'],pause:async()=>{},
   searchReleases:async({query})=>{queries.push(query);return {state:'candidates',items:[]};}});
  await discover({requestId:12,interactive:true,filters:manualFilters,query:phrase});
  assert.deepEqual(queries,expected);assert.ok(queries.every(query=>query.length<=120));
 }
});

test('batch supplementation leaves single-target background searches, airing and explicit episode browsing unchanged',async()=>{
 for(const [observation,options] of [
  [completedDetail,{}],
  [completedDetail,{interactive:true,filters:{...manualFilters,packsOnly:false}}],
  [{...detail,airDate:'2016-04-05'},{interactive:true,filters:manualFilters}],
 ]){
  const queries=[];
  const discover=createRequestCandidateDiscovery({readRequest:()=>request,loadDetail:async()=>observation,pause:async()=>{},
   searchReleases:async({query})=>{queries.push(query);return {state:'candidates',items:[]};}});
  await discover({requestId:12,...options});assert.deepEqual(queries,['Canonical Anime']);
 }
});

test('a failed batch supplement returns existing packs as incomplete and can recover on retry',async()=>{
 const calls=[];let batchFails=true;
 const pack={indexerId:7,guid:'pack',title:'Canonical Anime Complete 1080p',evidence:'unverified'};
 const discover=createRequestCandidateDiscovery({readRequest:()=>request,loadDetail:async()=>completedDetail,pause:async()=>{},
  searchReleases:async({query})=>{calls.push(query);if(query.endsWith(' batch')&&batchFails)throw Error('indexer unavailable');
   return {state:'candidates',items:[query.endsWith(' batch')?{...pack,guid:'extra'}:pack]};}});
 const found=await discover({requestId:12,interactive:true,filters:manualFilters});
 assert.equal(found.state,'candidates');assert.deepEqual(found.items.map(item=>item.guid),['pack']);
 assert.equal(found.searchIncomplete,true);assert.deepEqual(found.failedQueries,['Canonical Anime batch']);
 batchFails=false;
 const retried=await discover({requestId:12,interactive:true,filters:manualFilters});
 assert.equal(retried.items.length,2);assert.equal(retried.searchIncomplete,undefined);
 assert.deepEqual(calls,['Canonical Anime','Canonical Anime batch','Canonical Anime batch']);
});

test('supplemental batches remain stable across filtered pages without repeating provider searches',async()=>{
 const queries=[];
 const batches=Array.from({length:65},(_,i)=>({indexerId:7,guid:`batch-${i}`,
  title:`[Group] Canonical Anime Batch 1080p release ${i}`,seeders:100-i,evidence:'unverified'}));
 const discover=createRequestCandidateDiscovery({readRequest:()=>request,loadDetail:async()=>completedDetail,pause:async()=>{},
  searchReleases:async({query})=>{queries.push(query);return {state:'candidates',items:query.endsWith(' batch')?batches:
   [{indexerId:7,guid:'episode',title:'Canonical Anime - 01 1080p',evidence:'unverified'},batches[64]]};}});
 const first=await discover({requestId:12,interactive:true,filters:manualFilters});
 const second=await discover({requestId:12,interactive:true,filters:manualFilters,resultOffset:50});
 assert.deepEqual(first.items.map(item=>item.guid),Array.from({length:50},(_,i)=>`batch-${i}`));
 assert.deepEqual(second.items.map(item=>item.guid),Array.from({length:15},(_,i)=>`batch-${50+i}`));
 assert.equal(first.nextOffset,50);assert.equal(second.nextOffset,null);
 assert.equal(first.filteredOut,1);assert.equal(second.filteredOut,1);
 assert.deepEqual(queries,['Canonical Anime','Canonical Anime batch']);
});

test('an unavailable batch supplement with no matching broad results reports uncertainty',async()=>{
 const discover=createRequestCandidateDiscovery({readRequest:()=>request,loadDetail:async()=>completedDetail,pause:async()=>{},
  searchReleases:async({query})=>query.endsWith(' batch')?{state:'unavailable'}:
   {state:'candidates',items:[{indexerId:7,guid:'episode',title:'Canonical Anime - 01 1080p',evidence:'unverified'}]}});
 assert.deepEqual(await discover({requestId:12,interactive:true,filters:manualFilters}),
  {state:'held',reason:'release_search_incomplete'});
});

test('mixed explicit Special and regular number one retain their distinct retrieval evidence',async()=>{
 const queries=[];const special={guid:'special',indexerId:1,title:'Canonical Anime S00E01 1080p',evidence:'unverified'};
 const discover=createRequestCandidateDiscovery({readRequest:()=>({...request,episodeIds:[1001,2001]}),loadDetail:async()=>({...detail,total:2,episodes:[...detail.episodes,{id:2001,number:1,type:'Special',title:'OVA'}]}),pause:async()=>{},searchReleases:async({query})=>{queries.push(query);return{state:'candidates',items:[special]}}});
 const found=await discover({requestId:12,searchTargetEpisodeId:1001,searchTargetEpisodeIds:[1001,2001]});
 assert.equal(found.state,'candidates');assert.ok(queries.length>0);assert.equal(found.items[0].targetEpisodeId,undefined,'S00E01 must never become regular episode01');
});
