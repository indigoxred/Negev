import { DatabaseSync } from 'node:sqlite';
import { openStartQueue, createStartWorker } from '../src/acquisition/start-queue.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { startStoppedCandidate } from '../src/acquisition/start-stopped-candidate.mjs';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';

const hash = 'a'.repeat(40);
const candidate = { indexerId: 7, guid: 'synthetic-release' };
const expected = { hash, category: 'negev', savePath: `/Downloads/negev/${hash}` };
const hostPath = '/srv/negev/staging';
const bind = (source, destination) => ({ Type: 'bind', Source: source, Destination: destination, RW: true });
const mounts = { qbittorrent: [bind(hostPath, '/Downloads/negev')],
  shoko: [bind('/srv/library', '/pure')], plex: [bind('/srv/library', '/source-pure')] };
const torrent = { hash, category: 'negev', save_path: expected.savePath,
  state: 'stoppedDL', progress: 0, downloaded: 0, amount_left: 1000,
  auto_tmm: false, force_start: false };
const files = [{ index: 0, name: 'Example.mkv', size: 1000, priority: 1, progress: 0 }];

async function withObservedTorrent(run, { withPlan = true,
  evidencePolicy = 'strict', bonusFiles = [] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-start-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const request = requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false, episodeIds: [1001] } });
  let ledger = openAcquisitionLedger(dbPath);
  const attempt = ledger.reserve({ requestId: request.requestId, candidate,
    episodeIds: [1001], evidencePolicy, nowMs: 200 });
  ledger.bindPreparedTorrent({ attemptId: attempt.attemptId, candidate, hash, nowMs: 201 });
  if (withPlan) ledger.recordFilePlan({ attemptId: attempt.attemptId, hash,
    plannedFiles: [{ name: 'Example.mkv', size: 1000, episodeIds: [1001] }], nowMs: 201 });
  if(bonusFiles.length)ledger.recordBonusPlan({attemptId:attempt.attemptId,hash,files:bonusFiles,nowMs:201});
  ledger.beginDispatch({ attemptId: attempt.attemptId, nowMs: 202 });
  ledger.recordTorrent({ attemptId: attempt.attemptId, hash, nowMs: 203 });
  try { await run({ ledger, dbPath, requests, reopenAcquisitions:()=>{ledger.close();ledger=openAcquisitionLedger(dbPath);return ledger;}, attemptId: attempt.attemptId,
    readRequest: (id) => requests.getRequest(id) }); }
  finally { ledger.close(); requests.close(); await rm(dir, { recursive: true, force: true }); }
}

const options = { expected, hostPath, baseUrl: 'http://qbittorrent.internal:8080/',
  sessionId: 'syntheticSID', now: () => 204, inspectMounts: async () => mounts,
  realpathImpl: async () => hostPath, publicLibraryIds: [102],
  readEvidence: async () => ({ anidbId: 42, episodeIds: [1001],
    observedAtMs: 204, shoko: { state: 'ok', complete: true, files: [] },
    importFence: { state: 'settled', anidbId: 42, episodeIds: [1001],
      beforeObservedAtMs: 203, afterObservedAtMs: 204 },
    plex: { state: 'ok', complete: true, sourceVerified: true,
      libraryIds: [102], parts: [] } }) };

test('disabling the owner during the final mount check prevents the downloader start', async () =>
  withObservedTorrent(async ({ ledger, dbPath, attemptId, readRequest }) => {
    const accounts = openAccountLedger(dbPath);
    const owner = await accounts.bootstrapAdmin({ username: 'FixtureOwner', password: 'fixture-owner-password' });
    const db = new DatabaseSync(dbPath); let starts = 0;
    db.prepare('UPDATE requests SET requester_id=?').run(owner.id);
    try {
      const result = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest,
        inspectMounts: async () => { db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(owner.id); return mounts; },
        fetchImpl: async url => {
          const endpoint = new URL(url).pathname;
          if (endpoint.endsWith('/start')) { starts++; return new Response(''); }
          if (endpoint.endsWith('/properties')) return Response.json({ save_path: expected.savePath, download_path: '' });
          return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
        } });
      assert.deepEqual(result, { state: 'held', reason: 'account_access_changed' });
      assert.equal(starts, 0); assert.equal(ledger.getStart(attemptId), null);
    } finally { db.close(); accounts.close(); }
  }));

test('start rechecks Shoko video support before starting a saved torrent', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest, readVideoExtensions: async () =>
        ({ state: 'extensions', values: ['.mp4'] }),
      fetchImpl: async () => { throw new Error('qBittorrent must not be called'); } });
    assert.deepEqual(result, { state: 'held', reason: 'shoko_video_format_unsupported' });
    assert.equal(ledger.getStart(attemptId), null);
  }));

