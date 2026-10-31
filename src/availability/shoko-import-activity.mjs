import { readBoundedJson } from '../http/bounded-response.mjs';

const unavailable = () => ({ state: 'unavailable' });
const count = (value) => Number.isSafeInteger(value) && value >= 0;

// A bounded, read-only indicator of queued Shoko work. Queue idleness does
// not prove that imports have settled or that an episode is absent. Avoid
// /api/v3/File here: Shoko filters its full file collection before paging.
export async function readShokoImportActivity({ baseUrl, apiKey,
  fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
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
    const queue = await read(new URL('/api/v3/Queue', base), 100_000);
    if (!queue || ![queue.WaitingCount, queue.BlockedCount,
      queue.ScheduledCount, queue.TotalCount].every(count) ||
      !Array.isArray(queue.CurrentlyExecuting) ||
      queue.CurrentlyExecuting.length > 1_000 || !Array.isArray(queue.Pools) ||
      queue.Pools.length > 100 || queue.Pools.some((pool) =>
        !count(pool?.ActiveWorkers)) ||
      queue.TotalCount !== queue.WaitingCount + queue.BlockedCount +
        queue.CurrentlyExecuting.length) return unavailable();
    if (queue.WaitingCount || queue.BlockedCount || queue.ScheduledCount ||
        queue.CurrentlyExecuting.length ||
        queue.Pools.some((pool) => pool.ActiveWorkers > 0)) return { state: 'busy' };
    return { state: 'queue_idle_unverified' };
  } catch { return unavailable(); }
}
