import assert from 'node:assert/strict';
import test from 'node:test';
import { isPackBonusVideo, planPackBonuses } from '../src/acquisition/pack-bonus-plan.mjs';

const file = (name) => ({ name, size: 100, index: 7 });
const request = { anidbId: 42, episodeIds: [1001], kind: 'series' };
const episode = (id, type = 'Special') => ({ id, number: 1, type, title: 'Bonus' });
const detailFor = (anidbId, episodes, more = {}) => ({ state: 'details', anidbId,
  complete: true, total: episodes.length, page: 1, nextPage: null,
  title: 'Example', kind: 'series', restricted: false, episodes, ...more });
const detail = detailFor(42, [episode(1001, 'Episode'), episode(1002)]);
const extensions = { state: 'extensions', values: ['.mkv', '.mp4'] };
const related = { state: 'related_titles', anidbId: 42,
  items: [{ anidbId: 43, title: 'Side Story', relation: 'side story' }] };
const preview = (filename, anidbId = 42, episodeId = 1002) => ({ status: 200,
  release: { ProviderName: 'Offline Importer', ID: `offline://${anidbId}-${episodeId}`,
    IsCorrupted: false, OriginalFilename: filename, CrossReferences: [{
      AnidbAnimeID: anidbId, AnidbEpisodeID: episodeId,
      PercentageStart: 0, PercentageEnd: 100 }] } });
const options = (more = {}) => ({ request, detail, related,
  files: [file('Example.S01E01.mkv'), file('Pack/Specials/bonus.mkv')],
  videoExtensions: extensions, offlineLookup: async ({ filename }) => preview(filename),
  loadDetail: async () => detail, readOwnership: async () => ({ state: 'missing' }), ...more });

// Broadening the marker regexp would silently remove normal episodes from the main pack.
test('recognizes explicit bonus directories at any depth and filename markers', () => {
  for (const name of ['OVA/clip.mkv', 'Pack/OAD/clip.mkv', 'Specials/clip.mkv',
    'Pack/disc/Extras/clip.mkv', 'Films/film.mp4', 'Pack/Movies/film.mkv',
    'Example - OVA 01.mkv', 'Example.NCOP01.mkv', 'Example.ED2.mkv',
    'Example.PV01.mkv', 'Example - Trailer.mkv', 'Example.Special01.mkv']) {
    assert.equal(isPackBonusVideo(name), true, name);
  }
  for (const name of ['Special A/Example.S01E01.mkv', 'Films/Example.S01E01.mkv',
    'My Special Show - 01.mkv', '[OVA] Example - 01.mkv',
    'Movie Lovers - 01.mkv', 'OVA/cover.jpg', '../OVA/clip.mkv', '/OVA/clip.mkv',
    'C:/OVA/clip.mkv', 'Pack\\OVA\\clip.mkv', 'OVA/../clip.mkv', 'OVA/clip\u0000.mkv']) {
    assert.equal(isPackBonusVideo(name), false, name);
  }
});

test('adds one exact same-series Special with missing ownership and preserves main objects', async () => {
  const input = options();
  const result = await planPackBonuses(input);
  assert.equal(result.mainFiles[0], input.files[0]);
  assert.deepEqual(result.bonusFiles, [{ name: 'Pack/Specials/bonus.mkv', size: 100,
    anidbId: 42, episodeIds: [1002], kind: 'special', evidence: 'shoko_filename_prediction' }]);
  assert.deepEqual(result.skippedBonuses, []);
});

test('preserves all unclassified files including unsafe and passive entries for parent gates', async () => {
  const files = [file('Example.S01E01.mkv'), file('README.txt'), file('../OVA/clip.mkv')];
  assert.deepEqual((await planPackBonuses(options({ files }))).mainFiles, files);
});