test('a stopped torrent for a separately listed sequel cannot start for the original', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let providerCalls = 0;
    const result = await startStoppedCandidate({ ...options,
      ledger: { ...ledger, getFilePlan: () => [{ name:
        'Harbor Journey - Quiet Cafe - 01.mkv', size: 1000, episodeIds: [1001] }] },
      attemptId,
      readRequest: async (id) => ({ ...readRequest(id), title: 'Harbor Journey' }),
      readRelatedTitles: async () => ({ state: 'related_titles', anidbId: 42,
        items: [{ anidbId: 43, title: 'Harbor Journey: Quiet Cafe', relation: 'Sequel' }] }),
      fetchImpl: async (url) => {
        providerCalls++;
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/files')) return Response.json([{
          ...files[0], name: 'Harbor Journey - Quiet Cafe - 01.mkv' }]);
        return Response.json([torrent]);
      },
    });
    assert.deepEqual(result, { state: 'held', reason: 'related_installment_mismatch' });
    assert.equal(providerCalls, 0);
  }));

test('related-title lookup failure holds the torrent before any provider call', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let providerCalls = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest: async (id) => ({ ...readRequest(id), title: 'Harbor Journey' }),
      readRelatedTitles: async () => ({ state: 'unavailable' }),
      fetchImpl: async () => { providerCalls++; throw Error('must not contact provider'); },
    });
    assert.deepEqual(result, { state: 'held', reason: 'related_title_unavailable' });
    assert.equal(providerCalls, 0);
  }));

test('portable start uses the configured path and local root gate without Docker socket', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    const saveRoot = '/data/torrents/negev';
    const custom = { ...expected, savePath: `${saveRoot}/${hash}` };
    let starts = 0;
    let checks = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest, expected: custom, saveRoot,
      inspectMounts: undefined, realpathImpl: undefined,
      verifyStagingRoot: async () => {
        checks++;
        return { state: 'verified_staging_root' };
      },
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { starts++; return new Response(''); }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: custom.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files :
          [{ ...torrent, save_path: custom.savePath }]);
      } });
    assert.equal(result.state, 'start_unknown');
    assert.equal(checks, 1);
    assert.equal(starts, 1);
  }));

test('a saved first-time uncertainty policy is rechecked before a stopped torrent starts', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let starts = 0;
    const result = await startStoppedCandidate({ ...options, ledger,
      attemptId, readRequest,
      readEvidence: async () => ({ anidbId: 42, episodeIds: [1001],
        observedAtMs: 204,
        shoko: { state: 'unimported_targets', anidbId: 42,
          episodeIds: [1001] },
        plex: { state: 'healthy_unconfirmed', libraryIds: [102],
          parts: [], complete: false, probeCoverage: 'health_only',
          sourceVerified: true },
        importFence: { state: 'settled', anidbId: 42,
          episodeIds: [1001], beforeObservedAtMs: 203,
          afterObservedAtMs: 204 } }),
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) {
          starts++;
          return new Response('');
        }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      },
    });
    assert.equal(result.state, 'start_unknown');
    assert.equal(starts, 1);
  }, { evidencePolicy: 'first_time_permissive' }));

test('starts only the exact safe stopped manifest once after durable intent', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let posts = 0;
    let reads = 0;
    let submitted;
    const fetchImpl = async (url, init) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith('/start')) {
        posts++;
        submitted = init;
        return new Response('');
      }
      assert.equal(init.method, 'GET');
      reads++;
      if (endpoint.endsWith('/properties')) return Response.json({
        save_path: expected.savePath, download_path: '',
      });
      return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
    };
    const first = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest, fetchImpl });
    assert.equal(first.state, 'start_unknown');
    assert.equal(first.sendNow, true);
    assert.equal(reads, 13);
    assert.equal(submitted.method, 'POST');
    assert.equal(submitted.body.toString(), `hashes=${hash}`);
    assert.equal(submitted.redirect, 'manual');
    assert.equal(submitted.headers.Cookie, 'SID=syntheticSID');
    const second = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest, fetchImpl,
      now: () => 205 });
    assert.equal(second.state, 'start_unknown');
    assert.equal(second.sendNow, false);
    assert.equal(posts, 1);
  }));

test('a slow final mount check cannot start from stale absence evidence', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let clock = 204;
    let posts = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest, now: () => clock,
      inspectMounts: async () => { clock = 30_205; return mounts; },
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { posts++; return new Response(''); }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      } });
    assert.deepEqual(result, { state: 'held', reason: 'availability_evidence_stale' });
    assert.equal(posts, 0);
  }));

