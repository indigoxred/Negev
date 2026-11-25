import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createUserService } from '../src/web/user-service.mjs';
import { openShokoRecentLedger } from '../src/availability/shoko-recent-ledger.mjs';
import { openShokoInventoryLedger } from '../src/availability/shoko-inventory-worker.mjs';
import { readShokoImportActivity } from '../src/availability/shoko-import-activity.mjs';

// This exercises the actual service, event consumer and full inventory worker.
// A missed hash in an unrelated folder must not permanently block intake 1/5;
// a configured unknown file must continue blocking after the same global scan.
for (const folderId of [1, 5, 9]) test(`folder ${folderId} missed-hash debt retains its intake scope`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-folder-scope-'));
  const dbPath = path.join(root, 'state.sqlite');
  const manual = path.join(root, 'manual'), automated = path.join(root, 'automated');
  let service;
  try {
    await mkdir(manual); await mkdir(automated);
    if (folderId !== 9) await writeFile(path.join(folderId === 1 ? manual : automated, 'old.mkv'), 'unexplained');
    const baseline = openShokoRecentLedger(dbPath);
    baseline.bootstrap({ fileId: 10, importedNs: String(BigInt(Date.parse('2026-10-31T00:00:10Z')) * 1000000n) }); baseline.close();
    const inventory = openShokoInventoryLedger(dbPath);
    inventory.recordFileObservation({ item: { fileId: 10, updated: '2026-10-31T00:00:10Z', state: 'linked', pairs: [{ anidbId: 42, episodeId: 1000 }] }, observedMs: 100 }); inventory.close();
    const file = { ID: 10, Imported: '2026-10-31T00:00:10Z', Updated: '2026-10-31T00:00:10Z', SeriesIDs: [{ SeriesID: { ID: 99, AniDB: 42 }, EpisodeIDs: [{ ID: 510, AniDB: 1000 }] }], Locations: [{ ManagedFolderID: 2, RelativePath: 'moved.mkv', IsAccessible: true }] };
    const options = { dbPath, shokoBaseUrl: 'http://shoko:8111/', shokoApiKey: 'synthetic', sessionKey: randomBytes(32), publicOrigin: 'http://localhost:3000', secureCookies: false, now: () => 1000, shokoRecent: true, shokoImportRoot: manual, shokoImportFolderId: 1, acquisitionImportParent: automated, acquisitionImportFolderId: 5, readShokoConnectionState: () => ({ state: 'connected' }), fetchImpl: async url => {
      if (url.pathname === '/api/v3/Queue') return Response.json({ WaitingCount: 0, BlockedCount: 0, ScheduledCount: 0, TotalCount: 0, CurrentlyExecuting: [], Pools: [] });
      if (/^\/api\/v3\/ManagedFolder\/[159]\/File$/.test(url.pathname)) return Response.json({ Total: 0, List: [] });
      if (url.pathname === '/api/v3/File') return Response.json({ Total: 1, List: [file] });
      throw Error('Unexpected route ' + url.pathname);
    } };
    service = await createUserService(options);
    service.acceptShokoEvent('file:detected', [{ ManagedFolderID: folderId, RelativePath: 'old.mkv' }]);
    await service.tickShokoRecentScan();
    assert.equal(service.getImportFeedState().state, 'unverified', 'recent catch-up cannot release unexplained detection');
    await service.tickShokoInventory();
    assert.equal(service.getImportFeedState().state, 'unverified', 'one global pass cannot release detection');
    await service.tickShokoInventory();
    await service.tickShokoInventory();
    assert.equal(service.getShokoArrivalState().pendingPaths, folderId === 9 ? 0 : 1);
    assert.equal(service.getImportFeedState().state, folderId === 9 ? 'connected' : 'unverified');
    if (folderId === 9) {
      assert.equal(service.getShokoArrivalState().unknownPendingPaths, 1, 'unknown evidence remains visible after global reconciliation');
      assert.equal(service.getShokoEventState().unknownPendingPaths, 1);
      // Real server startup supplies this feed-gap flag. A reopened database's
      // saved inventory cannot substitute for fresh full-pass proofs.
      await service.close();
      await writeFile(path.join(manual, 'old.mkv'), 'unexplained');
      service = await createUserService({ ...options, shokoImportFolderId: 9 });
      service.flagShokoReconciliation('feed_started');
      assert.equal(service.getImportFeedState().state, 'unverified');
      const sourceActivity = await readShokoImportActivity({ baseUrl: options.shokoBaseUrl,
        apiKey: options.shokoApiKey, importRoot: manual, managedFolderId: 9,
        fetchImpl: options.fetchImpl, withFingerprint: true });
      assert.equal(sourceActivity.state, 'busy', 'newly configured unexplained disk file prevents quiet even without replay');
      // Configuration changes apply on service restart. A newly configured
      // source's replayed detection becomes intake debt rather than a warning.
      service.acceptShokoEvent('file:detected', [{ ManagedFolderID: 9, RelativePath: 'old.mkv' }]);
      await service.tickShokoRecentScan();
      for (let pass = 0; pass < 3; pass++) await service.tickShokoInventory();
      assert.equal(service.getShokoArrivalState().pendingPaths, 1);
      assert.equal(service.getShokoArrivalState().unknownPendingPaths, 0);
      assert.equal(service.getImportFeedState().state, 'unverified');
      // Removing that source from intake retains replayed unknown evidence,
      // and still requires fresh global reconciliation before connected.
      await service.close();
      service = await createUserService(options);
      service.flagShokoReconciliation('feed_started');
      service.acceptShokoEvent('file:detected', [{ ManagedFolderID: 9, RelativePath: 'old.mkv' }]);
      assert.equal(service.getImportFeedState().state, 'unverified');
      await service.tickShokoInventory();
      assert.equal(service.getImportFeedState().state, 'unverified');
      for (let pass = 0; pass < 2; pass++) await service.tickShokoInventory();
      assert.equal(service.getImportFeedState().state, 'connected');
      assert.equal(service.getShokoArrivalState().unknownPendingPaths, 1);
    }
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }); }
});