test('unknown previews, joint coverage, wrong filenames and provider failures skip only the bonus', async () => {
  for (const offlineLookup of [async () => ({ status: 204 }), async () => ({ status: 503 }),
    async () => { throw Error('offline'); }, async ({ filename }) => {
      const result = preview(filename); result.release.CrossReferences.push(result.release.CrossReferences[0]); return result;
    }, async ({ filename }) => { const result = preview(filename);
      result.release.CrossReferences[0].PercentageEnd = 99; return result;
    }, async () => preview('wrong.mkv')]) {
    const result = await planPackBonuses(options({ offlineLookup }));
    assert.equal(result.mainFiles.length, 1);
    assert.equal(result.bonusFiles.length, 0);
    assert.equal(result.skippedBonuses.length, 1);
  }
});

test('cross-series bonuses require exact relation and complete own metadata for movie or OVA formats', async () => {
  for (const [format, kind, want] of [['OVA', 'series', 'ova'], ['OAD', 'series', 'ova'],
    ['TV Special', 'series', 'special'], [undefined, 'movie', 'movie']]) {
    const result = await planPackBonuses(options({
      offlineLookup: async ({ filename }) => preview(filename, 43, 2001),
      loadDetail: async ({ anidbId }) => detailFor(anidbId, [episode(2001, 'Episode')], { type: format, kind }),
    }));
    assert.equal(result.bonusFiles[0]?.anidbId, 43, format);
    assert.equal(result.bonusFiles[0]?.kind, want, format);
    assert.deepEqual(result.bonusFiles[0]?.episodeIds, [2001]);
  }
});

test('rejects unrelated identities, sequel TV and unavailable cross-series format or catalogue', async () => {
  for (const change of [
    { related: { ...related, items: [] } },
    { related: { ...related, anidbId: 99 } },
    { loadDetail: async () => detailFor(43, [episode(2001, 'Episode')], { type: 'TV' }) },
    { loadDetail: async () => detailFor(43, [episode(2001, 'Episode')]) },
    { loadDetail: async () => detailFor(99, [episode(2001, 'Episode')], { type: 'OVA' }) },
    { loadDetail: async () => ({ state: 'unavailable' }) },
    { loadDetail: async () => { throw Error('metadata'); } },
    { loadDetail: async () => detailFor(43, [episode(2002, 'Episode')], { type: 'OVA' }) },
    { loadDetail: async () => ({ ...detailFor(43, [episode(2001, 'Episode')], { type: 'OVA' }), complete: false }) },
  ]) {
    const result = await planPackBonuses(options({
      offlineLookup: async ({ filename }) => preview(filename, 43, 2001),
      loadDetail: async () => detailFor(43, [episode(2001, 'Episode')], { type: 'OVA' }), ...change }));
    assert.equal(result.bonusFiles.length, 0);
    assert.equal(result.mainFiles.length, 1);
    assert.equal(result.skippedBonuses.length, 1);
  }
});

test('same-series never imports regular episodes as bonuses and accepts known nonregular types', async () => {
  for (const type of ['Episode', 'Special', 'Credit', 'Trailer', 'Parody', 'Other', 'Unknown']) {
    const result = await planPackBonuses(options({ detail: detailFor(42, [episode(1002, type)]) }));
    assert.equal(result.bonusFiles.length, ['Episode', 'Unknown'].includes(type) ? 0 : 1, type);
  }
});

test('restricted metadata requires explicit authorization and uncertain metadata is neutral', async () => {
  for (const [restricted, allowRestricted, count] of [[true, false, 0], [true, true, 1],
    [null, true, 0], [false, false, 1]]) {
    const result = await planPackBonuses(options({ detail: { ...detail, restricted }, allowRestricted }));
    assert.equal(result.bonusFiles.length, count);
  }
});

test('ownership must be explicitly missing; unavailable callbacks and unsupported videos are optional skips', async () => {
  for (const change of [
    { readOwnership: async () => ({ state: 'owned' }) },
    { readOwnership: async () => ({ state: 'uncertain' }) },
    { readOwnership: async () => null },
    { readOwnership: async () => { throw Error('ownership'); } },
    { readOwnership: undefined }, { offlineLookup: undefined }, { loadDetail: undefined },
    { videoExtensions: { state: 'extensions', values: ['.mp4'] } },
  ]) {
    const result = await planPackBonuses(options(change));
    assert.equal(result.bonusFiles.length, 0);
    assert.equal(result.mainFiles.length, 1);
    assert.deepEqual(result.skippedBonuses.map(({ name, size }) => ({ name, size })),
      [{ name: 'Pack/Specials/bonus.mkv', size: 100 }]);
  }
});

