import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readShokoEpisodeFiles } from '../src/availability/shoko-episode-files.mjs';
import { readPlexItemParts } from '../src/availability/plex-item-parts.mjs';
import { observeKnownCardAvailability } from '../src/availability/known-card-availability.mjs';

const cleanup = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));
const digest = 'A'.repeat(32);
const release = { ID: `anidb://${digest}+5`, ProviderName: 'AniDB',
  ReleaseURI: 'https://anidb.net/file/800', FileSize: 5, IsCorrupted: false,
  Hashes: [{ Type: 'ED2K', Value: digest }],
  CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
    PercentageStart: null, PercentageEnd: null }] };
const shokoPayload = { IDs: { ID: 555, ParentSeries: 99, AniDB: 1001 }, Files: [{ ID: 51, Size: 5,
  IsIgnored: false, Hashes: [{ Type: 'ED2K', Value: digest }], Release: release,
  Locations: [{ ID: 70, FileID: 51, ManagedFolderID: 2,
    AbsolutePath: '/pure/Anime/Example/01.mkv', IsAccessible: true }] }] };
const plexPayload = { MediaContainer: { size: 1, Metadata: [{ ratingKey: '512',
  type: 'episode', librarySectionID: 102,
  guid: 'tv.plex.agents.custom.shoko://episode/e555',
  grandparentGuid: 'tv.plex.agents.custom.shoko://show/99',
  Media: [{ Part: [{ id: 88,
    file: '/source-pure/Anime/Example/01.mkv', size: 5 }] }] }] } };

async function fixture() {
  const localRoot = await mkdtemp(path.join(os.tmpdir(), 'negev-known-card-'));
  cleanup.push(localRoot);
  const folder = path.join(localRoot, 'Anime', 'Example');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, '01.mkv'), 'video');
  const shoko = await readShokoEpisodeFiles({ baseUrl: 'http://shoko:8111/',
    apiKey: 'synthetic', anidbId: 42, episodeId: 1001,
    fetchImpl: async () => Response.json(shokoPayload) });
  const plex = await readPlexItemParts({ baseUrl: 'http://plex:32400/',
    token: 'synthetic', ratingKey: 512, libraryId: 102, expectedType: 'episode',
    fetchImpl: async () => Response.json(plexPayload) });
  return { target: { anidbId: 42, episodeId: 1001, kind: 'series' }, shoko, plex,
    publicLibraryIds: [102],
    shokoMount: { appRoot: '/pure', localRoot },
    plexMount: { appRoot: '/source-pure', localRoot } };
}

test('exact Shoko release plus a readable public Plex Part proves one episode Available', async () => {
  const input = await fixture();
  assert.deepEqual(await observeKnownCardAvailability(input),
    { state: 'available', fileId: 51 });
});

test('a Shoko User-linked legacy file needs the same exact public card and physical file', async () => {
  const input = await fixture();
  const user = { ...shokoPayload.Files[0], Release: { ID: null,
    ProviderName: 'User', IsCorrupted: false,
    CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
      PercentageStart: 0, PercentageEnd: 100 }] } };
  const shoko = await readShokoEpisodeFiles({ baseUrl: 'http://shoko:8111/',
    apiKey: 'synthetic', anidbId: 42, episodeId: 1001,
    purpose: 'availability', fetchImpl: async () => Response.json({
      ...shokoPayload, Files: [user] }) });
  assert.deepEqual(await observeKnownCardAvailability({ ...input, shoko }),
    { state: 'available', fileId: 51 });
  assert.deepEqual(await observeKnownCardAvailability({ ...input, shoko,
    target: { ...input.target, kind: 'movie' } }),
  { state: 'available', fileId: 51 });
  assert.deepEqual(await observeKnownCardAvailability({ ...input,
    shoko: { ...shoko, tmdbMovieIds: [2468] },
    target: { ...input.target, kind: 'movie' },
    plex: { ...input.plex, parts: [{ ...input.plex.parts[0],
      cardType: 'movie', itemGuid: 'plex://movie/local', showGuid: null,
      externalGuids: ['tmdb://2468'] }] } }),
  { state: 'available', fileId: 51 });
  assert.deepEqual(await observeKnownCardAvailability({ ...input, shoko,
    plex: { ...input.plex, parts: [{ ...input.plex.parts[0],
      itemGuid: 'tv.plex.agents.custom.shoko://episode/e999' }] } }),
  { state: 'unknown', reason: 'card_identity_unverified' });
  assert.deepEqual(await observeKnownCardAvailability({ ...input,
    shoko: { ...shoko, files: [{ ...shoko.files[0],
      coverage: [{ episodeId: 1001, start: 0, end: 50 }] }] } }),
  { state: 'held', reason: 'partial_episode' });
});