test('the final start uses the original absence observation age', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let clock = 30_203;
    let posts = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest, now: () => clock,
      inspectMounts: async () => { clock = 30_205; return mounts; },
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { posts++; return new Response(''); }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      } });
    assert.deepEqual(result, { state: 'held', reason: 'availability_evidence_stale' });
    assert.equal(posts, 0);
  }));

test('unsafe manifest and visible staging hold before the start call', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let posts = 0;
    const fetchImpl = async (url) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith('/start')) { posts++; throw Error('unexpected start'); }
      return Response.json(endpoint.endsWith('/files')
        ? [{ ...files[0], name: 'run.exe' }] : [torrent]);
    };
    const unsafe = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest, fetchImpl });
    assert.equal(unsafe.state, 'held');
    assert.equal(posts, 0);
    const visible = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest,
      inspectMounts: async () => ({ ...mounts, shoko: [bind('/srv', '/pure')] }),
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { posts++; throw Error('unexpected start'); }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      } });
    assert.deepEqual(visible, { state: 'held', reason: 'staging_visible_to_shoko' });
    assert.equal(posts, 0);
  }));

test('a stopped torrent whose incomplete path escapes staging cannot start', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let posts = 0;
    const fetchImpl = async (url) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith('/start')) { posts++; throw Error('unexpected start'); }
      if (endpoint.endsWith('/properties')) return Response.json({
        save_path: expected.savePath, download_path: '/Shoko',
      });
      return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
    };
    const result = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest, fetchImpl });
    assert.deepEqual(result, { state: 'held', reason: 'incomplete_path_outside_staging' });
    assert.equal(posts, 0);
  }));

test('a download path changed during the availability probe blocks start', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let availabilityRead = false;
    let posts = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest,
      readEvidence: async () => {
        availabilityRead = true;
        return options.readEvidence();
      },
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { posts++; return new Response(''); }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath,
          download_path: availabilityRead ? '/Shoko' : '',
        });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      } });
    assert.deepEqual(result,
      { state: 'held', reason: 'manifest_changed_before_start' });
    assert.equal(posts, 0);
  }));

test('a final qBittorrent 403 is retryable and never records a start intent', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let availabilityRead = false;
    let starts = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest,
      readEvidence: async () => {
        availabilityRead = true;
        return options.readEvidence();
      },
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { starts++; return new Response(''); }
        if (availabilityRead) return new Response('', { status: 403 });
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      } });
    assert.deepEqual(result, { state: 'held', reason: 'provider_http_403' });
    assert.equal(ledger.getStart(attemptId), null);
    assert.equal(starts, 0);
  }));

test('a final qBittorrent 403 renews once, rechecks the stopped manifest, and starts with the new session', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let availabilityRead = false;
    let renewals = 0;
    let starts = 0;
    const provider = (renewed) => async (url, init = {}) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith('/start')) {
        starts++;
        assert.equal(init.headers.Cookie, 'SID=renewedSID');
        return new Response('Ok.');
      }
      if (availabilityRead && !renewed) return new Response('', { status: 403 });
      if (endpoint.endsWith('/properties')) return Response.json({
        save_path: expected.savePath, download_path: '' });
      return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
    };
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest,
      readEvidence: async () => { availabilityRead = true; return options.readEvidence(); },
      fetchImpl: provider(false),
      renewQbittorrent: async (sid) => {
        assert.equal(sid, 'syntheticSID');
        renewals++;
        return { state: 'authenticated', sessionId: 'renewedSID',
          fetchImpl: provider(true) };
      },
    });
    assert.deepEqual(result, { state: 'start_unknown', sendNow: true });
    assert.equal(renewals, 1);
    assert.equal(starts, 1);
    assert.ok(ledger.getStart(attemptId));
  }));

test('an initial qBittorrent 403 renews once before the first manifest check', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let renewals = 0;
    let starts = 0;
    const provider = (renewed) => async (url, init = {}) => {
      const endpoint = new URL(url).pathname;
      if (!renewed) return new Response('', { status: 403 });
      if (endpoint.endsWith('/start')) {
        starts++;
        assert.equal(init.headers.Cookie, 'SID=renewedSID');
        return new Response('Ok.');
      }
      if (endpoint.endsWith('/properties')) return Response.json({
        save_path: expected.savePath, download_path: '' });
      return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
    };
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest, fetchImpl: provider(false),
      renewQbittorrent: async (sid) => {
        assert.equal(sid, 'syntheticSID');
        renewals++;
        return { state: 'authenticated', sessionId: 'renewedSID',
          fetchImpl: provider(true) };
      },
    });
    assert.deepEqual(result, { state: 'start_unknown', sendNow: true });
    assert.equal(renewals, 1);
    assert.equal(starts, 1);
  }));

