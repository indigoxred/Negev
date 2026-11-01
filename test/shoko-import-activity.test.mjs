import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readShokoImportActivity } from '../src/availability/shoko-import-activity.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';

const input = { baseUrl: 'http://shoko.local/', apiKey: 'private-test-key' };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

test('idle queue does not trigger a full Shoko file-list read', async () => {
  const calls = [];
  const activity = await readShokoImportActivity({ ...input,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options.method,
        authorization: options.headers.Authorization });
      if (String(url).endsWith('/api/v3/Queue')) return json({
        WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
        TotalCount: 0, CurrentlyExecuting: [], Pools: [],
      });
      throw new Error('File endpoint must not be queried by an activity probe');
    },
  });
  assert.deepEqual(activity, { state: 'queue_idle_unverified' });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/api/v3/Queue');
  assert.ok(calls.every((call) => call.method === 'GET' &&
    call.authorization === 'Bearer private-test-key'));
});

test('idle and deferred-only queues never claim that imports are settled', async () => {
  const idle = await readShokoImportActivity({ ...input,
    fetchImpl: async (url) => String(url).endsWith('/api/v3/Queue')
      ? json({ WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
        TotalCount: 0, CurrentlyExecuting: [], Pools: [] })
      : Promise.reject(new Error('Unexpected file query')),
  });
  assert.deepEqual(idle, { state: 'queue_idle_unverified' });
  const deferred = await readShokoImportActivity({ ...input,
    fetchImpl: async (url) => String(url).endsWith('/api/v3/Queue')
      ? json({ WaitingCount: 0, BlockedCount: 0, ScheduledCount: 1,
        TotalCount: 0, CurrentlyExecuting: [], Pools: [] })
      : Promise.reject(new Error('Unexpected file query')),
  });
  assert.deepEqual(deferred, { state: 'scheduled_unverified' });
});

test('missing or inconsistent queue counts fail closed', async () => {
  for (const queue of [
    { WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
      TotalCount: 1, CurrentlyExecuting: [], Pools: [] },
    { WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
      TotalCount: 0, CurrentlyExecuting: null, Pools: [] },
  ]) {
    const result = await readShokoImportActivity({ ...input,
      fetchImpl: async (url) => String(url).endsWith('/api/v3/Queue')
        ? json(queue) : json({ Total: 0, List: [] }),
    });
    assert.deepEqual(result, { state: 'unavailable' });
  }
});

test('an early Import file reports busy even before Shoko schedules a queue job', async () => {
  const importRoot = await mkdtemp(path.join(tmpdir(), 'negev-import-activity-'));
  try {
    await writeFile(path.join(importRoot, 'new.mkv'), 'synthetic');
    let queueReads = 0;
    assert.deepEqual(await readShokoImportActivity({ ...input, importRoot,
      fetchImpl: async () => { queueReads++; throw new Error('not reached'); } }),
    { state: 'busy' });
    assert.equal(queueReads, 0);
  } finally { await rm(importRoot, { recursive: true, force: true }); }
});

test('a file arriving while the queue is read stays busy; empty plus idle is observed but not settled', async () => {
  const importRoot = await mkdtemp(path.join(tmpdir(), 'negev-import-activity-'));
  try {
    const idleQueue = { WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
      TotalCount: 0, CurrentlyExecuting: [], Pools: [] };
    assert.deepEqual(await readShokoImportActivity({ ...input, importRoot,
      fetchImpl: async () => json(idleQueue) }),
    { state: 'quiet_observed' });
    assert.deepEqual(await readShokoImportActivity({ ...input, importRoot,
      fetchImpl: async () => {
        await writeFile(path.join(importRoot, 'arrived.mkv'), 'synthetic');
        return json(idleQueue);
      } }), { state: 'busy' });
    assert.deepEqual(await readShokoImportActivity({ ...input,
      importRoot: path.join(importRoot, 'missing'),
      fetchImpl: async () => json(idleQueue) }), { state: 'unavailable' });
  } finally { await rm(importRoot, { recursive: true, force: true }); }
});

