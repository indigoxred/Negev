import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPlexAvailabilityService } from '../src/availability/plex-availability-service.mjs';
import { readShokoEpisodeFiles } from '../src/availability/shoko-episode-files.mjs';
import { openPlexCardIndex } from '../src/availability/plex-card-index.mjs';
import { probePhysicalCandidate } from '../src/availability/physical-plex-part.mjs';

const cleanup = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((dir) => rm(dir,
  { recursive: true, force: true }))));
const digest = 'A'.repeat(32);

async function fixture({ detailedPage = false, densePage = false,
  userRelease = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'negev-plex-service-'));
  cleanup.push(root);
  await mkdir(path.join(root, 'Anime'), { recursive: true });
  await writeFile(path.join(root, 'Anime', 'one.mkv'), 'video');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(`${url.hostname}${url.pathname}`);
    if (url.hostname === 'plex' && url.pathname === '/library/sections') {
      return Response.json({ MediaContainer: { size: 1, Directory: [{
        key: '102', type: 'show', agent: 'tv.plex.agents.custom.shoko',
        scanner: 'Plex TV Series',
        Location: [{ path: '/anime-native/Relay' }],
      }] } });
    }
    if (url.hostname === 'plex' && url.pathname === '/library/sections/102') {
      return Response.json({ MediaContainer: { librarySectionID: 102,
        Directory: [{ type: '4', key: '/library/sections/102/all?type=4' }] } });
    }
    if (url.hostname === 'plex' && url.pathname === '/library/sections/102/all') {
      if (url.searchParams.has('guid')) {
        return Response.json({ MediaContainer: { librarySectionID: 102,
          offset: 0, totalSize: 1, size: 1,
          Metadata: [{ ratingKey: '500', type: 'episode',
            librarySectionID: 102, guid: url.searchParams.get('guid') }] } });
      }
      if (densePage) {
        const metadata = Array.from({ length: 5 }, (_, card) => ({
          ratingKey: String(500 + card), type: 'episode', librarySectionID: 102,
          guid: `tv.plex.agents.custom.shoko://episode/e${555 + card}`,
          grandparentGuid: 'tv.plex.agents.custom.shoko://show/99',
          Media: [{ Part: Array.from({ length: 20 }, (_, part) => ({
            id: 900 + card * 20 + part, size: 5,
            file: '/source-pure/Anime/one.mkv',
          })) }],
        }));
        return Response.json({ MediaContainer: { librarySectionID: 102,
          offset: 0, totalSize: 5, size: 5, Metadata: metadata } });
      }
      return Response.json({ MediaContainer: { librarySectionID: 102, offset: 0,
        totalSize: 1, size: 1, Metadata: [{ ratingKey: '500', type: 'episode',
          librarySectionID: 102,
          ...(detailedPage ? { guid: 'tv.plex.agents.custom.shoko://episode/e555',
            grandparentGuid: 'tv.plex.agents.custom.shoko://show/99',
            Media: [{ Part: [{ id: 900, size: 5,
              file: '/source-pure/Anime/one.mkv' }] }] } : {}) }] } });
    }
    if (url.hostname === 'plex' && url.pathname === '/library/metadata/500') {
      return Response.json({ MediaContainer: { size: 1, Metadata: [{
        ratingKey: '500', type: 'episode', librarySectionID: 102,
        guid: 'tv.plex.agents.custom.shoko://episode/e555',
        grandparentGuid: 'tv.plex.agents.custom.shoko://show/99',
        Media: [{ Part: [{ id: 900, size: 5,
          file: '/source-pure/Anime/one.mkv' }] }],
      }] } });
    }
    if (url.hostname === 'shoko' && url.pathname ===
        '/api/v3/Episode/AniDB/1001/Episode') {
      return Response.json({ IDs: { ID: 555, ParentSeries: 99,
        AniDB: 1001 }, Files: [{ ID: 51,
        Size: 5, IsIgnored: false, Hashes: [{ Type: 'ED2K', Value: digest }],
        Release: userRelease ? { ID: null, ProviderName: 'User',
          IsCorrupted: false,
          CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
            PercentageStart: 0, PercentageEnd: 100 }] } :
        { ID: `anidb://${digest}+5`, ProviderName: 'AniDB',
          ReleaseURI: 'https://anidb.net/file/800', FileSize: 5,
          IsCorrupted: false, Hashes: [{ Type: 'ED2K', Value: digest }],
          CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
            PercentageStart: null, PercentageEnd: null }] },
        Locations: [{ FileID: 51, IsAccessible: true,
          AbsolutePath: '/pure/Anime/one.mkv' }],
      }] });
    }
    return new Response(null, { status: 404 });
  };
  const config = { dbPath: path.join(root, 'negev.sqlite'),
    shokoBaseUrl: 'http://shoko:8111/', shokoApiKey: 'synthetic',
    plexBaseUrl: 'http://plex:32400/', plexToken: 'synthetic',
    publicSections: { episode: [102], movie: [] },
    shokoMount: { appRoot: '/pure', localRoot: root },
    plexMount: { appRoot: '/source-pure', localRoot: root },
    fetchImpl, now: () => 100 };
  return { config, calls };
}