test('a valid playable release stays Available beside an unverified Shoko sibling', async () => {
  const input = await fixture();
  assert.deepEqual(await observeKnownCardAvailability({ ...input,
    shoko: { ...input.shoko, complete: false } }),
  { state: 'available', fileId: 51 });
  assert.deepEqual(await observeKnownCardAvailability({ ...input,
    shoko: { ...input.shoko, complete: false },
    plex: { ...input.plex, parts: [] } }),
  { state: 'unknown', reason: 'card_identity_unverified' });
});

test('a same-size different Plex file cannot create availability', async () => {
  const input = await fixture();
  const other = path.join(input.plexMount.localRoot, 'other');
  await mkdir(other);
  await writeFile(path.join(other, '01.mkv'), 'other');
  const plex = { ...input.plex, parts: [{ ...input.plex.parts[0],
    plexPath: '/source-pure/other/01.mkv' }] };
  assert.deepEqual(await observeKnownCardAvailability({ ...input, plex }),
    { state: 'awaiting_plex' });
});

test('a readable file attached to the wrong Plex show or episode is Unknown', async () => {
  const input = await fixture();
  for (const changed of [
    { itemGuid: 'tv.plex.agents.custom.shoko://episode/e556' },
    { showGuid: 'tv.plex.agents.custom.shoko://show/100' },
  ]) {
    const plex = { ...input.plex, parts: [{ ...input.plex.parts[0], ...changed }] };
    assert.deepEqual(await observeKnownCardAvailability({ ...input, plex }),
      { state: 'unknown', reason: 'card_identity_unverified' });
  }
});

test('an anime movie represented as a native Plex episode keeps exact Shoko identity', async () => {
  const input = await fixture();
  assert.deepEqual(await observeKnownCardAvailability({ ...input,
    target: { ...input.target, kind: 'movie' } }),
  { state: 'available', fileId: 51 });
});

test('a true Plex Movie card requires one exact linked TMDB movie identity', async () => {
  const input = await fixture();
  const shoko = { ...input.shoko, tmdbMovieIds: [2468] };
  const plex = { ...input.plex, parts: [{ ...input.plex.parts[0],
    cardType: 'movie', itemGuid: 'plex://movie/local', showGuid: null,
    externalGuids: ['tmdb://2468'] }] };
  assert.deepEqual(await observeKnownCardAvailability({ ...input,
    target: { ...input.target, kind: 'movie' }, shoko, plex }),
  { state: 'available', fileId: 51 });
  assert.deepEqual(await observeKnownCardAvailability({ ...input,
    target: { ...input.target, kind: 'movie' }, shoko,
    plex: { ...plex, parts: [{ ...plex.parts[0],
      externalGuids: ['tmdb://9999'] }] } }),
  { state: 'unknown', reason: 'card_identity_unverified' });
});

test('one stale Plex version does not hide another proven playable version', async () => {
  const input = await fixture();
  const plex = { ...input.plex, parts: [
    { ...input.plex.parts[0], partId: 87, plexPath: '/source-pure/missing.mkv' },
    input.plex.parts[0],
  ] };
  assert.deepEqual(await observeKnownCardAvailability({ ...input, plex }),
    { state: 'available', fileId: 51 });
});

test('an unreadable sole Plex version stays unknown rather than absent', async () => {
  const input = await fixture();
  const plex = { ...input.plex, parts: [{ ...input.plex.parts[0],
    plexPath: '/source-pure/missing.mkv' }] };
  assert.deepEqual(await observeKnownCardAvailability({ ...input, plex }),
    { state: 'unknown', reason: 'physical_evidence_incomplete' });
});

