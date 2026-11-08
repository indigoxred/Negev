// One instance-wide Shoko metadata operation at a time. Critical import
// admission can reserve exactly one next turn; all other callers still fail
// busy instead of accumulating a NAS read backlog.
export function createMetadataLimiter() {
  let active = false;
  let reserved = null;
  const execute = async (operation) => {
    active = true;
    try { return await operation(); }
    finally {
      active = false;
      if (reserved && !reserved.granted) {
        reserved.granted = true;
        clearTimeout(reserved.timer);
        reserved.resolve(true);
      }
    }
  };
  return {
    async run(operation) {
      if (typeof operation !== 'function') throw new TypeError('Operation required');
      if (active || reserved) return { state: 'busy' };
      return execute(operation);
    },
    async runReserved(operation, waitMs = 10_000) {
      if (typeof operation !== 'function' || !Number.isSafeInteger(waitMs) ||
          waitMs < 1 || waitMs > 10_000) {
        throw new TypeError('Invalid reserved operation');
      }
      if (reserved) return { state: 'busy' };
      if (!active) return execute(operation);
      const granted = await new Promise((resolve) => {
        const holder = { granted: false, resolve, timer: null };
        holder.timer = setTimeout(() => {
          if (reserved !== holder || holder.granted) return;
          reserved = null;
          resolve(false);
        }, waitMs);
        reserved = holder;
      });
      if (!granted) return { state: 'busy' };
      reserved = null;
      return execute(operation);
    },
  };
}