test('first-time section probe reports only Plex health even when a card exists', async () => {
  const { config, calls } = await fixture();
  const service = createPlexAvailabilityService(config);
  assert.deepEqual(await service.probeFirstTimeSections({ kind: 'series' }),
    { state: 'healthy_unconfirmed', libraryIds: [102], parts: [],
      complete: false, probeCoverage: 'health_only', sourceVerified: false });
  assert.deepEqual(calls, ['plex/library/sections/102',
    'plex/library/sections/102/all']);
  service.close();
});

test('first-time source policy verifies the public Plex library before page reads', async () => {
  const { config, calls } = await fixture();
  config.sourcePolicy = [{ libraryId: 102, type: 'show',
    agent: 'tv.plex.agents.custom.shoko', scanner: 'Plex TV Series',
    roots: ['/anime-native/Relay'] }];
  const service = createPlexAvailabilityService(config);
  assert.deepEqual(await service.probeFirstTimeSections({ kind: 'series' }),
    { state: 'healthy_unconfirmed', libraryIds: [102], parts: [],
      complete: false, probeCoverage: 'health_only', sourceVerified: true });
  assert.deepEqual(calls.slice(0, 2),
    ['plex/library/sections', 'plex/library/sections/102']);
  service.close();
});

test('a direct Shoko import becomes Available only after public Plex card discovery', async () => {
  const { config, calls } = await fixture();
  const service = createPlexAvailabilityService(config);
  const target = { anidbId: 42, episodeId: 1001, kind: 'series' };
  assert.deepEqual(await service.observeTarget(target),
    { state: 'unknown', reason: 'card_discovery_incomplete' });
  assert.deepEqual(await service.tick({ libraryId: 102, kind: 'episode' }),
    { state: 'page_indexed', processed: 1, nextOffset: 0 });
  assert.deepEqual(await service.observeTarget(target),
    { state: 'available', fileId: 51 });
  const exact = await service.observeTarget(target, undefined,
    { includeProof: true });
  const { cardRevision, ...exactBody } = exact;
  assert.equal(cardRevision.observedMs, 100);
  assert.equal(typeof cardRevision.identitySignature, 'string');
  const { storageKey, ...proof } = exact.proof;
  assert.match(storageKey, /^\d+:\d+:5$/);
  assert.deepEqual({ ...exactBody, proof }, { state: 'available', fileId: 51,
    proof: { fileId: 51, libraryId: 102, ratingKey: 500, partId: 900 } });
  assert.deepEqual(await service.observeTarget({ ...target, kind: 'movie' }),
    { state: 'available', fileId: 51 });
  assert.deepEqual(await service.scanRecent({ libraryId: 102, kind: 'episode' }),
    { state: 'page_indexed', processed: 1, nextOffset: 0 });
  assert.equal(calls.filter((call) => call === 'plex/library/metadata/500').length, 5);
  service.close();
});

test('one fresh file candidate verifies its public card without a second Shoko episode read', async () => {
  const { config, calls } = await fixture();
  const service = createPlexAvailabilityService(config);
  try {
    await service.tick({ libraryId: 102, kind: 'episode' });
    const candidate = { state: 'candidate', fileId: 51, size: 5,
      anidbFileId: null, releaseEvidence: 'shoko_user_link',
      pairs: [{ anidbId: 42, episodeId: 1001 }],
      identities: [{ anidbId: 42, episodeId: 1001,
        shokoSeriesId: 99, shokoEpisodeId: 555, tmdbMovieIds: [] }],
      sourcePaths: ['/pure/Anime/one.mkv'] };
    const exact = await service.observeFileCandidate({ candidate,
      target: { anidbId: 42, episodeId: 1001, kind: 'series' } });
    const { cardRevision, ...exactBody } = exact;
    assert.equal(cardRevision.observedMs, 100);
    assert.equal(typeof cardRevision.identitySignature, 'string');
    const { storageKey, ...proof } = exact.proof;
    assert.match(storageKey, /^\d+:\d+:5$/);
    assert.deepEqual({ ...exactBody, proof },
    { state: 'available', fileId: 51,
      proof: { fileId: 51, libraryId: 102, ratingKey: 500, partId: 900 } });
    assert.equal(calls.some((call) => call.startsWith('shoko/')), false);
  } finally { service.close(); }
});

