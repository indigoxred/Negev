import { setTimeout } from 'node:timers/promises';

// Cumulative pacing permits a single budget to span every file in a batch.
// It limits average read throughput; CPU cgroup limits are still needed live.
export function makeBytePacer({ bytesPerSecond, now = () => performance.now(),
  wait = (delay) => setTimeout(delay) }) {
  if (!Number.isSafeInteger(bytesPerSecond) || bytesPerSecond < 64 * 1024 ||
      bytesPerSecond > 1024 ** 3 || typeof now !== 'function' || typeof wait !== 'function') {
    throw new TypeError('Invalid byte pacing configuration');
  }
  const started = now();
  if (!Number.isFinite(started)) throw new TypeError('Invalid byte pacing clock');
  let total = 0;
  let tail = Promise.resolve();
  return {
    async afterBytes(count) {
      if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('Invalid paced byte count');
      const next = tail.then(async () => {
        total += count;
        if (!Number.isSafeInteger(total)) throw new TypeError('Byte pacing count overflow');
        const current = now();
        if (!Number.isFinite(current)) throw new TypeError('Invalid byte pacing clock');
        const elapsed = Math.max(0, current - started);
        const target = total / bytesPerSecond * 1000;
        await wait(Math.max(0, Math.ceil(target - elapsed)));
      });
      tail = next.catch(() => {});
      return next;
    },
  };
}
