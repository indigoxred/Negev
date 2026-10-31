import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
const shokoPayload = { IDs: { AniDB: 1001 }, Files: [{ ID: 51, Size: 5,
  IsIgnored: false, Hashes: [{ Type: 'ED2K', Value: digest }], Release: release,
  Locations: [{ ID: 70, FileID: 51, ManagedFolderID: 2,
    AbsolutePath: '/pure/Anime/Example/01.mkv', IsAccessible: true }] }] };
const plexPayload = { MediaContainer: { size: 1, Metadata: [{ ratingKey: '512',
  type: 'episode', librarySectionID: 102, Media: [{ Part: [{ id: 88,
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
  return { target: { anidbId: 42, episodeId: 1001 }, shoko, plex,
    publicLibraryIds: [102],
    shokoMount: { appRoot: '/pure', localRoot },
    plexMount: { appRoot: '/source-pure', localRoot } };
}

test('exact Shoko release plus a readable public Plex Part proves one episode Available', async () => {
  const input = await fixture();
  assert.deepEqual(await observeKnownCardAvailability(input),
    { state: 'available', fileId: 51 });
});

test('a valid playable release stays Available beside an unverified Shoko sibling', async () => {
  const input = await fixture();
  assert.deepEqual(await observeKnownCardAvailability({ ...input,
    shoko: { ...input.shoko, complete: false } }),
  { state: 'available', fileId: 51 });
  assert.deepEqual(await observeKnownCardAvailability({ ...input,
    shoko: { ...input.shoko, complete: false },
    plex: { ...input.plex, parts: [] } }),
  { state: 'unknown', reason: 'observer_incomplete' });
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