test('file candidates share one capped Plex card budget across a batch', async () => {
  const { config, calls } = await fixture();
  const service = createPlexAvailabilityService(config);
  try {
    await service.tick({ libraryId: 102, kind: 'episode' });
    const candidate = { state: 'candidate', fileId: 51, size: 5,
      anidbFileId: null, releaseEvidence: 'shoko_user_link',
      pairs: [{ anidbId: 42, episodeId: 1001 }],
      identities: [{ anidbId: 42, episodeId: 1001,
        shokoSeriesId: 99, shokoEpisodeId: 555, tmdbMovieIds: [] }],
      sourcePaths: ['/pure/Anime/one.mkv'] };
    const target = { anidbId: 42, episodeId: 1001, kind: 'series' };
    const budget = { cardReads: 9, physicalProbes: 0 };
    const before = calls.filter((call) =>
      call === 'plex/library/metadata/500').length;
    assert.equal((await service.observeFileCandidate({ candidate, target,
      budget })).state, 'available');
    assert.equal(budget.cardReads, 10);
    const probesAtLimit = budget.physicalProbes;
    assert.equal((await service.observeFileCandidate({ candidate, target,
      budget })).state, 'unknown');
    assert.equal(budget.physicalProbes, probesAtLimit);
    assert.equal(calls.filter((call) =>
      call === 'plex/library/metadata/500').length - before, 1);
  } finally { service.close(); }
});

test('an exhausted physical probe budget stops before another card read', async () => {
  const { config, calls } = await fixture();
  const service = createPlexAvailabilityService(config);
  try {
    await service.tick({ libraryId: 102, kind: 'episode' });
    const candidate = { state: 'candidate', fileId: 51, size: 5,
      anidbFileId: null, releaseEvidence: 'shoko_user_link',
      pairs: [{ anidbId: 42, episodeId: 1001 }],
      identities: [{ anidbId: 42, episodeId: 1001,
        shokoSeriesId: 99, shokoEpisodeId: 555, tmdbMovieIds: [] }],
      sourcePaths: ['/pure/Anime/one.mkv'] };
    const target = { anidbId: 42, episodeId: 1001, kind: 'series' };
    const budget = { cardReads: 0, physicalProbes: 63 };
    assert.equal((await service.observeFileCandidate({ candidate, target,
      budget })).state, 'available');
    assert.deepEqual(budget, { cardReads: 1, physicalProbes: 64 });
    const before = calls.length;
    assert.equal((await service.observeFileCandidate({ candidate, target,
      budget })).state, 'unknown');
    assert.equal(calls.length, before);
  } finally { service.close(); }
});

test('an opt-in index tick reports bounded provider and filesystem probe counts', async () => {
  const { config } = await fixture({ detailedPage: true });
  const service = createPlexAvailabilityService(config);
  try {
    const result = await service.tick({ libraryId: 102, kind: 'episode',
      includeLoad: true });
    assert.equal(result.state, 'page_indexed');
    assert.deepEqual({ ...result.load, elapsedMs: null }, { sectionPages: 1,
      exactCardReads: 0, candidateProbes: 1, elapsedMs: null });
    assert.equal(Number.isSafeInteger(result.load.elapsedMs) &&
      result.load.elapsedMs >= 0, true);
  } finally { service.close(); }
});

test('one dense Plex index tick covers every part in its bounded page', async () => {
  const { config } = await fixture({ densePage: true });
  const service = createPlexAvailabilityService(config);
  try {
    const result = await service.tick({ libraryId: 102, kind: 'episode',
      includeLoad: true });
    assert.equal(result.state, 'page_indexed');
    assert.equal(result.processed, 5);
    assert.equal(result.load.candidateProbes, 100);
    const db = new DatabaseSync(config.dbPath);
    try {
      const rows = db.prepare(`SELECT candidate_key AS candidateKey
        FROM plex_part_candidates WHERE library_id=102`).all();
      assert.equal(rows.length, 100);
      assert.equal(rows.filter((row) => row.candidateKey !== null).length, 100);
    } finally { db.close(); }
  } finally { service.close(); }
});

test('index load counts exact-card fallback when a page omits media', async () => {
  const { config } = await fixture();
  const service = createPlexAvailabilityService(config);
  try {
    const result = await service.tick({ libraryId: 102, kind: 'episode',
      includeLoad: true });
    assert.deepEqual({ ...result.load, elapsedMs: null }, { sectionPages: 1,
      exactCardReads: 1, candidateProbes: 1, elapsedMs: null });
  } finally { service.close(); }
});