test('private Plex, missing card, and Shoko 404 never prove file absence', async () => {
  const input = await fixture();
  assert.deepEqual(await observeKnownCardAvailability({ ...input,
    publicLibraryIds: [103] }), { state: 'awaiting_plex' });
  assert.deepEqual(await observeKnownCardAvailability({ ...input,
    plex: { state: 'not_found' } }), { state: 'unknown', reason: 'observer_incomplete' });
  assert.deepEqual(await observeKnownCardAvailability({ ...input,
    shoko: { state: 'not_imported' } }), { state: 'unknown', reason: 'observer_incomplete' });
});

test('registered first-half file remains held even when Plex reads it', async () => {
  const input = await fixture();
  const partial = { ...input.shoko, files: [{ ...input.shoko.files[0],
    coverage: [{ episodeId: 1001, start: 0, end: 50 }] }] };
  assert.deepEqual(await observeKnownCardAvailability({ ...input, shoko: partial }),
    { state: 'held', reason: 'partial_episode' });
});

test('two Shoko file identities claiming one physical Part remain held', async () => {
  const input = await fixture();
  const other = { ...input.shoko.files[0], fileId: 52 };
  const shoko = { ...input.shoko, files: [...input.shoko.files, other] };
  assert.deepEqual(await observeKnownCardAvailability({ ...input, shoko }),
    { state: 'held', reason: 'conflicting_storage_identity' });
});

test('mount mismatch and a bounded comparison budget fail closed', async () => {
  const input = await fixture();
  assert.deepEqual(await observeKnownCardAvailability({ ...input,
    plexMount: { ...input.plexMount, appRoot: '/other' } }),
    { state: 'unknown', reason: 'path_mapping_failed' });
  assert.deepEqual(await observeKnownCardAvailability({ ...input, maxChecks: 0 }),
    { state: 'unknown', reason: 'comparison_budget_exceeded' });
});

test('a public Part under a second explicit Plex mount can be checked', async () => {
  const input = await fixture();
  const relayRoot = path.resolve(input.plexMount.localRoot, '..', 'relay');
  const plex = { ...input.plex, parts: [{ ...input.plex.parts[0],
    plexPath: '/relay/Anime/Example/01.mkv' }] };
  const seen = [];
  const result = await observeKnownCardAvailability({ ...input, plex,
    plexMounts: [input.plexMount,
      { appRoot: '/relay', localRoot: relayRoot }],
    proveImpl: async (candidate) => {
      seen.push(candidate);
      return { state: 'same_file', storageKey: '1:2:5' };
    } });
  assert.deepEqual(result, { state: 'available', fileId: 51 });
  assert.equal(seen[0].plexRoot, relayRoot);
  assert.equal(seen[0].plexPath, path.join(relayRoot, 'Anime', 'Example', '01.mkv'));
});

test('unmapped or overlapping Plex roots cannot silently select a file', async () => {
  const input = await fixture();
  const plex = { ...input.plex, parts: [{ ...input.plex.parts[0],
    plexPath: '/unknown/Anime/Example/01.mkv' }] };
  assert.deepEqual(await observeKnownCardAvailability({ ...input, plex,
    plexMounts: [input.plexMount] }),
  { state: 'unknown', reason: 'path_mapping_failed' });
  await assert.rejects(observeKnownCardAvailability({ ...input,
    plexMounts: [input.plexMount, { appRoot: '/source-pure/Anime',
      localRoot: path.resolve('other') }] }), TypeError);
});

test('a second Plex mount with a symlink to the Shoko file proves physical identity',
  { skip: process.platform === 'win32' }, async () => {
    const input = await fixture();
    const relayRoot = await mkdtemp(path.join(os.tmpdir(), 'negev-relay-card-'));
    cleanup.push(relayRoot);
    await mkdir(path.join(relayRoot, 'Anime', 'Example'), { recursive: true });
    await symlink(path.join(input.shokoMount.localRoot, 'Anime', 'Example', '01.mkv'),
      path.join(relayRoot, 'Anime', 'Example', '01.mkv'));
    const plex = { ...input.plex, parts: [{ ...input.plex.parts[0],
      plexPath: '/relay/Anime/Example/01.mkv' }] };
    assert.deepEqual(await observeKnownCardAvailability({ ...input, plex,
      plexMounts: [input.plexMount,
        { appRoot: '/relay', localRoot: relayRoot }] }),
    { state: 'available', fileId: 51 });
  });
