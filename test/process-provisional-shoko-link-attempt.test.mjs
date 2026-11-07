import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { processProvisionalShokoLinkAttempt } from
  '../src/acquisition/process-provisional-shoko-link-attempt.mjs';

const evidence = evaluateHandoffEvidence({ identity: 'provisional',
  anidbId: 42, torrentHash: 'a'.repeat(40), subtitles: [],
  files: [{ name: '05.mkv', size: 900, ed2k: 'A'.repeat(32),
    episodeIds: [1005] }] });
const publishName = `negev-7-${evidence.digest.slice(0, 16)}`;
const handoff = { status: 'published_observed',
  manifest: evidence.manifest, evidenceDigest: evidence.digest, publishName };
const attempt = { id: 7, requestId: 1, status: 'torrent_observed',
  anidbId: 42, torrentHash: 'a'.repeat(40), episodeIds: [1005],
  candidateTitle: '[SubsPlease] Example - 05 (1080p)' };
const request = { id: 1, status: 'held', kind: 'series',
  anidbId: 42, episodeIds: [1005] };
const detail = { state: 'details', complete: true, total: 1,
  anidbId: 42, title: 'Example', kind: 'series', restricted: false,
  episodes: [{ id: 1005, number: 5, type: 'Episode', title: 'Five' }] };
const location = '/pure/Import/Negev/' + publishName + '/05.mkv';
const unrecognized = { state: 'imported_unrecognized', fileId: 19711,
  ed2k: 'A'.repeat(32), size: 900, importedAtMs: 1_000,
  locations: [{ managedFolderId: 1, path: location, accessible: true }] };
const recognized = { ...unrecognized, state: 'imported_recognized',
  release: { providerName: 'User', isCorrupted: false,
    crossReferences: [{ animeId: 42, episodeId: 1005,
      start: 0, end: 100 }] } };
const base = { attemptId: 7, shokoImportRoot: '/pure/Import/Negev',
  nowMs: 3_601_000,
  readHandoff: () => handoff, readAttempt: () => attempt,
  readRequest: () => request, loadDetail: async () => detail,
  readAliases: async () => [],
  readRelatedTitles: async () => ({ state: 'related_titles',
    anidbId: 42, items: [] }) };

test('worker links exact owned Shoko bytes, then observes identity without claiming Plex', async () => {
  let reads = 0;
  let writes = 0;
  const result = await processProvisionalShokoLinkAttempt({ ...base,
    allowUserLink: true,
    readImportedFile: async () => (++reads >= 4 ? recognized : unrecognized),
    previewRelease: async () => ({ state: 'no_match' }),
    saveRelease: async (fileId, body) => {
      writes++;
      assert.equal(fileId, 19711);
      assert.equal(body.CrossReferences[0].AnidbEpisodeID, 1005);
      return { state: 'saved' };
    } });
  assert.deepEqual(result, { state: 'shoko_files_identified', fileIds: [19711] });
  assert.equal(writes, 1);
});

test('holds a newly imported or undated file while Shoko may still match it', async () => {
  for (const observed of [
    { ...unrecognized, importedAtMs: 3_600_000 },
    { ...unrecognized, importedAtMs: undefined },
  ]) {
    let previews = 0, writes = 0;
    const result = await processProvisionalShokoLinkAttempt({ ...base,
      readImportedFile: async () => observed,
      previewRelease: async () => { previews++; return { state: 'no_match' }; },
      saveRelease: async () => { writes++; return { state: 'saved' }; } });
    assert.deepEqual(result, { state: 'held', reason: 'shoko_native_match_pending' });
    assert.equal(previews, 0);
    assert.equal(writes, 0);
  }
});

test('an older unrecognized file does not receive a synthesized User link by default', async () => {
  let writes = 0;
  const result = await processProvisionalShokoLinkAttempt({ ...base,
    readImportedFile: async () => unrecognized,
    previewRelease: async () => ({ state: 'no_match' }),
    saveRelease: async () => { writes++; return { state: 'saved' }; } });
  assert.deepEqual(result, { state: 'held', reason: 'shoko_fallback_pending' });
  assert.equal(writes, 0);
});

test('a later exact Shoko provider match advances the held file without a Negev link write', async () => {
  let current = unrecognized;
  let writes = 0;
  const providers = { ...base,
    readImportedFile: async () => current,
    previewRelease: async () => ({ state: 'no_match' }),
    saveRelease: async () => { writes++; return { state: 'saved' }; } };
  assert.deepEqual(await processProvisionalShokoLinkAttempt(providers),
    { state: 'held', reason: 'shoko_fallback_pending' });
  current = { ...recognized, release: { ...recognized.release,
    providerName: 'Offline Importer' } };
  assert.deepEqual(await processProvisionalShokoLinkAttempt(providers),
    { state: 'shoko_files_identified', fileIds: [19711] });
  assert.equal(writes, 0);
});

test('wrong saved release title or Shoko file does not save a link', async () => {
  for (const changed of [
    { readAttempt: () => ({ ...attempt,
      candidateTitle: '[SubsPlease] Other - 05' }) },
    { readImportedFile: async () => ({ ...unrecognized,
      ed2k: 'B'.repeat(32) }) },
  ]) {
    let writes = 0;
    const result = await processProvisionalShokoLinkAttempt({ ...base,
      readImportedFile: async () => unrecognized, ...changed,
      previewRelease: async () => ({ state: 'no_match' }),
      saveRelease: async () => { writes++; return { state: 'saved' }; } });
    assert.equal(result.state, 'held');
    assert.equal(writes, 0);
  }
});
