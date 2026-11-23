// Bound a large acquisition's read-only enrichment. Late results never become
// evidence and an expired budget cannot launch another provider request.
export function createReadDeadline(maxElapsedMs = 30_000) {
  if (!Number.isSafeInteger(maxElapsedMs) || maxElapsedMs < 1 || maxElapsedMs > 30_000) {
    throw new TypeError('Invalid acquisition read budget');
  }
  const deadline = performance.now() + maxElapsedMs;
  let expired = false;
  return {
    get expired() { return expired; },
    async read(callback) {
      const remaining = Math.ceil(deadline - performance.now());
      if (expired || remaining <= 0) { expired = true; return null; }
      let timer;
      const timeout = Symbol('deadline');
      try {
        const value = await Promise.race([Promise.resolve().then(callback),
          new Promise(resolve => { timer = setTimeout(() => resolve(timeout), remaining); })]);
        if (value === timeout || performance.now() >= deadline) { expired = true; return null; }
        return value;
      } finally { clearTimeout(timer); }
    },
  };
}
