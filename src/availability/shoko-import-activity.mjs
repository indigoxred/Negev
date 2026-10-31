import { readBoundedJson } from '../http/bounded-response.mjs';
import { readImportRootState } from './import-root-state.mjs';

const unavailable = () => ({ state: 'unavailable' });
const count = (value) => Number.isSafeInteger(value) && value >= 0;

// A bounded, read-only indicator of queued Shoko work and, when mounted,
// files still in Import. Even an empty root plus idle queue does not prove
// that imports settled or a target is absent. Avoid /api/v3/File here:
// Shoko filters its full file collection before paging.
export async function readShokoImportActivity({ baseUrl, apiKey,
  importRoot, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.pathname !== '/' || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) ||
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
    if (importRoot !== undefined) {
      const before = await readImportRootState({ root: importRoot });
      if (before.state === 'busy') return { state: 'busy' };
      if (before.state !== 'empty_observed') return unavailable();
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
    if (importRoot !== undefined) {
      const after = await readImportRootState({ root: importRoot });
      if (after.state === 'busy') return { state: 'busy' };
      if (after.state !== 'empty_observed') return unavailable();
    }
    return { state: queue.ScheduledCount
      ? 'scheduled_unverified' : 'queue_idle_unverified' };
  } catch { return unavailable(); }
}
