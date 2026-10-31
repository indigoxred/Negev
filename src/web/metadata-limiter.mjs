// One instance-wide Shoko metadata operation at a time, without a backlog.
// Callers show a retryable busy state rather than letting many requests pile up.
export function createMetadataLimiter() {
  let active = false;
  return {
    async run(operation) {
      if (typeof operation !== 'function') throw new TypeError('Operation required');
      if (active) return { state: 'busy' };
      active = true;
      try { return await operation(); }
      finally { active = false; }
    },
  };
}
