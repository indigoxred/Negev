import { setTimeout as sleep } from 'node:timers/promises';

// Episode coordinates here only request metadata; they never establish file identity.
export function observedReleaseEpisodes(titles = []) {
  if (!Array.isArray(titles) || titles.length > 32) return [];
  const numbers = new Set();
  for (const title of titles) {
    if (typeof title !== 'string' || title.length > 500 ||
        /\b(?:batch|complete)\b|\d{1,4}\s*[-–]\s*\d{1,4}/i.test(title)) continue;
    const matches = [...title.matchAll(/(?:S\d{1,2}E|\s[-–]\s)(0*[1-9]\d{0,3})(?:v\d+)?(?=\s|$|[.\[(])/gi)];
    const unique = new Set(matches.map(match => Number(match[1])));
    if (unique.size === 1) numbers.add([...unique][0]);
  }
  return [...numbers].slice(0,32);
}

// A feed notification adds no request and selects no torrent. The durable RSS
// and acquisition deadlines remain authoritative if this process restarts.
export function createReleaseWake({ wakeRequest, pollWatch,
  pause = (ms, signal) => sleep(ms, undefined, {signal}) } = {}) {
  if (typeof wakeRequest !== 'function' || typeof pollWatch !== 'function' || typeof pause !== 'function') {
    throw new TypeError('Invalid release wake providers');
  }
  const pending = new Map();
  const notices = new Map();
  const merge = (state, notification) => {
    const titles = Array.isArray(notification?.releaseTitles) ? notification.releaseTitles.slice(0,32) : [];
    for (const title of titles) {
      const number = observedReleaseEpisodes([title])[0];
      if (number !== undefined && !state.titles.has(number) && state.titles.size < 32) {
        state.titles.set(number,title); state.revision++;
      }
    }
  };
  const abort = new AbortController();
  let closed = false;
  const wake = (requestId, notification = {}) => {
    if (!Number.isSafeInteger(requestId) || requestId < 1) {
      throw new TypeError('Invalid release watch');
    }
    if (closed) return Promise.resolve();
    if (pending.has(requestId)) {
      merge(notices.get(requestId), notification);
      return pending.get(requestId);
    }
    wakeRequest(requestId);
    if (pending.size >= 32) return Promise.resolve();
    const notice = {titles:new Map(),revision:0};
    merge(notice, notification);
    notices.set(requestId,notice);
    const work = (async () => {
      let metadataRetries = 0;
      // At most32 new coordinates plus the initial read and two metadata retries.
      for (let pass = 0; pass < 35 && !closed; pass++) {
        const revision = notice.revision;
        let result;
        try { result = await pollWatch(requestId, {releaseTitles:[...notice.titles.values()]}); }
        catch { /* Acquisition still checks its independently recorded targets. */ }
        finally { if (!closed) wakeRequest(requestId); }
        if (notice.revision !== revision) continue;
        if (metadataRetries >= 2 || !result?.results?.some(row => row.reason === 'episode_metadata_pending')) break;
        metadataRetries++;
        try { await pause(60_000, abort.signal); } catch { break; }
      }
    })().finally(() => {pending.delete(requestId);notices.delete(requestId);});
    pending.set(requestId, work);
    return work;
  };
  wake.close = async () => {
    closed = true;
    abort.abort();
    await Promise.allSettled([...pending.values()]);
  };
  return wake;
}