test('a session can be renewed once in each manifest phase across a long availability fence', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let availabilityRead = false;
    let renewals = 0;
    let starts = 0;
    const provider = (phase) => async (url, init = {}) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith('/start')) {
        starts++;
        assert.equal(init.headers.Cookie, 'SID=finalSID');
        return new Response('Ok.');
      }
      if (phase === 0 || (phase === 1 && availabilityRead)) {
        return new Response('', { status: 403 });
      }
      if (endpoint.endsWith('/properties')) return Response.json({
        save_path: expected.savePath, download_path: '' });
      return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
    };
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest,
      readEvidence: async () => { availabilityRead = true; return options.readEvidence(); },
      fetchImpl: provider(0),
      renewQbittorrent: async (sid) => {
        assert.equal(sid, renewals === 0 ? 'syntheticSID' : 'firstSID');
        renewals++;
        return { state: 'authenticated',
          sessionId: renewals === 1 ? 'firstSID' : 'finalSID',
          fetchImpl: provider(renewals) };
      },
    });
    assert.deepEqual(result, { state: 'start_unknown', sendNow: true });
    assert.equal(renewals, 2);
    assert.equal(starts, 1);
    assert.ok(ledger.getStart(attemptId));
  }));

test('a long availability fence refreshes the session before the final manifest without a 403', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let clock = 204;
    let renewals = 0;
    let starts = 0;
    const provider = async (url, init = {}) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith('/start')) {
        starts++;
        assert.equal(init.headers.Cookie, 'SID=freshSID');
        return new Response('Ok.');
      }
      if (endpoint.endsWith('/properties')) return Response.json({
        save_path: expected.savePath, download_path: '' });
      return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
    };
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest, now: () => clock,
      readEvidence: async () => {
        clock += 125_000;
        return { ...await options.readEvidence(), observedAtMs: clock,
          importFence: { state: 'settled', anidbId: 42,
            episodeIds: [1001], beforeObservedAtMs: clock - 1,
            afterObservedAtMs: clock } };
      },
      fetchImpl: provider,
      renewQbittorrent: async (sid) => {
        assert.equal(sid, 'syntheticSID');
        renewals++;
        return { state: 'authenticated', sessionId: 'freshSID',
          fetchImpl: provider };
      },
    });
    assert.deepEqual(result, { state: 'start_unknown', sendNow: true });
    assert.equal(renewals, 1);
    assert.equal(starts, 1);
  }));

test('failed final-session renewal leaves the torrent stopped without a start intent', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let availabilityRead = false;
    let starts = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest,
      readEvidence: async () => { availabilityRead = true; return options.readEvidence(); },
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { starts++; return new Response('Ok.'); }
        if (availabilityRead) return new Response('', { status: 403 });
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      },
      renewQbittorrent: async () => ({ state: 'held', reason: 'authentication_backoff' }),
    });
    assert.deepEqual(result, { state: 'held', reason: 'authentication_backoff' });
    assert.equal(starts, 0);
    assert.equal(ledger.getStart(attemptId), null);
  }));

test('a file priority changed during the availability probe blocks start', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let availabilityRead = false;
    let posts = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest,
      readEvidence: async () => {
        availabilityRead = true;
        return options.readEvidence();
      },
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { posts++; return new Response(''); }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        if (endpoint.endsWith('/files')) return Response.json(availabilityRead
          ? [{ ...files[0], priority: 0 }] : files);
        return Response.json([torrent]);
      } });
    assert.deepEqual(result, { state: 'held', reason: 'manifest_changed_before_start' });
    assert.equal(posts, 0);
  }));

test('a mount exposed to Shoko during the availability probe blocks start', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let availabilityRead = false;
    let mountReads = 0;
    let posts = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest,
      inspectMounts: async () => {
        mountReads++;
        return availabilityRead
          ? { ...mounts, shoko: [bind('/srv', '/pure')] } : mounts;
      },
      readEvidence: async () => {
        availabilityRead = true;
        return options.readEvidence();
      },
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { posts++; return new Response(''); }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      } });
    assert.deepEqual(result, { state: 'held', reason: 'staging_visible_to_shoko' });
    assert.equal(mountReads, 1);
    assert.equal(posts, 0);
  }));

