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
const savePath = `/Downloads/negev/${hash}`;
const prepared = { state: 'prepared_stopped', expected: { hash, category: 'negev', savePath },
  form: buildStoppedTorrentAddForm({ torrentBytes: bytes, savePath, category: 'negev' }) };
const mount = (source, destination, rw = true) => ({ Type: 'bind', Source: source, Destination: destination, RW: rw });
const mounts = { qbittorrent: [mount(hostPath, '/Downloads/negev')],
  shoko: [mount('/srv/library', '/pure')], plex: [mount('/srv/library', '/source-pure', false)] };
const torrent = { hash, category: 'negev', save_path: savePath,
  state: 'stoppedDL', progress: 0, downloaded: 0, amount_left: 1000,
  auto_tmm: false, force_start: false };
const files = [{ index: 0, name: 'Example.mkv', size: 1000, priority: 1, progress: 0 }];
function encode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return encode(Buffer.from(value));
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'),
    ...value.map(encode), Buffer.from('e')]);
  const entries = Object.entries(value).sort(([a], [b]) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Buffer.concat([Buffer.from('d'), ...entries.flatMap(([key, item]) =>
    [encode(key), encode(item)]), Buffer.from('e')]);
}
const passiveInfo = { files: [{ length: 1000, path: ['Example.mkv'] },
  { length: 20, path: ['readme.nfo'] }], name: 'Release',
  'piece length': 16384, pieces: Buffer.alloc(20, 97) };
const passiveBytes = encode({ info: passiveInfo });
const passiveHash = createHash('sha1').update(encode(passiveInfo)).digest('hex');
const passiveSavePath = `/Downloads/negev/${passiveHash}`;
const passivePrepared = { state: 'prepared_stopped',
  expected: { hash: passiveHash, category: 'negev', savePath: passiveSavePath },
  form: buildStoppedTorrentAddForm({ torrentBytes: passiveBytes,
    savePath: passiveSavePath, category: 'negev' }) };
const passiveTorrent = { ...torrent, hash: passiveHash, save_path: passiveSavePath,
  amount_left: 1020 };
const unsafeInfo = { ...passiveInfo, files: [{ length: 1000,
  path: ['Example.mkv'] }, { length: 20, path: ['setup.exe'] }] };
const unsafeHash = createHash('sha1').update(encode(unsafeInfo)).digest('hex');
const unsafeSavePath = `/Downloads/negev/${unsafeHash}`;
const unsafePrepared = { state: 'prepared_stopped',
  expected: { hash: unsafeHash, category: 'negev', savePath: unsafeSavePath },
  form: buildStoppedTorrentAddForm({ torrentBytes: encode({ info: unsafeInfo }),
    savePath: unsafeSavePath, category: 'negev' }) };
const unsafeTorrent = { ...torrent, hash: unsafeHash, save_path: unsafeSavePath,
  amount_left: 1020 };

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

test('portable stopped add uses configured path and local root gate without Docker socket', async () =>
  withAttempt(async ({ ledger, attemptId }) => {
    const saveRoot = '/data/torrents/negev';
    const customPath = `${saveRoot}/${hash}`;
    const customPrepared = { state: 'prepared_stopped',
      expected: { hash, category: 'negev', savePath: customPath },
      form: buildStoppedTorrentAddForm({ torrentBytes: bytes,
        savePath: customPath, saveRoot, category: 'negev' }) };
    let guardCalls = 0;
    let seen = false;
    const result = await submitStoppedCandidate({ ...options, ledger, attemptId,
      prepared: customPrepared, saveRoot, inspectMounts: undefined,
      realpathImpl: undefined,
      verifyStagingRoot: async () => {
        guardCalls++;
        return { state: 'verified_staging_root' };
      },
      fetchImpl: async (url, init) => {
        const endpoint = new URL(url).pathname;
        if (endpoint === '/api/v2/app/version') return new Response('v5.3.0');
        if (endpoint.endsWith('/add')) {
          seen = true;
          assert.equal(init.body.get('savepath'), customPath);
          return new Response('Ok.');
        }
        if (!seen && endpoint.endsWith('/info')) return Response.json([]);
        return Response.json(endpoint.endsWith('/files') ? files :
          endpoint.endsWith('/properties')
            ? { save_path: customPath, download_path: '' } :
            [{ ...torrent, save_path: customPath }]);
      } });
    assert.equal(result.state, 'stopped_observed');
    assert.equal(guardCalls, 1);
  }));

