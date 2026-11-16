import assert from 'node:assert/strict';
import test from 'node:test';
import { runMediaRetirement } from '../src/acquisition/run-media-retirement.mjs';

const hash = 'a'.repeat(40);
const root = '/handoff/staging';
const saveRoot = '/NegevPure';
const torrent = { hash, category: 'negev',
  save_path: `${saveRoot}/${hash}`,
  content_path: `${saveRoot}/${hash}/show.mkv`,
  auto_tmm: false, force_start: false,
  state: 'stoppedUP', progress: 1 };
const ledger = () => {
  let status = 'requested';
  let retired = false;
  return {
    getAttempt: () => ({ id: 1, status: retired ? 'retired_media' :
      'torrent_observed', expectedHash: hash, torrentHash: hash }),
    getMediaRetirementIntent: () => ({ hash, status,
      reason: 'japanese_audio_missing' }),
    beginMediaDelete: () => { const sendNow = status === 'requested';
      status = 'delete_unknown'; return { state: 'delete_unknown', sendNow }; },
    resetMediaDeleteAfterRejection: () => { status = 'requested';
      return { state: 'retirement_requested' }; },
    retireMedia: () => { retired = true; return { state: 'retired_media' }; },
  };
};
const lstatImpl = async () => ({ isDirectory: () => true,
  isSymbolicLink: () => false, dev: 1n, ino: 2n, mtimeNs: 3n });

test('removes only the exact completed Negev torrent and confirms absence', async () => {
  let present = true;
  let posts = 0;
  const fetchImpl = async (url, options) => {
    if (url.pathname.endsWith('/info')) return Response.json(present ?
      [torrent] : []);
    if (url.pathname.endsWith('/properties')) return Response.json({
      save_path: torrent.save_path, download_path: '' });
    assert.equal(options.body.get('hashes'), hash);
    assert.equal(options.body.get('deleteFiles'), 'true');
    posts++;
    present = false;
    return new Response('', { status: 200 });
  };
  const result = await runMediaRetirement({ ledger: ledger(), attemptId: 1,
    baseUrl: 'http://qbit.test:8080/', sessionId: 'testSID', stagingRoot: root,
    saveRoot, verifyStagingRoot: async () => ({ state: 'verified_staging_root' }),
    nowMs: 300, fetchImpl, lstatImpl,
    readdirImpl: async () => [] });
  assert.deepEqual(result, { state: 'retired_media' });
  assert.equal(posts, 1);
});

test('cannot delete another category', async () => {
  const current = ledger();
  let posts = 0;
  const fetchImpl = async (url) => {
    if (url.pathname.endsWith('/info')) return Response.json([{ ...torrent,
      category: 'sonarr' }]);
    if (url.pathname.endsWith('/properties')) return Response.json({
      save_path: torrent.save_path, download_path: '' });
    posts++;
    throw Error('unexpected delete');
  };
  const args = { ledger: current, attemptId: 1,
    baseUrl: 'http://qbit.test:8080/', sessionId: 'testSID', stagingRoot: root,
    saveRoot, verifyStagingRoot: async () => ({ state: 'verified_staging_root' }),
    nowMs: 300, fetchImpl, lstatImpl,
    readdirImpl: async () => [] };
  assert.deepEqual(await runMediaRetirement(args),
    { state: 'held', reason: 'torrent_ownership_changed' });
  assert.equal(posts, 0);
});

test('does not resend a delete after its response was lost', async () => {
  const current = ledger();
  let posts = 0;
  const fetchImpl = async (url) => {
    if (url.pathname.endsWith('/info')) return Response.json([torrent]);
    if (url.pathname.endsWith('/properties')) return Response.json({
      save_path: torrent.save_path, download_path: '' });
    posts++;
    throw Error('response lost');
  };
  const args = { ledger: current, attemptId: 1,
    baseUrl: 'http://qbit.test:8080/', sessionId: 'testSID', stagingRoot: root,
    saveRoot, verifyStagingRoot: async () => ({ state: 'verified_staging_root' }),
    nowMs: 300, fetchImpl, lstatImpl, readdirImpl: async () => [] };
  assert.deepEqual(await runMediaRetirement(args),
    { state: 'held', reason: 'torrent_still_present' });
  assert.deepEqual(await runMediaRetirement(args),
    { state: 'held', reason: 'torrent_still_present' });
  assert.equal(posts, 1);
});

test('renews a rejected qBittorrent read before deleting', async () => {
  let present = true;
  let renewals = 0;
  const fetchImpl = async (url, options) => {
    if (options.headers.Cookie === 'SID=oldSID') return new Response('',
      { status: 403 });
    if (url.pathname.endsWith('/info')) return Response.json(present ?
      [torrent] : []);
    if (url.pathname.endsWith('/properties')) return Response.json({
      save_path: torrent.save_path, download_path: '' });
    present = false;
    return new Response('', { status: 200 });
  };
  const result = await runMediaRetirement({ ledger: ledger(), attemptId: 1,
    baseUrl: 'http://qbit.test:8080/', sessionId: 'oldSID', stagingRoot: root,
    saveRoot, verifyStagingRoot: async () => ({ state: 'verified_staging_root' }),
    nowMs: 300, fetchImpl, lstatImpl, readdirImpl: async () => [],
    renewQbittorrent: async () => { renewals++;
      return { state: 'authenticated', sessionId: 'newSID', fetchImpl }; } });
  assert.deepEqual(result, { state: 'retired_media' });
  assert.equal(renewals, 1);
});

test('a definite delete 403 resets the intent for a renewed attempt', async () => {
  const current = ledger();
  let reset = false;
  current.resetMediaDeleteAfterRejection = () => { reset = true;
    return { state: 'retirement_requested' }; };
  const fetchImpl = async (url) => {
    if (url.pathname.endsWith('/info')) return Response.json([torrent]);
    if (url.pathname.endsWith('/properties')) return Response.json({
      save_path: torrent.save_path, download_path: '' });
    return new Response('', { status: 403 });
  };
  const result = await runMediaRetirement({ ledger: current, attemptId: 1,
    baseUrl: 'http://qbit.test:8080/', sessionId: 'testSID', stagingRoot: root,
    saveRoot, verifyStagingRoot: async () => ({ state: 'verified_staging_root' }),
    nowMs: 300, fetchImpl, lstatImpl, readdirImpl: async () => [] });
  assert.deepEqual(result, { state: 'held', reason: 'provider_http_403' });
  assert.equal(reset, true);
});