test('a paced mount witness is read only once per start attempt', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let mountReads = 0;
    let posts = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest,
      inspectMounts: async () => {
        mountReads++;
        if (mountReads > 1) throw Error('witness rate limited');
        return mounts;
      },
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { posts++; return new Response(''); }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      } });
    assert.deepEqual(result, { state: 'start_unknown', sendNow: true });
    assert.equal(mountReads, 1);
    assert.equal(posts, 1);
  }));

test('a changed video filename or size cannot start against the saved plan', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    for (const altered of [{ ...files[0], name: 'Other.mkv' }, { ...files[0], size: 999 }]) {
      let posts = 0;
      const result = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest,
        fetchImpl: async (url) => {
          const endpoint = new URL(url).pathname;
          if (endpoint.endsWith('/start')) { posts++; throw Error('unexpected start'); }
          if (endpoint.endsWith('/properties')) return Response.json({
            save_path: expected.savePath, download_path: '',
          });
          return Response.json(endpoint.endsWith('/files') ? [altered] : [torrent]);
        } });
      assert.deepEqual(result, { state: 'held', reason: 'file_plan_mismatch' });
      assert.equal(posts, 0);
    }
  }));

test('an older observed torrent without a durable file plan cannot start', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let calls = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest,
      fetchImpl: async () => { calls++; throw Error('unexpected API call'); } });
    assert.deepEqual(result, { state: 'held', reason: 'file_plan_missing' });
    assert.equal(calls, 0);
  }, { withPlan: false }));

test('a lost start response remains unknown and cannot trigger a second POST', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let posts = 0;
    const fetchImpl = async (url) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith('/start')) { posts++; throw Error('response lost'); }
      if (endpoint.endsWith('/properties')) return Response.json({
        save_path: expected.savePath, download_path: '',
      });
      return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
    };
    assert.deepEqual(await startStoppedCandidate({ ...options, ledger, attemptId, readRequest, fetchImpl }),
      { state: 'start_unknown', sendNow: true });
    assert.deepEqual(await startStoppedCandidate({ ...options, ledger, attemptId, readRequest, fetchImpl,
      now: () => 205 }), { state: 'start_unknown', sendNow: false });
    assert.equal(posts, 1);
  }));

test('a newly playable manual import blocks the already reserved torrent start', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let posts = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest, readEvidence: async () => ({ anidbId: 42,
        episodeIds: [1001], observedAtMs: 204,
        shoko: { state: 'ok', complete: true, files: [{ fileId: 91,
          anidbId: 42, episodeIds: [1001], storageKey: 'same',
          coverage: [{ episodeId: 1001, start: 0, end: 100 }] }] },
        plex: { state: 'ok', complete: true,
          parts: [{ storageKey: 'same', libraryId: 102, readable: true }] } }),
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { posts++; return new Response(''); }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      } });
    assert.deepEqual(result, { state: 'held', reason: 'target_already_available',
      episodeId: 1001 });
    assert.equal(posts, 0);
  }));

test('a cancelled request blocks a reserved torrent before start', async () =>
  withObservedTorrent(async ({ ledger, attemptId }) => {
    let posts = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest: () => null,
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { posts++; return new Response(''); }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      } });
    assert.deepEqual(result, { state: 'held', reason: 'request_missing' });
    assert.equal(posts, 0);
  }));

test('cancellation during the final availability read still prevents start', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let reads = 0;
    let posts = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest: (id) => ++reads === 1 ? readRequest(id) : null,
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { posts++; return new Response(''); }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      } });
    assert.deepEqual(result, { state: 'held', reason: 'request_missing' });
    assert.equal(reads, 2);
    assert.equal(posts, 0);
  }));

test('a restarted stopped season starts once with independently journalled bonus files',async()=>{
 const bonus={name:'Extras/Example OVA 1.mkv',size:50,anidbId:43,episodeIds:[2001],kind:'ova',evidence:'shoko_filename_prediction'};
 await withObservedTorrent(async({ledger,attemptId,readRequest})=>{let starts=0;
 const result=await startStoppedCandidate({...options,ledger,attemptId,readRequest,readBonusOwnership:async()=>({state:'missing'}),fetchImpl:async(url)=>{const p=new URL(url).pathname;if(p.endsWith('/start')){starts++;return new Response('Ok.')}if(p.endsWith('/files'))return Response.json([...files,{index:1,name:bonus.name,size:50,priority:1,progress:0}]);if(p.endsWith('/properties'))return Response.json({save_path:expected.savePath,download_path:''});return Response.json([torrent]);}});
 assert.equal(result.state,'start_unknown',JSON.stringify(result));assert.equal(starts,1);assert.deepEqual(ledger.getAttempt(attemptId).episodeIds,[1001]);
 },{bonusFiles:[bonus]});
});