test('opt-in folder-scoped baseline does not treat an already recognized Import video as new work', async () => {
  const importRoot = await mkdtemp(path.join(tmpdir(), 'negev-import-activity-'));
  try {
    await writeFile(path.join(importRoot, 'known.mkv'), 'known');
    const calls = [];
    const result = await readShokoImportActivity({ ...input, importRoot,
      managedFolderId: 1,
      fetchImpl: async (url) => {
        calls.push(new URL(url).pathname);
        if (new URL(url).pathname === '/api/v3/Queue') return json({
          WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
          TotalCount: 0, CurrentlyExecuting: [], Pools: [],
        });
        return json({ Total: 1, List: [{ ID: 17, Size: 5,
          SeriesIDs: [{ ID: 42 }], Locations: [{ ManagedFolderID: 1,
            RelativePath: 'known.mkv', IsAccessible: true }] }] });
      },
    });
    assert.deepEqual(result, { state: 'quiet_observed' });
    assert.equal(calls.filter((item) =>
      item === '/api/v3/ManagedFolder/1/File').length, 2);
    assert.equal(calls.filter((item) => item === '/api/v3/Queue').length, 1);
  } finally { await rm(importRoot, { recursive: true, force: true }); }
});

test('folder-scoped activity identifies an unrecognized Import video without claiming its target', async () => {
  const importRoot = await mkdtemp(path.join(tmpdir(), 'negev-import-activity-'));
  try {
    await writeFile(path.join(importRoot, 'unrecognized.mkv'), 'video');
    const calls = [];
    const result = await readShokoImportActivity({ ...input, importRoot,
      managedFolderId: 1, fetchImpl: async (url) => {
        calls.push(new URL(url).pathname);
        return json({ Total: 0, List: [] });
      } });
    assert.deepEqual(result, { state: 'busy',
      reason: 'unrecognized_import_video' });
    assert.deepEqual(calls, ['/api/v3/ManagedFolder/1/File']);
  } finally { await rm(importRoot, { recursive: true, force: true }); }
});

test('an exact owned pending file does not block an unrelated target', async () => {
  const importRoot = await mkdtemp(path.join(tmpdir(), 'negev-import-activity-'));
  const evidence = evaluateHandoffEvidence({ anidbId: 42,
    torrentHash: 'b'.repeat(40), files: [{ name: '01.mkv', size: 5,
      ed2k: 'A'.repeat(32), anidbFileId: 801, episodeIds: [1001] }],
    subtitles: [] });
  const publishName = `negev-7-${evidence.digest.slice(0, 16)}`;
  const handoff = { status: 'published_observed', publishName,
    evidenceDigest: evidence.digest, manifest: evidence.manifest };
  try {
    await mkdir(path.join(importRoot, publishName));
    await writeFile(path.join(importRoot, publishName, '01.mkv'), 'video');
    const read = async (target) => readShokoImportActivity({ ...input,
      importRoot, managedFolderId: 1, target,
      getHandoff: (id) => id === 7 ? handoff : null,
      fetchImpl: async (url) => new URL(url).pathname === '/api/v3/Queue'
        ? json({ WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
          TotalCount: 0, CurrentlyExecuting: [], Pools: [] })
        : json({ Total: 1, List: [{ ID: 51, Size: 5, SeriesIDs: [],
          Hashes: [{ Type: 'ED2K', Value: 'A'.repeat(32) }],
          Locations: [{ ManagedFolderID: 1,
            RelativePath: `${publishName}/01.mkv`, IsAccessible: true }] }] }),
    });
    assert.deepEqual(await read({ anidbId: 43, episodeIds: [2001] }),
      { state: 'quiet_observed' });
    const scoped = await readShokoImportActivity({ ...input,
      importRoot, managedFolderId: 1, withFingerprint: true,
      target: { anidbId: 43, episodeIds: [2001] },
      getHandoff: (id) => id === 7 ? handoff : null,
      fetchImpl: async (url) => new URL(url).pathname === '/api/v3/Queue'
        ? json({ WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
          TotalCount: 0, CurrentlyExecuting: [], Pools: [] })
        : json({ Total: 1, List: [{ ID: 51, Size: 5, SeriesIDs: [],
          Hashes: [{ Type: 'ED2K', Value: 'A'.repeat(32) }],
          Locations: [{ ManagedFolderID: 1,
            RelativePath: `${publishName}/01.mkv`, IsAccessible: true }] }] }),
    });
    assert.deepEqual(scoped.unrelatedPendingKeys,
      [`1:${publishName}/01.mkv`]);
    assert.deepEqual(await read({ anidbId: 42, episodeIds: [1001] }),
      { state: 'busy', reason: 'target_pending_import' });
    await writeFile(path.join(importRoot, 'manual.mkv'), 'unknown');
    assert.deepEqual(await read({ anidbId: 43, episodeIds: [2001] }),
      { state: 'busy', reason: 'unrecognized_import_video' });
  } finally { await rm(importRoot, { recursive: true, force: true }); }
});

