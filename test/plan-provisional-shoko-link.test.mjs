import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { planProvisionalShokoLink } from '../src/acquisition/plan-provisional-shoko-link.mjs';

const evidence = evaluateHandoffEvidence({ identity: 'provisional',
  anidbId: 42, torrentHash: 'a'.repeat(40),
  files: [{ name: '05.mkv', size: 900, ed2k: 'A'.repeat(32),
    episodeIds: [1005] }], subtitles: [] });
const handoff = { status: 'published_observed',
  manifest: evidence.manifest, evidenceDigest: evidence.digest,
  publishName: `negev-7-${evidence.digest.slice(0, 16)}` };
const attempt = { id: 7, requestId: 1, status: 'torrent_observed',
  anidbId: 42, torrentHash: 'a'.repeat(40), episodeIds: [1005],
  candidateTitle: '[SubsPlease] Example - 05 (1080p)' };
const request = { id: 1, status: 'held', kind: 'series',
  anidbId: 42, episodeIds: [1005] };
const detail = { state: 'details', complete: true, total: 2,
  anidbId: 42, title: 'Example', kind: 'series', restricted: false,
  episodes: [{ id: 1004, number: 4, type: 'Episode', title: 'Four' },
    { id: 1005, number: 5, type: 'Episode', title: 'Five' }] };
const related = { state: 'related_titles', anidbId: 42, items: [] };
const shokoImportRoot = '/pure/Import/Negev';
const ownedPath = `${shokoImportRoot}/${handoff.publishName}/05.mkv`;
const observed = { state: 'imported_unrecognized', fileId: 19711,
  ed2k: 'A'.repeat(32), size: 900,
  locations: [{ managedFolderId: 1, path: ownedPath, accessible: true }] };
const input = { handoff, attempt, request, detail, related,
  observed, shokoImportRoot };

test('Negev may plan an owned, unrecognized episode using its saved release and Shoko catalogue', () => {
  assert.deepEqual(planProvisionalShokoLink(input), {
    state: 'link_ready', fileId: 19711, anidbId: 42,
    episodeId: 1005, ed2k: 'A'.repeat(32), size: 900,
    evidenceDigest: evidence.digest,
  });
});

test('a wrong title, episode, or related installment cannot become a User link', () => {
  for (const changed of [
    { attempt: { ...attempt, candidateTitle: '[SubsPlease] Other - 05' } },
    { handoff: { ...handoff, manifest: { ...handoff.manifest,
      videos: [{ ...handoff.manifest.videos[0], episodeIds: [1004] }] } } },
    { related: { ...related, items: [{ anidbId: 43,
      title: 'Example: Sequel' }] },
    attempt: { ...attempt, candidateTitle: '[SubsPlease] Example: Sequel - 05' } },
  ]) {
    assert.notEqual(planProvisionalShokoLink({ ...input, ...changed }).state,
      'link_ready');
  }
});

test('a Shoko file outside Negev owned Import or already recognized cannot be relinked', () => {
  for (const changed of [
    { ...observed, locations: [{ managedFolderId: 1,
      path: '/pure/Import/Other/05.mkv', accessible: true }] },
    { ...observed, locations: [{ managedFolderId: 1,
      path: ownedPath, accessible: false }] },
    { ...observed, state: 'imported_recognized' },
  ]) {
    assert.notEqual(planProvisionalShokoLink({ ...input,
      observed: changed }).state, 'link_ready');
  }
});

test('legacy attempts without a saved release title remain held', () => {
  assert.deepEqual(planProvisionalShokoLink({ ...input,
    attempt: { ...attempt, candidateTitle: undefined } }),
  { state: 'held', reason: 'release_title_unavailable' });
});

test('a same-ID Shoko alias can corroborate an airing release title', () => {
  assert.equal(planProvisionalShokoLink({ ...input,
    detail: { ...detail, title: 'Rei no Monogatari' },
    aliases: ['Example'] }).state, 'link_ready');
});

test('the same bounded plan supports a one-file anime film', () => {
  const filmDetail = { ...detail, kind: 'movie', total: 1,
    episodes: [{ id: 1005, number: 1, type: 'Episode', title: 'Film' }] };
  assert.equal(planProvisionalShokoLink({ ...input,
    request: { ...request, kind: 'movie' }, detail: filmDetail }).state,
  'link_ready');
});
