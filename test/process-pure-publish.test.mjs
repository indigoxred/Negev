import assert from 'node:assert/strict';
import test from 'node:test';
import { processPurePublish } from '../src/acquisition/process-pure-publish.mjs';

const hash = 'a'.repeat(40);
const manifest = { attemptId: 7, torrentHash: hash,
  stagingRoot: `/handoff/staging/${hash}`,
  holdingPath: '/handoff/holding/negev-7-aaaaaaaaaaaaaaaa',
  files: [{ name: 'Show/01.mkv', size: 3, episodeIds: [1001],
    dev: '1', ino: '2', mtimeNs: '3' }] };

test('restart finishes a recorded partial move, then publishes once', async () => {
  const calls = [];
  let status = 'moving';
  const pureMoves = { getIntent: () => ({ status, manifest }),
    recordIntent: () => ({ state: 'recorded' }),
    markPrepared: () => { status = 'prepared'; return { state: 'prepared' }; } };
  const result = await processPurePublish({ attemptId: 7, nowMs: 100,
    pureMoves, stagingHostPath: '/handoff/staging',
    holdingRoot: '/handoff/holding', importRoot: '/handoff/source/Negev',
    prepare: async () => { calls.push('resume'); return { state: 'prepared' }; },
    publish: async () => { calls.push('publish');
      return { state: 'published_observed' }; } });
  assert.deepEqual(calls, ['resume', 'publish']);
  assert.deepEqual(result, { state: 'published_observed' });
});

test('a changed recorded manifest cannot resume or publish', async () => {
  const result = await processPurePublish({ attemptId: 7, nowMs: 100,
    pureMoves: { getIntent: () => ({ status: 'moving',
      manifest: { ...manifest, stagingRoot: '/other/path' } }) },
    stagingHostPath: '/handoff/staging',
    holdingRoot: '/handoff/holding', importRoot: '/handoff/source/Negev',
    prepare: async () => { throw Error('unexpected move'); },
    publish: async () => { throw Error('unexpected publish'); } });
  assert.deepEqual(result, { state: 'held', reason: 'move_intent_conflict' });
});

test('a consumed unknown publish records exact Shoko content without claiming publication', async () => {
  const calls = [];
  const pureMoves = { getIntent: () => ({ status: 'publish_unknown', manifest }),
    recordContentPresent: (input) => { calls.push(['content', input]);
      return { state: 'content_present', publicationProven: false }; } };
  const result = await processPurePublish({ attemptId: 7, nowMs: 100,
    pureMoves, stagingHostPath: '/handoff/staging',
    holdingRoot: '/handoff/holding', importRoot: '/handoff/source/Negev',
    target: { anidbId: 42, episodeIds: [1001] },
    shokoMount: { appRoot: '/pure', localRoot: '/pure' },
    readEpisode: async () => { calls.push('shoko'); return { state: 'not_imported' }; },
    publish: async () => { calls.push('publish');
      return { state: 'held', reason: 'published_tree_absent' }; },
    observe: async () => { calls.push('observe');
      return { state: 'shoko_files_identified', files: [
        { name: 'Show/01.mkv', fileId: 77, releaseEvidence: 'registered' }] }; } });
  assert.deepEqual(result, { state: 'held', reason: 'content_present_unattributed' });
  assert.deepEqual(calls.map((value) => Array.isArray(value) ? value[0] : value),
    ['publish', 'observe', 'content']);
  assert.equal(calls[2][1].attemptId, 7);
});