test('now-owned or uncertain bonuses are durably excluded before starting the main season',async()=>{for(const state of ['owned','uncertain']){const bonus={name:'Extras/Example OVA 1.mkv',size:50,anidbId:43,episodeIds:[2001],kind:'ova',evidence:'shoko_filename_prediction'};await withObservedTorrent(async({ledger,attemptId,readRequest})=>{let starts=0,priority=1;const result=await startStoppedCandidate({...options,ledger,attemptId,readRequest,readBonusOwnership:async()=>({state}),fetchImpl:async(url,init)=>{const p=new URL(url).pathname;if(p.endsWith('/start')){starts++;return new Response('Ok.')}if(p.endsWith('/filePrio')){assert.equal(init.body.get('id'),'1');priority=0;return new Response('Ok.')}if(p.endsWith('/files'))return Response.json([...files,{index:1,name:bonus.name,size:50,priority,progress:0}]);if(p.endsWith('/properties'))return Response.json({save_path:expected.savePath,download_path:''});return Response.json([torrent]);}});assert.equal(result.state,'start_unknown',JSON.stringify(result));assert.equal(starts,1);assert.equal(priority,0);assert.deepEqual(ledger.getBonusPlan(attemptId),[]);assert.deepEqual(ledger.getRecordedBonusPlan(attemptId).files,[]);assert.deepEqual(ledger.getFilePlan(attemptId),[{name:'Example.mkv',size:1000,episodeIds:[1001]}]);},{bonusFiles:[bonus]});}});

test('definitive start 403 renews and reruns all guards before one retry', async () => withObservedTorrent(async ({ledger,attemptId,readRequest})=>{
 let starts=0, renewals=0, proofs=0;
 const provider=async url=>{const endpoint=new URL(url).pathname;
  if(endpoint.endsWith('/start'))return new Response('',{status:++starts===1?403:200});
  if(endpoint.endsWith('/properties'))return Response.json({save_path:expected.savePath,download_path:''});
  return Response.json(endpoint.endsWith('/files')?files:[torrent]);};
 const result=await startStoppedCandidate({...options,ledger,attemptId,readRequest,fetchImpl:provider,
 readEvidence:async(...args)=>{proofs++;return options.readEvidence(...args);},
 renewQbittorrent:async()=>{renewals++;return {state:'authenticated',sessionId:'renewedSID',fetchImpl:provider};}});
 assert.equal(result.state,'start_unknown');assert.equal(starts,2);assert.equal(renewals,1);assert.equal(proofs,2);
}));

test('two definitive start rejections bound immediate retry and healthy auth later resumes the same attempt', async () => withObservedTorrent(async ({ledger,attemptId,readRequest,dbPath,reopenAcquisitions})=>{
 let starts=0,renewals=0,healthy=false;
 const provider=async url=>{const endpoint=new URL(url).pathname;
  if(endpoint.endsWith('/start')){starts++;return new Response('',{status:healthy?200:403});}
  if(endpoint.endsWith('/properties'))return Response.json({save_path:expected.savePath,download_path:''});
  return Response.json(endpoint.endsWith('/files')?files:[torrent]);};
 const run=ledger=>startStoppedCandidate({...options,ledger,attemptId,readRequest,fetchImpl:provider,renewQbittorrent:async()=>{renewals++;return {state:'authenticated',sessionId:'renewedSID',fetchImpl:provider};}});
 assert.deepEqual(await run(ledger),{state:'held',reason:'provider_http_403'});
 assert.equal(starts,2);assert.equal(renewals,1);assert.equal(ledger.getStart(attemptId),null);
 ledger=reopenAcquisitions();healthy=true;assert.equal((await run(ledger)).state,'start_unknown');
 assert.equal(starts,3);assert.equal(renewals,1);
 const db=new DatabaseSync(dbPath);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acquisition_start_rejections WHERE attempt_id=?').get(attemptId).n,2);}finally{db.close();}
}));