test('bounds optional work to twenty files, coalesces metadata and checks sequentially', async () => {
  let loads = 0, active = 0, peak = 0;
  const result = await planPackBonuses(options({
    files: [file('Example.S01E01.mkv'), ...Array.from({ length: 23 }, (_, n) => file(`OVA/bonus${n}.mkv`))],
    offlineLookup: async ({ filename }) => { active++; peak = Math.max(peak, active);
      await Promise.resolve(); active--; return preview(filename, 43, 2001); },
    loadDetail: async () => { loads++; return detailFor(43, [episode(2001, 'Episode')], { format: 'OVA' }); },
    readOwnership: async (identity) => { assert.deepEqual(identity, { anidbId: 43, episodeId: 2001 }); return { state: 'missing' }; },
  }));
  assert.equal(peak, 1);
  assert.equal(loads, 1);
  assert.equal(result.bonusFiles.length, 20);
  assert.equal(result.skippedBonuses.length, 3);
});

test('aggregate deadline skips hanging evidence and ignores late results', async () => {
  let finish;
  const started = Date.now();
  const result = await planPackBonuses(options({
    offlineLookup: () => new Promise((resolve) => { finish = resolve; }),
  }));
  assert.ok(Date.now() - started < 11_000);
  assert.equal(result.bonusFiles.length, 0);
  assert.equal(result.skippedBonuses.length, 1);
  finish(preview('bonus.mkv'));
  await Promise.resolve();
  assert.equal(result.bonusFiles.length, 0);
});

test('title words, bracket group names and unknown episode types do not authorize optional downloads', async () => {
  for (const name of ['My OP.mkv', 'My ED.mkv', 'My PV.mkv', 'Special Title.mkv',
    '[Trailer] Example - 01.mkv', '[Group OVA] Example - 01.mkv']) {
    assert.equal(isPackBonusVideo(name), false, name);
  }
  const result = await planPackBonuses(options({
    offlineLookup: async ({ filename }) => preview(filename, 43, 2001),
    loadDetail: async () => detailFor(43, [episode(2001, 'Unknown')], { type: 'OVA' }),
  }));
  assert.equal(result.bonusFiles.length, 0);
});

test('regular episode identity survives brackets and revision suffixes in bonus directories', () => {
  assert.equal(isPackBonusVideo('Extras/[Example S01E01].mkv'), false);
  assert.equal(isPackBonusVideo('OVA/Example.S01E01v2.mkv'), false);
});

test('cross-series metadata assembles complete pages and rejects changing format evidence', async () => {
  for (const [secondFormat, count] of [['OVA', 1], ['TV', 0]]) {
    const result = await planPackBonuses(options({
      offlineLookup: async ({ filename }) => preview(filename, 43, 2001),
      loadDetail: async ({ page }) => ({ ...detailFor(43,
        [episode(page === 1 ? 2001 : 2002, 'Episode')]), total: 2,
        page, complete: false, nextPage: page === 1 ? 2 : null,
        format: page === 1 ? 'OVA' : secondFormat }),
    }));
    assert.equal(result.bonusFiles.length, count, secondFormat);
  }
});

test('pure filename helper is independently importable and preserves video and path gates', async () => {
  const { isPackBonusVideo: classify } = await import('../src/acquisition/pack-bonus-name.mjs');
  assert.equal(classify, isPackBonusVideo);
  for (const name of ['OVA/clip.mkv', 'Pack/Disc/OVA/clip.mp4']) assert.equal(classify(name), true);
  for (const name of ['OVA/clip.exe', 'OVA/clip', 'OVA/readme.txt', 'OVA/S01E01.mkv',
    'OVA//clip.mkv', 'OVA/./clip.mkv', 'OVA./clip.mkv', 'OVA /clip.mkv', 'OVA/\u202eclip.mkv']) {
    assert.equal(classify(name), false, name);
  }
});