test('private folder-scoped quiet evidence returns only a fingerprint and timestamp', async () => {
  const importRoot = await mkdtemp(path.join(tmpdir(), 'negev-import-activity-'));
  try {
    const result = await readShokoImportActivity({ ...input, importRoot,
      managedFolderId: 1, withFingerprint: true, now: () => 123_000,
      fetchImpl: async (url) => new URL(url).pathname === '/api/v3/Queue'
        ? json({ WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
          TotalCount: 0, CurrentlyExecuting: [], Pools: [] })
        : json({ Total: 0, List: [] }),
    });
    assert.equal(result.state, 'quiet_observed');
    assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(result.observedAtMs, 123_000);
    assert.deepEqual(Object.keys(result).sort(),
      ['fingerprint', 'observedAtMs', 'state']);
  } finally { await rm(importRoot, { recursive: true, force: true }); }
  await assert.rejects(readShokoImportActivity({ ...input,
    withFingerprint: true }), TypeError);
});

test('opt-in baseline holds a file that appears during the queue read', async () => {
  const importRoot = await mkdtemp(path.join(tmpdir(), 'negev-import-activity-'));
  try {
    await writeFile(path.join(importRoot, 'known.mkv'), 'known');
    const result = await readShokoImportActivity({ ...input, importRoot,
      managedFolderId: 1,
      fetchImpl: async (url) => {
        if (new URL(url).pathname === '/api/v3/Queue') {
          await writeFile(path.join(importRoot, 'new.mkv'), 'new');
          return json({ WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
            TotalCount: 0, CurrentlyExecuting: [], Pools: [] });
        }
        return json({ Total: 1, List: [{ ID: 17, Size: 5,
          SeriesIDs: [{ ID: 42 }], Locations: [{ ManagedFolderID: 1,
            RelativePath: 'known.mkv', IsAccessible: true }] }] });
      },
    });
    assert.deepEqual(result, { state: 'busy',
      reason: 'unrecognized_import_video' });
  } finally { await rm(importRoot, { recursive: true, force: true }); }
});

test('opt-in activity brackets an inactive qBittorrent sidecar with exact hash reads', async () => {
  const importRoot = await mkdtemp(path.join(tmpdir(), 'negev-import-activity-'));
  const hash = 'a'.repeat(40);
  try {
    await writeFile(path.join(importRoot, `.${hash}.parts`), 'pieces');
    const seen = [];
    const result = await readShokoImportActivity({ ...input, importRoot,
      managedFolderId: 1, qbitImportSavePath: '/Shoko',
      now: () => Date.now() + 2 * 3_600_000,
      readSidecarTorrent: async (value) => {
        seen.push(value);
        return { hash, state: 'missingFiles', category: 'Direct',
          save_path: '/Shoko', progress: 0, dlspeed: 0, upspeed: 0,
          force_start: false, last_activity: 1_000 };
      },
      fetchImpl: async (url) => new URL(url).pathname === '/api/v3/Queue'
        ? json({ WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0,
          TotalCount: 0, CurrentlyExecuting: [], Pools: [] })
        : json({ Total: 0, List: [] }),
    });
    assert.deepEqual(result, { state: 'quiet_observed' });
    assert.deepEqual(seen, [hash, hash]);
  } finally { await rm(importRoot, { recursive: true, force: true }); }
});