test('paced Plex card scan stores a scoped physical identity hint', async () => {
  const { config } = await fixture();
  const service = createPlexAvailabilityService(config);
  assert.equal((await service.tick({ libraryId: 102,
    kind: 'episode' })).state, 'page_indexed');
  service.close();
  const db = new DatabaseSync(config.dbPath);
  const row = db.prepare(`SELECT candidate_key AS candidateKey
    FROM plex_part_candidates WHERE library_id=102 AND rating_key=500`).get();
  assert.match(row.candidateKey, /^\d+:\d+:5$/);
  db.close();
});

test('detailed page indexes without card GET but availability rechecks the exact card', async () => {
  const { config, calls } = await fixture({ detailedPage: true });
  const service = createPlexAvailabilityService(config);
  assert.deepEqual(await service.tick({ libraryId: 102, kind: 'episode' }),
    { state: 'page_indexed', processed: 1, nextOffset: 0 });
  assert.equal(calls.filter((call) => call === 'plex/library/metadata/500').length, 0);
  assert.deepEqual(await service.observeTarget({ anidbId: 42,
    episodeId: 1001, kind: 'series' }),
  { state: 'available', fileId: 51 });
  assert.equal(calls.filter((call) => call === 'plex/library/metadata/500').length, 1);
  service.close();
});

test('exact file key selects a playable episode among twelve same-size cards', async () => {
  const { config, calls } = await fixture();
  const source = path.join(config.shokoMount.localRoot, 'Anime', 'one.mkv');
  const identity = await probePhysicalCandidate({ filePath: source,
    allowedRoot: config.shokoMount.localRoot, expectedSize: 5 });
  assert.equal(identity.state, 'candidate');
  const index = openPlexCardIndex(config.dbPath);
  for (let ratingKey = 500; ratingKey < 512; ratingKey++) {
    index.recordCard({ libraryId: 102, ratingKey, kind: 'episode',
      observedMs: 10, parts: [{ libraryId: 102, partId: ratingKey + 400,
        size: 5, plexPath: `/source-pure/Anime/${ratingKey}.mkv`,
        ...(ratingKey === 500 ? { candidateKey: identity.candidateKey } : {}) }] });
  }
  assert.equal(index.lookupCards({ sizes: [5], libraryIds: [102],
    kind: 'episode' }).state, 'held');
  index.close();
  const service = createPlexAvailabilityService(config);
  assert.deepEqual(await service.observeTarget({ anidbId: 42,
    episodeId: 1001, kind: 'series' }),
  { state: 'available', fileId: 51 });
  assert.deepEqual(calls.filter((call) =>
    call.startsWith('plex/library/metadata/')), ['plex/library/metadata/500']);
  service.close();
});

test('unlisted private library cannot be scanned by the public observer', async () => {
  const { config, calls } = await fixture();
  const service = createPlexAvailabilityService(config);
  assert.deepEqual(await service.tick({ libraryId: 103, kind: 'episode' }),
    { state: 'held', reason: 'library_not_allowed' });
  assert.deepEqual(await service.scanRecent({ libraryId: 103, kind: 'episode' }),
    { state: 'held', reason: 'library_not_allowed' });
  assert.deepEqual(calls, []);
  service.close();
});

test('opt-in exact GUID probe can find a direct import before the paced index reaches it', async () => {
  const { config, calls } = await fixture();
  const service = createPlexAvailabilityService({ ...config, guidProbe: true });
  const result = await service.observeTarget({ anidbId: 42,
    episodeId: 1001, kind: 'series' });
  assert.deepEqual(result, { state: 'available', fileId: 51 });
  assert.equal(calls.includes('plex/library/sections/102/all'), true);
  service.close();
});

test('public observer accepts a physically matched Shoko User link only for availability', async () => {
  const { config } = await fixture({ userRelease: true });
  const target = { anidbId: 42, episodeId: 1001, kind: 'series' };
  assert.equal((await readShokoEpisodeFiles({ baseUrl: config.shokoBaseUrl,
    apiKey: config.shokoApiKey, ...target,
    fetchImpl: config.fetchImpl })).state, 'unavailable');
  const service = createPlexAvailabilityService({ ...config, guidProbe: true });
  assert.deepEqual(await service.observeTarget(target),
    { state: 'available', fileId: 51 });
  service.close();
});

test('trusted Shoko observation avoids a second episode request during GUID discovery', async () => {
  const { config, calls } = await fixture();
  const target = { anidbId: 42, episodeId: 1001, kind: 'series' };
  const shoko = await readShokoEpisodeFiles({ baseUrl: config.shokoBaseUrl,
    apiKey: config.shokoApiKey, ...target, fetchImpl: config.fetchImpl });
  const service = createPlexAvailabilityService({ ...config, guidProbe: true });
  assert.deepEqual(await service.observeTarget(target, shoko),
    { state: 'available', fileId: 51 });
  assert.equal(calls.filter((call) => call ===
    'shoko/api/v3/Episode/AniDB/1001/Episode').length, 1);
  service.close();
});