test('a rejected start with authentication outage stays retryable through the durable worker after reopen', async () => withObservedTorrent(async ({ledger,attemptId,readRequest,dbPath,reopenAcquisitions})=>{
 let starts=0,renewals=0,offline=true,clock=204;
 const provider=async url=>{const endpoint=new URL(url).pathname;
  if(endpoint.endsWith('/start')){starts++;return new Response('',{status:offline?403:200});}
  if(endpoint.endsWith('/properties'))return Response.json({save_path:expected.savePath,download_path:''});
  return Response.json(endpoint.endsWith('/files')?files:[torrent]);};
 let queue=openStartQueue(dbPath,{acquisitions:ledger});
 const processAttempt=()=>startStoppedCandidate({...options,now:()=>clock,ledger,attemptId,readRequest,fetchImpl:provider,readEvidence:async()=>{const e=await options.readEvidence();return {...e,observedAtMs:clock,importFence:{...e.importFence,beforeObservedAtMs:clock-1,afterObservedAtMs:clock}};},renewQbittorrent:async()=>{renewals++;return {state:'held',reason:'authentication_unavailable'};}});
 try{
  const worker=createStartWorker({queue,now:()=>clock,processAttempt});
  const rejected=await worker.runOnce();assert.equal(rejected.result.reason,'authentication_unavailable');assert.equal(ledger.getStart(attemptId),null);
  queue.close();ledger=reopenAcquisitions();queue=openStartQueue(dbPath,{acquisitions:ledger});clock+=60000;offline=false;
  assert.equal((await createStartWorker({queue,now:()=>clock,processAttempt}).runOnce()).result.state,'start_unknown');
  assert.equal(starts,2);assert.equal(renewals,1);
 }finally{queue.close();}
}));

test('a late rejection receipt cannot clear a newer uncertain send', async () => withObservedTorrent(async ({ledger,attemptId})=>{
 const first='11111111-1111-1111-1111-111111111111',second='22222222-2222-2222-2222-222222222222';const manifestDigest='b'.repeat(64);
 assert.equal(ledger.beginStart({attemptId,hash,manifestDigest,nowMs:204,sendToken:first}).sendNow,true);
 assert.equal(ledger.rejectStart({attemptId,hash,manifestDigest,nowMs:204,sendToken:first}).state,'start_rejected');
 assert.equal(ledger.beginStart({attemptId,hash,manifestDigest,nowMs:204,sendToken:second}).sendNow,true);
 assert.equal(ledger.rejectStart({attemptId,hash,manifestDigest,nowMs:204,sendToken:first}).reason,'start_intent_changed');
 assert.equal(ledger.getStart(attemptId).status,'start_unknown');
}));

test('a native HTTP disconnect stays one-send across old-schema upgrade, restart and concurrent workers', async () => withObservedTorrent(async ({ledger,attemptId,readRequest,dbPath,reopenAcquisitions})=>{
 const {createServer}=await import('node:http');let starts=0,release;
 const starting=new Promise(r=>release=r);
 const provider=createServer((req,res)=>{const endpoint=new URL(req.url,'http://localhost').pathname;
  if(endpoint.endsWith('/start')){starts++;release();req.socket.destroy();return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(endpoint.endsWith('/properties')?{save_path:expected.savePath,download_path:''}:endpoint.endsWith('/files')?files:[torrent]));});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 // Simulate a previous release database before any start was sent.
 const db=new DatabaseSync(dbPath);db.exec('ALTER TABLE acquisition_starts DROP COLUMN send_token');db.close();ledger=reopenAcquisitions();
 let queue=openStartQueue(dbPath,{acquisitions:ledger});const other=openStartQueue(dbPath,{acquisitions:ledger});
 const run=()=>startStoppedCandidate({...options,baseUrl:`http://127.0.0.1:${provider.address().port}/`,ledger,attemptId,readRequest});
 try{
  const worker=createStartWorker({queue,now:()=>204,processAttempt:run});const pending=worker.runOnce();await starting;
  assert.equal((await createStartWorker({queue:other,now:()=>204,processAttempt:run}).runOnce()).state,'idle');
  assert.equal((await pending).result.state,'start_unknown');queue.close();ledger=reopenAcquisitions();queue=openStartQueue(dbPath,{acquisitions:ledger});
  assert.equal((await createStartWorker({queue,now:()=>100000,processAttempt:run}).runOnce()).state,'idle');
  assert.equal((await run()).sendNow,false);assert.equal(starts,1);
 }finally{queue.close();other.close();provider.closeAllConnections();await new Promise(r=>provider.close(r));}
}));

