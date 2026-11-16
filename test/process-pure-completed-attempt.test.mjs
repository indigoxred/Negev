import assert from 'node:assert/strict';
import test from 'node:test';
import { processPureCompletedAttempt } from
  '../src/acquisition/process-pure-completed-attempt.mjs';

const hash = 'a'.repeat(40);
const request = { id: 14, status: 'held', anidbId: 13262,
  episodeIds: [188804] };
const attempt = { id: 16, requestId: 14, status: 'torrent_observed',
  anidbId: 13262, torrentHash: hash, episodeIds: [188804] };
const inputs = {
  attemptId: 16, nowMs: 100,
  stagingHostPath: '/handoff/staging', qbitStagingRoot: '/NegevPure',
  holdingRoot: '/handoff/holding', importRoot: '/handoff/source/Negev',
  requests: { getRequest: () => request },
  acquisitions: { getAttempt: () => attempt,
    getStart: () => ({ torrentHash: hash }),
    getFilePlan: () => [{ name: 'Maquia.mkv', size: 3,
      episodeIds: [188804] }] },
  pureMoves: { getIntent: () => null,
    recordIntent: () => ({ state: 'recorded' }),
    markPrepared: () => ({ state: 'prepared' }) },
  qbittorrent: { baseUrl: 'http://qbit.internal:8080', sessionId: 'testSID' },
  verifyStagingRoot: async () => ({ state: 'verified_staging_root' }),
  verifyHandoffMounts: async () => ({ state: 'mounted_handoff_roots' }),
  inspectTracks: async () => ({ state: 'accepted', files: [{ name: 'Maquia.mkv',
    audio: 'japanese', resolution: 1080 }] }),
};

test('a stopped exact manifest becomes one prepared move without a video hash', async () => {
  const calls = [];
  const result = await processPureCompletedAttempt({ ...inputs,
    stop: async ({ expected }) => { calls.push(['stop', expected]);
      return { state: 'complete', files: [{ index: 0, name: 'Maquia.mkv', size: 3 }],
        subtitles: [] }; },
    prepare: async (input) => { calls.push(['prepare', input.files]);
      return { state: 'prepared', holdingPath: '/handoff/holding/negev-16-aaaaaaaaaaaaaaaa' }; },
  });
  assert.equal(result.state, 'handoff_prepared');
  assert.equal(calls[0][1].savePath, `/NegevPure/${hash}`);
  assert.deepEqual(calls[1][1], [{ name: 'Maquia.mkv', size: 3,
    episodeIds: [188804] }]);
});

test('passes selected adjacent subtitles to the media-track gate', async () => {
  let inspected;
  const result = await processPureCompletedAttempt({ ...inputs,
    stop: async () => ({ state: 'complete',
      files: [{ index: 0, name: 'Maquia.mkv', size: 3 }],
      subtitles: [{ index: 1, name: 'Maquia.en.srt', size: 20 }] }),
    inspectTracks: async (input) => { inspected = input;
      return { state: 'accepted', files: [{ name: 'Maquia.mkv' }] }; },
    prepare: async () => ({ state: 'prepared' }),
  });
  assert.equal(result.state, 'handoff_prepared');
  assert.deepEqual(inspected.subtitles,
    [{ index: 1, name: 'Maquia.en.srt', size: 20 }]);
});

test('a completed release lacking Japanese audio never enters the import move', async () => {
  let prepared = false;
  let retired = false;
  const result = await processPureCompletedAttempt({ ...inputs,
    acquisitions: { ...inputs.acquisitions,
      getMediaRetirementIntent: () => null,
      requestMediaRetirement: ({ reason }) => {
        assert.equal(reason, 'japanese_audio_missing');
        return { state: 'retirement_requested' };
      } },
    stop: async () => ({ state: 'complete',
      files: [{ index: 0, name: 'Maquia.mkv', size: 3 }], subtitles: [] }),
    inspectTracks: async () => ({ state: 'rejected',
      reason: 'japanese_audio_missing' }),
    retire: async () => { retired = true;
      return { state: 'retired_media' }; },
    prepare: async () => { prepared = true; },
  });
  assert.deepEqual(result, { state: 'held', reason: 'media_retired' });
  assert.equal(retired, true);
  assert.equal(prepared, false);
});

test('a mismatched selected manifest cannot prepare or publish', async () => {
  let prepared = false;
  const result = await processPureCompletedAttempt({ ...inputs,
    stop: async () => ({ state: 'complete',
      files: [{ index: 0, name: 'Wrong.mkv', size: 3 }], subtitles: [] }),
    prepare: async () => { prepared = true; },
  });
  assert.deepEqual(result, { state: 'held', reason: 'manifest_or_budget_mismatch' });
  assert.equal(prepared, false);
});

test('an already recorded handoff never stops or moves a torrent again', async () => {
  const result = await processPureCompletedAttempt({ ...inputs,
    pureMoves: { ...inputs.pureMoves, getIntent: () => ({ status: 'moving' }) },
    stop: async () => { throw Error('must not stop'); },
  });
  assert.deepEqual(result, { state: 'held', reason: 'handoff_already_recorded' });
});

test('completion forwards session renewal to the exact stop gate', async () => {
  const renewQbittorrent = async () => ({ state: 'authenticated',
    sessionId: 'newSID', fetchImpl: async () => ({ status: 200 }) });
  let forwarded = false;
  const result = await processPureCompletedAttempt({ ...inputs,
    renewQbittorrent,
    stop: async (input) => { forwarded = input.renewQbittorrent === renewQbittorrent;
      return { state: 'held', reason: 'provider_http_403' }; },
  });
  assert.equal(forwarded, true);
  assert.deepEqual(result, { state: 'held', reason: 'provider_http_403' });
});
