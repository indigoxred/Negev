import { readBoundedJson } from '../http/bounded-response.mjs';
import { readImportRootState } from './import-root-state.mjs';
import { readImportRootInventory } from './import-root-inventory.mjs';
import { classifyShokoImportBaseline } from './shoko-import-baseline.mjs';
import { partitionOwnedPendingImports } from
  './partition-owned-pending-imports.mjs';

const unavailable = () => ({ state: 'unavailable' });
const count = (value) => Number.isSafeInteger(value) && value >= 0;

// A bounded, read-only indicator of queued Shoko work and, when mounted,
// files still in Import. Even an empty root plus idle queue does not prove
// that imports settled or a target is absent. Avoid /api/v3/File here:
// Shoko filters its full file collection before paging.
export async function readShokoImportActivity({ baseUrl, apiKey,
  importRoot, managedFolderId, readSidecarTorrent, qbitImportSavePath,
  target, getHandoff,
  withFingerprint = false, now = Date.now, fetchImpl = fetch,
  timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.pathname !== '/' || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) ||
      (managedFolderId !== undefined &&
        (!Number.isSafeInteger(managedFolderId) || managedFolderId < 1 ||
         importRoot === undefined)) ||
      (readSidecarTorrent !== undefined &&
        (typeof readSidecarTorrent !== 'function' ||
         managedFolderId === undefined ||
         typeof qbitImportSavePath !== 'string' ||
         !qbitImportSavePath.startsWith('/'))) ||
      typeof withFingerprint !== 'boolean' ||
      (withFingerprint && (importRoot === undefined ||
        managedFolderId === undefined)) ||
      ((target !== undefined || getHandoff !== undefined) &&
        (managedFolderId === undefined ||
         typeof getHandoff !== 'function' ||
         !Number.isSafeInteger(target?.anidbId) || target.anidbId < 1 ||
         !Array.isArray(target.episodeIds) ||
         target.episodeIds.length < 1 || target.episodeIds.length > 50 ||
         target.episodeIds.some((id) => !Number.isSafeInteger(id) || id < 1))) ||
      typeof now !== 'function' ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Shoko activity configuration');
  }
  const read = async (url, maximumBytes) => {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs) });
    return response.status === 200 ? readBoundedJson(response, maximumBytes) : null;
  };
  try {
    const readRecognizedBaseline = async () => {
      const inventory = await readImportRootInventory({ root: importRoot });
      if (inventory.state !== 'inventory') return unavailable();
      if (inventory.files.length === 0) return inventory;
      const sidecarPaths = inventory.files.filter((file) =>
        /\.parts$/i.test(file.relativePath));
      if (sidecarPaths.length > 16) return { state: 'busy' };
      const sidecarTorrents = [];
      for (const file of sidecarPaths) {
        const hash = /^\.([0-9a-f]{40}|[0-9a-f]{64})\.parts$/i
          .exec(file.relativePath)?.[1];
        if (!hash || !readSidecarTorrent) return { state: 'busy' };
        sidecarTorrents.push({ relativePath: file.relativePath,
          torrent: await readSidecarTorrent(hash.toLowerCase()) });
      }
      const url = new URL(`/api/v3/ManagedFolder/${managedFolderId}/File`, base);
      url.searchParams.set('pageSize', '256');
      url.searchParams.set('include', 'XRefs');
      const page = await read(url, 2_000_000);
      if (!page) return unavailable();
      const attributed = target === undefined ? null :
        partitionOwnedPendingImports({ diskFiles: inventory.files,
          shokoPage: page, managedFolderId, getHandoff, target });
      if (attributed?.state === 'held') return { state: 'busy',
        reason: attributed.reason };
      const baseline = classifyShokoImportBaseline({
        diskFiles: attributed?.diskFiles ?? inventory.files,
        shokoPage: attributed?.shokoPage ?? page, managedFolderId, sidecarTorrents,
        qbitImportSavePath, nowMs: now() });
      return baseline.state === 'recognized_baseline' ? inventory :
        { state: 'busy', reason: baseline.reason };
    };
    let beforeInventory;
    if (importRoot !== undefined) {
      if (managedFolderId !== undefined) {
        beforeInventory = await readRecognizedBaseline();
        if (beforeInventory.state !== 'inventory') return beforeInventory;
      } else {
        const before = await readImportRootState({ root: importRoot });
        if (before.state === 'busy') return { state: 'busy' };
        if (before.state !== 'empty_observed') return unavailable();
      }
    }
    const queue = await read(new URL('/api/v3/Queue', base), 100_000);
    if (!queue || ![queue.WaitingCount, queue.BlockedCount,
      queue.ScheduledCount, queue.TotalCount].every(count) ||
      !Array.isArray(queue.CurrentlyExecuting) ||
      queue.CurrentlyExecuting.length > 1_000 || !Array.isArray(queue.Pools) ||
      queue.Pools.length > 100 || queue.Pools.some((pool) =>
        !count(pool?.ActiveWorkers)) ||
      queue.TotalCount !== queue.WaitingCount + queue.BlockedCount +
        queue.CurrentlyExecuting.length) return unavailable();
    if (queue.WaitingCount || queue.BlockedCount ||
        queue.CurrentlyExecuting.length ||
        queue.Pools.some((pool) => pool.ActiveWorkers > 0)) return { state: 'busy' };
    let quietFingerprint;
    if (importRoot !== undefined) {
      if (managedFolderId !== undefined) {
        const afterInventory = await readRecognizedBaseline();
        if (afterInventory.state !== 'inventory') return afterInventory;
        if (beforeInventory.fingerprint !== afterInventory.fingerprint) {
          return { state: 'busy' };
        }
        quietFingerprint = afterInventory.fingerprint;
      } else {
        const after = await readImportRootState({ root: importRoot });
        if (after.state === 'busy') return { state: 'busy' };
        if (after.state !== 'empty_observed') return unavailable();
      }
    }
    if (queue.ScheduledCount) return { state: 'scheduled_unverified' };
    // Both observations of a mounted Import root were empty or fully
    // accounted for, and the queue was idle between them. This is useful
    // triage, never an absence fence.
    if (withFingerprint) {
      const observedAtMs = now();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0 ||
          !/^[0-9a-f]{64}$/.test(quietFingerprint)) return unavailable();
      return { state: 'quiet_observed', fingerprint: quietFingerprint,
        observedAtMs };
    }
    return { state: importRoot === undefined
      ? 'queue_idle_unverified' : 'quiet_observed' };
  } catch { return unavailable(); }
}