test('authentication renewal cannot bypass a newly changed request guard', async () => withObservedTorrent(async ({ledger,attemptId,readRequest})=>{
 let starts=0,cancelled=false,proofs=0;
 const provider=async url=>{const endpoint=new URL(url).pathname;
  if(endpoint.endsWith('/start')){starts++;return new Response('',{status:403});}
  if(endpoint.endsWith('/properties'))return Response.json({save_path:expected.savePath,download_path:''});
  return Response.json(endpoint.endsWith('/files')?files:[torrent]);};
 const result=await startStoppedCandidate({...options,ledger,attemptId,readRequest:id=>cancelled?{...readRequest(id),status:'cancelled'}:readRequest(id),fetchImpl:provider,
 readEvidence:async()=>{proofs++;return options.readEvidence();},
 renewQbittorrent:async()=>{cancelled=true;return {state:'authenticated',sessionId:'renewedSID',fetchImpl:provider};}});
 assert.deepEqual(result,{state:'held',reason:'request_missing'});assert.equal(starts,1);assert.equal(proofs,1);assert.equal(ledger.getStart(attemptId),null);
}));

test('bonus priority response is disposed without blocking exact re-observation',async()=>{
 const bonus={name:'Extras/Example OVA 1.mkv',size:50,anidbId:43,episodeIds:[2001],kind:'ova',evidence:'shoko_filename_prediction'};
 await withObservedTorrent(async({ledger,attemptId,readRequest})=>{
  let cancelled=false,priority=1,finish;
  const result=await startStoppedCandidate({...options,ledger,attemptId,readRequest,readBonusOwnership:async()=>({state:'owned'}),fetchImpl:async(url)=>{
   const p=new URL(url).pathname;
   if(p.endsWith('/filePrio')){priority=0;return new Response(new ReadableStream({cancel(){cancelled=true;return new Promise(resolve=>finish=resolve)}}));}
   if(p.endsWith('/start'))return new Response('Ok.');
   if(p.endsWith('/files'))return Response.json([...files,{index:1,name:bonus.name,size:50,priority,progress:0}]);
   if(p.endsWith('/properties'))return Response.json({save_path:expected.savePath,download_path:''});
   return Response.json([torrent]);
  }});
  finish?.();assert.equal(cancelled,true);assert.equal(result.state,'start_unknown');
 },{bonusFiles:[bonus]});
});

test('fresh 18+ authorization prevents a new start without changing its saved torrent',async()=>withObservedTorrent(async({ledger,attemptId,readRequest})=>{
 let starts=0,checks=0;
 const result=await startStoppedCandidate({...options,ledger,attemptId,readRequest,
 authorizeRequest:async()=>{checks++;return {state:'held',reason:'adult_access_disabled'};},
 fetchImpl:async input=>{const endpoint=new URL(input).pathname;if(endpoint.endsWith('/start')){starts++;return new Response('');}if(endpoint.endsWith('/properties'))return Response.json({save_path:expected.savePath,download_path:''});return Response.json(endpoint.endsWith('/files')?files:[torrent]);}});
 assert.deepEqual(result,{state:'held',reason:'adult_access_disabled'});assert.equal(checks,1);assert.equal(starts,0);assert.equal(ledger.getStart(attemptId),null);
}));
test('a definitive rejected-start retry rechecks access before sending again',async()=>withObservedTorrent(async({ledger,attemptId,readRequest})=>{
 let starts=0,checks=0;
 const fetchImpl=async input=>{const endpoint=new URL(input).pathname;if(endpoint.endsWith('/start')){starts++;return new Response(null,{status:403});}if(endpoint.endsWith('/properties'))return Response.json({save_path:expected.savePath,download_path:''});return Response.json(endpoint.endsWith('/files')?files:[torrent]);};
 const result=await startStoppedCandidate({...options,ledger,attemptId,readRequest,fetchImpl,
 authorizeRequest:async()=>{checks++;return starts?{state:'held',reason:'adult_access_disabled'}:{state:'authorized',restricted:true};},
 renewQbittorrent:async()=>({state:'authenticated',sessionId:'renewedSID',fetchImpl})});
 assert.equal(result.reason,'adult_access_disabled');assert.equal(starts,1);assert.equal(checks,2);assert.equal(ledger.getStart(attemptId),null);
}));

test('slow 18+ classification cannot age the final absence proof past the start limit',async()=>withObservedTorrent(async({ledger,attemptId,readRequest})=>{
 let clock=204,starts=0;
 const result=await startStoppedCandidate({...options,ledger,attemptId,readRequest,now:()=>clock,
 authorizeRequest:async()=>{clock+=31000;return {state:'authorized',restricted:false};},
 fetchImpl:async input=>{const endpoint=new URL(input).pathname;if(endpoint.endsWith('/start')){starts++;return new Response('');}if(endpoint.endsWith('/properties'))return Response.json({save_path:expected.savePath,download_path:''});return Response.json(endpoint.endsWith('/files')?files:[torrent]);}});
 assert.equal(result.reason,'availability_evidence_stale');assert.equal(starts,0);assert.equal(ledger.getStart(attemptId),null);
}));
