import test from 'node:test';
import assert from 'node:assert/strict';
import { planTorrentTargets } from '../src/acquisition/plan-torrent-targets.mjs';
import { createAcquisitionRequestProcessor } from '../src/acquisition/acquisition-request-processor.mjs';

const ids = Array.from({ length: 6 }, (_, i) => 1001 + i);
const request = { id: 4, anidbId: 42, kind: 'series', status: 'held', episodeIds: ids.slice(2) };
const detail = { state: 'details', complete: true, total: 6, anidbId: 42,
  kind: 'series', title: 'Example', restricted: false,
  episodes: ids.map((id, i) => ({ id, number: i + 1, type: 'Episode' })) };
const candidate = { indexerId: 7, guid: 'absolute', evidence: 'unverified',
  title: 'Example 25-30 1080p', size: 600, seeders: 10 };
const originalFiles = ids.map((_, i) => ({ name: `Example - ${25 + i}.mkv`, size: 100 }));
const mapped = planTorrentTargets({ request, detail,
  prepared: { state: 'prepared_stopped', files: originalFiles },
  releaseTitle: candidate.title, trustedTitle: detail.title });
const preview = { state: 'preflight', requestId: 4, anidbId: 42,
  torrentHash: 'a'.repeat(40), episodeIds: mapped.episodeIds, files: mapped.plannedFiles,
  filesToExclude: [...originalFiles.slice(0, 2), { name: 'Extras/Unknown.mkv', size: 10 }],
  mappingFiles: originalFiles };

for (const pinned of [false, true]) test(`absolute subset retains its full file context (${pinned ? 'pinned' : 'automatic'})`, async () => {
  let submits = 0;
  const process = createAcquisitionRequestProcessor({ readRequest: () => request, requireReleasePolicy: true,
    ...(pinned ? { readReleaseControl: () => ({ mode: 'manual', phase: 'chosen',
      revision: 1, selection: { candidate, preview } }), consumeReleaseChoice: () => true } : {}),
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4, anidbId: 42, items: [candidate] }),
    previewCandidate: async () => preview, loadDetail: async () => detail,
    submitCandidate: async input => { submits++;
      assert.deepEqual(input.episodeIds, ids.slice(2));
      assert.deepEqual(input.plannedFiles, mapped.plannedFiles);
      assert.equal(input.expectedHash, preview.torrentHash);
      return { state: 'stopped_observed', attemptId: 1 }; },
  });
  assert.equal((await process({ requestId: 4 })).state, 'stopped_observed');
  assert.equal(submits, 1);
});

test('a changed mapping cannot silently pin an automatic request ahead of a usable alternative', async () => {
  const relative = { ...candidate, guid: 'relative', title: 'Example 03-06 1080p' };
  const relativeFiles = ids.slice(2).map((id, i) => ({ name: `Example - 0${i + 3}.mkv`, size: 100, episodeIds: [id] }));
  let selected;
  const process = createAcquisitionRequestProcessor({ readRequest: () => request, requireReleasePolicy: true,
    discoverCandidates: async () => ({ state: 'candidates', requestId: 4, anidbId: 42, items: [candidate, relative] }),
    previewCandidate: async ({ candidate: c }) => c.guid === 'absolute'
      ? { ...preview, mappingFiles: undefined, filesToExclude: [] }
      : { ...preview, torrentHash: 'b'.repeat(40), files: relativeFiles, mappingFiles: undefined, filesToExclude: [] },
    loadDetail: async () => detail,
    submitCandidate: async input => { selected = input.candidate.guid; return { state: 'stopped_observed', attemptId: 2 }; },
  });
  let result, cursor = {};
  for (let pass = 1; pass <= 5; pass++) {
    result = await process({ requestId: 4, pass, ...cursor });
    if (result.state === 'stopped_observed') break;
    cursor = { candidateOffset: result.nextCandidateOffset ?? 0,
      candidateFingerprint: result.nextCandidateFingerprint ?? null };
  }
  assert.equal(result.state, 'stopped_observed');
  assert.equal(selected, 'relative');
});