test('holds before torrent add when qBittorrent cannot prove its stopped-add API version', async () =>
  withAttempt(async ({ ledger, attemptId }) => {
    for (const version of ['v4.6.7', 'v5.2.3', 'v5.4.0', 'v6.0.0', 'unknown']) {
      const calls = [];
      const result = await submitStoppedCandidate({ ...options, ledger, attemptId,
        fetchImpl: async (url) => {
          const endpoint = new URL(url).pathname;
          calls.push(endpoint);
          if (endpoint === '/api/v2/app/version') return new Response(version);
          return Response.json([]);
        },
      });
      assert.deepEqual(result, { state: 'held', reason: 'unsupported_qbittorrent_version' });
      assert.deepEqual(calls, ['/api/v2/app/version']);
      assert.equal(ledger.getAttempt(attemptId).status, 'reserved');
    }
  }));

test('one stopped add is durably recorded before POST and exact manifest is reconciled', async () =>
  withAttempt(async ({ ledger, attemptId }) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const endpoint = new URL(url).pathname;
      calls.push({ endpoint, method: init.method, status: ledger.getAttempt(attemptId).status });
      if (endpoint === '/api/v2/app/version') return new Response('v5.3.0');
      if (endpoint.endsWith('/add')) {
        assert.equal(init.body.get('stopped'), 'true');
        assert.equal(init.body.get('savepath'), savePath);
        assert.equal(ledger.getAttempt(attemptId).expectedHash, hash);
        return new Response('Ok.');
      }
      if (calls.filter((call) => call.endpoint.endsWith('/info')).length === 1) return Response.json([]);
      return Response.json(endpoint.endsWith('/files') ? files :
        endpoint.endsWith('/properties')
          ? { save_path: savePath, download_path: '' } : [torrent]);
    };
    const result = await submitStoppedCandidate({ ...options, ledger, attemptId, fetchImpl });
    assert.equal(result.state, 'stopped_observed');
    assert.equal(ledger.getAttempt(attemptId).torrentHash, hash);
    assert.deepEqual(calls.map(({ endpoint, method }) => [endpoint, method]), [
      ['/api/v2/app/version', 'GET'],
      ['/api/v2/torrents/info', 'GET'], ['/api/v2/torrents/add', 'POST'],
      ['/api/v2/torrents/info', 'GET'], ['/api/v2/torrents/properties', 'GET'],
      ['/api/v2/torrents/files', 'GET'], ['/api/v2/torrents/info', 'GET'],
      ['/api/v2/torrents/properties', 'GET'], ['/api/v2/torrents/files', 'GET'],
    ]);
    assert.equal(calls[2].status, 'dispatch_unknown');
    const again = await submitStoppedCandidate({ ...options, nowMs: 202, ledger, attemptId,
      fetchImpl: async (url, init) => {
        assert.equal(init.method, 'GET');
        const endpoint = new URL(url).pathname;
        return Response.json(endpoint.endsWith('/files') ? files :
          endpoint.endsWith('/properties')
            ? { save_path: savePath, download_path: '' } : [torrent]);
      } });
    assert.equal(again.state, 'stopped_observed');
  }));

test('mount exposure or altered torrent bytes hold before any downloader write', async () =>
  withAttempt(async ({ ledger, attemptId }) => {
    let calls = 0;
    let writes = 0;
    const fetchImpl = async (url, init) => {
      calls++;
      if (init.method !== 'GET') writes++;
      const endpoint = new URL(url).pathname;
      if (endpoint === '/api/v2/app/version') return new Response('v5.3.0');
      if (endpoint === '/api/v2/torrents/info') return Response.json([]);
      throw Error('unexpected downloader call');
    };
    assert.deepEqual(await submitStoppedCandidate({ ...options, ledger, attemptId,
      inspectMounts: async () => ({ ...mounts, plex: [mount('/srv', '/source', false)] }), fetchImpl }),
      { state: 'held', reason: 'staging_visible_to_plex' });
    assert.equal(writes, 0);
    assert.deepEqual(await submitStoppedCandidate({ ...options, ledger, attemptId,
      realpathImpl: async () => '/srv/other', fetchImpl }),
      { state: 'held', reason: 'staging_path_not_canonical' });
    assert.equal(writes, 0);
    const reads = calls;
    const altered = { ...prepared, expected: { ...prepared.expected, hash: 'b'.repeat(40) } };
    assert.deepEqual(await submitStoppedCandidate({ ...options, ledger, attemptId,
      prepared: altered, fetchImpl }), { state: 'held', reason: 'prepared_torrent_mismatch' });
    assert.equal(calls, reads);
    assert.equal(writes, 0);
  }));

