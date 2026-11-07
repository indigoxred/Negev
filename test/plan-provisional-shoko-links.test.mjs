import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { planProvisionalShokoLinks } from '../src/acquisition/plan-provisional-shoko-links.mjs';

const files = [
  { name: 'Show/01.mkv', size: 900, ed2k: 'A'.repeat(32), episodeIds: [1001] },
  { name: 'Show/02.mkv', size: 901, ed2k: 'B'.repeat(32), episodeIds: [1002] },
];
const evidence = evaluateHandoffEvidence({ identity: 'provisional',
  anidbId: 42, torrentHash: 'a'.repeat(40), files, subtitles: [] });
const publishName = `negev-7-${evidence.digest.slice(0, 16)}`;
const handoff = { status: 'published_observed',
  manifest: evidence.manifest, evidenceDigest: evidence.digest, publishName };
const attempt = { id: 7, requestId: 1, status: 'torrent_observed',
  anidbId: 42, torrentHash: 'a'.repeat(40), episodeIds: [1001, 1002],
  candidateTitle: '[SubsPlease] Example - 01-02 (1080p)' };
const request = { id: 1, status: 'held', kind: 'series', anidbId: 42,
  episodeIds: [1001, 1002] };
const detail = { state: 'details', complete: true, total: 2, anidbId: 42,
  title: 'Example', kind: 'series', restricted: false,
  episodes: [{ id: 1001, number: 1, type: 'Episode', title: 'One' },
    { id: 1002, number: 2, type: 'Episode', title: 'Two' }] };
const root = '/pure/Import/Negev';
const observedFiles = files.map((file, index) => ({
  state: 'imported_unrecognized', fileId: 19711 + index,
  ed2k: file.ed2k, size: file.size,
  locations: [{ managedFolderId: 1, accessible: true,
    path: `${root}/${publishName}/${file.name}` }],
}));
const input = { handoff, attempt, request, detail,
  related: { state: 'related_titles', anidbId: 42, items: [] },
  observedFiles, shokoImportRoot: root };

test('each unrecognized episode in a pack gets its own exact Shoko link plan', () => {
  const result = planProvisionalShokoLinks(input);
  assert.equal(result.state, 'links_ready');
  assert.deepEqual(result.links.map((link) =>
    [link.fileId, link.episodeId, link.ownedPath]), [
    [19711, 1001, `${root}/${publishName}/Show/01.mkv`],
    [19712, 1002, `${root}/${publishName}/Show/02.mkv`],
  ]);
});

test('a wrong pack title or one unrelated Shoko file holds all link plans', () => {
  assert.notEqual(planProvisionalShokoLinks({ ...input,
    attempt: { ...attempt, candidateTitle: '[SubsPlease] Other - 01-02' } }).state,
  'links_ready');
  assert.notEqual(planProvisionalShokoLinks({ ...input,
    observedFiles: [observedFiles[0], { ...observedFiles[1],
      ed2k: 'C'.repeat(32) }] }).state, 'links_ready');
});

test('a missing AniDB detail holds a provisional plan even if an alias matches', () => {
  assert.deepEqual(planProvisionalShokoLinks({ ...input,
    detail: null, aliases: ['Example'] }),
  { state: 'held', reason: 'catalogue_title_unavailable' });
});

test('a file Shoko already matched needs no User link while its neighbour does', () => {
  const recognized = { ...observedFiles[0], state: 'imported_recognized',
    locations: [], release: { providerName: 'AniDB', isCorrupted: false,
      crossReferences: [{ animeId: 42, episodeId: 1001,
        start: 0, end: 100 }] } };
  const result = planProvisionalShokoLinks({ ...input,
    observedFiles: [recognized, observedFiles[1]] });
  assert.equal(result.state, 'links_ready');
  assert.deepEqual(result.links.map((link) => link.fileId), [19712]);
  assert.deepEqual(result.identifiedFileIds, [19711, 19712]);
  assert.equal(planProvisionalShokoLinks({ ...input,
    observedFiles: [{ ...recognized, release: { ...recognized.release,
      crossReferences: [{ animeId: 99, episodeId: 1001,
        start: 0, end: 100 }] } }, observedFiles[1]] }).state, 'held');
});

test('a combined episode file relies on Shoko recognition and never plans a guessed link', () => {
  const combinedEvidence = evaluateHandoffEvidence({ identity: 'provisional',
    anidbId: 42, torrentHash: 'a'.repeat(40), subtitles: [],
    files: [{ name: 'Show/01-02.mkv', size: 900,
      ed2k: 'A'.repeat(32), episodeIds: [1001, 1002] }] });
  const combinedName = `negev-7-${combinedEvidence.digest.slice(0, 16)}`;
  const combinedInput = { ...input,
    handoff: { status: 'published_observed', manifest: combinedEvidence.manifest,
      evidenceDigest: combinedEvidence.digest, publishName: combinedName },
    observedFiles: [{ ...observedFiles[0],
      locations: [{ managedFolderId: 1, accessible: true,
        path: `${root}/${combinedName}/Show/01-02.mkv` }] }] };
  assert.deepEqual(planProvisionalShokoLinks(combinedInput),
    { state: 'held', reason: 'shoko_native_match_pending' });
  const recognized = { ...combinedInput.observedFiles[0],
    state: 'imported_recognized', release: { providerName: 'Offline Importer',
      isCorrupted: false, crossReferences: [1001, 1002].map((episodeId) =>
        ({ animeId: 42, episodeId, start: 0, end: 100 })) } };
  assert.deepEqual(planProvisionalShokoLinks({ ...combinedInput,
    observedFiles: [recognized] }),
  { state: 'links_ready', links: [], identifiedFileIds: [19711] });
});
