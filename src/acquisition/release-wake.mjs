// A feed notification adds no request and selects no torrent. The durable RSS
// and acquisition deadlines remain authoritative if this process restarts.
export function createReleaseWake({ wakeRequest, pollWatch } = {}) {
  if (typeof wakeRequest !== 'function' || typeof pollWatch !== 'function') {
    throw new TypeError('Invalid release wake providers');
  }
  const pending = new Map();
  return (requestId) => {
    if (!Number.isSafeInteger(requestId) || requestId < 1) {
      throw new TypeError('Invalid release watch');
    }
    if (pending.has(requestId)) return pending.get(requestId);
    wakeRequest(requestId);
    if (pending.size >= 32) return Promise.resolve();
    const work = (async () => {
      try { await pollWatch(requestId); }
      catch { /* Acquisition still checks its independently recorded targets. */ }
      finally { wakeRequest(requestId); }
    })().finally(() => pending.delete(requestId));
    pending.set(requestId, work);
    return work;
  };
}