test('mount exposure during qBittorrent preflight holds before stopped add', async () =>
  withAttempt(async ({ ledger, attemptId }) => {
    let exposed = false;
    let inspections = 0;
    let posts = 0;
    const result = await submitStoppedCandidate({ ...options, ledger, attemptId,
      inspectMounts: async () => {
        inspections++;
        return exposed ? { ...mounts,
          plex: [mount('/srv', '/source', false)] } : mounts;
      },
      fetchImpl: async (url, init) => {
        const endpoint = new URL(url).pathname;
        if (endpoint === '/api/v2/app/version') return new Response('v5.3.0');
        if (endpoint === '/api/v2/torrents/info') {
          exposed = true;
          return Response.json([]);
        }
        if (init.method === 'POST') posts++;
        throw Error('unexpected downloader call');
      },
    });
    assert.deepEqual(result, { state: 'held', reason: 'staging_visible_to_plex' });
    assert.equal(inspections, 1);
    assert.equal(posts, 0);
    assert.equal(ledger.getAttempt(attemptId).status, 'reserved');
  }));

test('uncertain POST response never triggers a second add', async () =>
  withAttempt(async ({ ledger, attemptId }) => {
    let posts = 0;
    const fetchImpl = async (url, init) => {
      const endpoint = new URL(url).pathname;
      if (endpoint === '/api/v2/app/version') return new Response('v5.3.0');
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

test('excludes only passive extras before accepting a pristine stopped torrent', async () =>
  withAttempt(async ({ ledger, attemptId }) => {
    let added = false;
    let excluded = false;
    const calls = [];
    const fetchImpl = async (url, init) => {
      const endpoint = new URL(url).pathname;
      calls.push([init.method, endpoint]);
      if (endpoint === '/api/v2/app/version') return new Response('v5.3.0');
      if (endpoint.endsWith('/add')) { added = true; return new Response('Ok.'); }
      if (endpoint.endsWith('/filePrio')) {
        assert.equal(added, true);
        assert.equal(init.body.get('hash'), passiveHash);
        assert.equal(init.body.get('id'), '1');
        assert.equal(init.body.get('priority'), '0');
        excluded = true;
        return new Response('Ok.');
      }
      if (!added) return Response.json([]);
      if (endpoint.endsWith('/properties')) return Response.json({
        save_path: passiveSavePath, download_path: '' });
      if (endpoint.endsWith('/files')) return Response.json([files[0], {
        index: 1, name: 'readme.nfo', size: 20,
        priority: excluded ? 0 : 1, progress: 0,
      }]);
      return Response.json([passiveTorrent]);
    };
    const result = await submitStoppedCandidate({ ...options,
      prepared: passivePrepared, ledger,
      attemptId, fetchImpl });
    assert.equal(result.state, 'stopped_observed');
    assert.equal(excluded, true);
    assert.equal(calls.filter(([method, endpoint]) =>
      method === 'POST' && endpoint.endsWith('/filePrio')).length, 1);
    assert.deepEqual(result.videos, [{ index: 0,
      name: 'Example.mkv', size: 1000 }]);
  }));

test('unsafe extra file never receives a priority write or torrent start', async () =>
  withAttempt(async ({ ledger, attemptId }) => {
    let added = false;
    let priorityWrites = 0;
    const fetchImpl = async (url) => {
      const endpoint = new URL(url).pathname;
      if (endpoint === '/api/v2/app/version') return new Response('v5.3.0');
      if (endpoint.endsWith('/add')) { added = true; return new Response('Ok.'); }
      if (endpoint.endsWith('/filePrio')) { priorityWrites++; return new Response('Ok.'); }
      if (!added) return Response.json([]);
      if (endpoint.endsWith('/properties')) return Response.json({
        save_path: unsafeSavePath, download_path: '' });
      if (endpoint.endsWith('/files')) return Response.json([files[0], {
        index: 1, name: 'setup.exe', size: 20, priority: 1, progress: 0,
      }]);
      return Response.json([unsafeTorrent]);
    };
    const result = await submitStoppedCandidate({ ...options,
      prepared: unsafePrepared, ledger,
      attemptId, fetchImpl });
    assert.deepEqual(result, { state: 'held', reason: 'unsafe_file' });
    assert.equal(priorityWrites, 0);
    assert.equal(ledger.getAttempt(attemptId).status, 'dispatch_unknown');
  }));
