import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { buildStoppedTorrentAddForm } from '../src/acquisition/qbittorrent-add-form.mjs';
import { submitStoppedCandidate } from '../src/acquisition/submit-stopped-candidate.mjs';

const info = Buffer.from('d6:lengthi1000e4:name11:Example.mkv12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae');
const bytes = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
const hash = createHash('sha1').update(info).digest('hex');
const candidate = { indexerId: 7, guid: 'synthetic-release' };
const hostPath = '/srv/negev/staging';
const prepared = { state: 'prepared_stopped', expected: { hash, category: 'negev', savePath: '/negev-staging' },
  form: buildStoppedTorrentAddForm({ torrentBytes: bytes, savePath: '/negev-staging', category: 'negev' }) };
const mount = (source, destination, rw = true) => ({ Type: 'bind', Source: source, Destination: destination, RW: rw });
const mounts = { qbittorrent: [mount(hostPath, '/negev-staging')],
  shoko: [mount('/srv/library', '/pure')], plex: [mount('/srv/library', '/source-pure', false)] };
const torrent = { hash, category: 'negev', save_path: '/negev-staging',
  state: 'stoppedDL', progress: 0, downloaded: 0, amount_left: 1000,
  auto_tmm: false, force_start: false };
const files = [{ index: 0, name: 'Example.mkv', size: 1000, priority: 1, progress: 0 }];

async function withAttempt(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-submit-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const request = requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false, episodeIds: [1001] } });
  const ledger = openAcquisitionLedger(dbPath);
  const reserved = ledger.reserve({ requestId: request.requestId, candidate,
    episodeIds: [1001], nowMs: 200 });
  try { await run({ ledger, attemptId: reserved.attemptId }); }
  finally { ledger.close(); requests.close(); await rm(dir, { recursive: true, force: true }); }
}

const options = { candidate, prepared, hostPath, baseUrl: 'http://qbittorrent.internal:8080/',
  sessionId: 'syntheticSID', nowMs: 201,
  inspectMounts: async () => mounts, realpathImpl: async () => hostPath };

test('one stopped add is durably recorded before POST and exact manifest is reconciled', async () =>
  withAttempt(async ({ ledger, attemptId }) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const endpoint = new URL(url).pathname;
      calls.push({ endpoint, method: init.method, status: ledger.getAttempt(attemptId).status });
      if (endpoint.endsWith('/add')) {
        assert.equal(init.body.get('stopped'), 'true');
        assert.equal(init.body.get('savepath'), '/negev-staging');
        assert.equal(ledger.getAttempt(attemptId).expectedHash, hash);
        return new Response('Ok.');
      }
      if (calls.length === 1) return Response.json([]);
      return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
    };
    const result = await submitStoppedCandidate({ ...options, ledger, attemptId, fetchImpl });
    assert.equal(result.state, 'stopped_observed');
    assert.equal(ledger.getAttempt(attemptId).torrentHash, hash);
    assert.deepEqual(calls.map(({ endpoint, method }) => [endpoint, method]), [
      ['/api/v2/torrents/info', 'GET'], ['/api/v2/torrents/add', 'POST'],
      ['/api/v2/torrents/info', 'GET'], ['/api/v2/torrents/files', 'GET'],
      ['/api/v2/torrents/info', 'GET'], ['/api/v2/torrents/files', 'GET'],
    ]);
    assert.equal(calls[1].status, 'dispatch_unknown');
    const again = await submitStoppedCandidate({ ...options, nowMs: 202, ledger, attemptId,
      fetchImpl: async (url, init) => {
        assert.equal(init.method, 'GET');
        return Response.json(new URL(url).pathname.endsWith('/files') ? files : [torrent]);
      } });
    assert.equal(again.state, 'stopped_observed');
  }));

test('mount exposure or altered torrent bytes hold before any downloader call', async () =>
  withAttempt(async ({ ledger, attemptId }) => {
    let calls = 0;
    const fetchImpl = async () => { calls++; throw Error('unexpected call'); };
    assert.deepEqual(await submitStoppedCandidate({ ...options, ledger, attemptId,
      inspectMounts: async () => ({ ...mounts, plex: [mount('/srv', '/source', false)] }), fetchImpl }),
      { state: 'held', reason: 'staging_visible_to_plex' });
    assert.equal(calls, 0);
    assert.deepEqual(await submitStoppedCandidate({ ...options, ledger, attemptId,
      realpathImpl: async () => '/srv/other', fetchImpl }),
      { state: 'held', reason: 'staging_path_not_canonical' });
    assert.equal(calls, 0);
    const altered = { ...prepared, expected: { ...prepared.expected, hash: 'b'.repeat(40) } };
    assert.deepEqual(await submitStoppedCandidate({ ...options, ledger, attemptId,
      prepared: altered, fetchImpl }), { state: 'held', reason: 'prepared_torrent_mismatch' });
    assert.equal(calls, 0);
  }));

test('uncertain POST response never triggers a second add', async () =>
  withAttempt(async ({ ledger, attemptId }) => {
    let posts = 0;
    const fetchImpl = async (url, init) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith('/add')) { posts++; throw Error('connection lost'); }
      return Response.json([]);
    };
    const first = await submitStoppedCandidate({ ...options, ledger, attemptId, fetchImpl });
    assert.deepEqual(first, { state: 'held', reason: 'torrent_unavailable' });
    const again = await submitStoppedCandidate({ ...options, nowMs: 202, ledger, attemptId, fetchImpl });
    assert.deepEqual(again, { state: 'held', reason: 'torrent_unavailable' });
    assert.equal(posts, 1);
    assert.equal(ledger.getAttempt(attemptId).status, 'dispatch_unknown');
  }));
