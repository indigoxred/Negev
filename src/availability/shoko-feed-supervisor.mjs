// Keep the optional event feed independent of the account listener. SignalR's
// automatic reconnect does not retry an initial failed start or a terminal close.
export function createShokoFeedSupervisor({ connect, onGap,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof connect !== 'function' || typeof onGap !== 'function' ||
      typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('Invalid Shoko feed supervisor');
  }
  let timer;
  let inFlight;
  let feed;
  let started = false;
  let stopping = false;
  const gap = () => {
    try { onGap('feed_disconnected'); } catch { /* Retry remains scheduled. */ }
  };
  const schedule = (delay) => {
    if (stopping) return;
    timer = setTimer(() => {
      timer = undefined;
      inFlight = connectOnce().finally(() => { inFlight = undefined; });
      return inFlight;
    }, delay);
  };
  const connectOnce = async () => {
    try {
      const connected = await connect();
      if (typeof connected?.close !== 'function' ||
          typeof connected?.closed?.then !== 'function') {
        await connected?.close?.();
        throw new TypeError('Invalid Shoko feed lifecycle');
      }
      if (stopping) { await connected.close(); return; }
      feed = connected;
      void connected.closed.then(() => {
        if (stopping || feed !== connected) return;
        feed = undefined;
        gap();
        schedule(5 * 60_000);
      }, () => {
        if (stopping || feed !== connected) return;
        feed = undefined;
        gap();
        schedule(5 * 60_000);
      });
    } catch {
      if (!stopping) { gap(); schedule(5 * 60_000); }
    }
  };
  return {
    start() {
      if (started || stopping) return;
      started = true;
      schedule(0);
    },
    async close() {
      stopping = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      if (inFlight) await inFlight;
      if (feed) { const current = feed; feed = undefined; await current.close(); }
    },
  };
}
