import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';

// Windows can give rapid edits the same change timestamp. Establish the
// fixture's required transition by observing the filesystem, not by assuming
// one rewrite advances its clock or by relaxing the hashing assertions.
export async function mutateWithDistinctCtime({ before, mutate, readStat,
  timeoutMs = 2_000, now = () => performance.now(), wait = setImmediate }) {
  const deadline = now() + timeoutMs;
  while (true) {
    await mutate();
    const after = await readStat();
    if (after.ctimeNs !== before.ctimeNs) return after;
    if (now() >= deadline) {
      throw new Error('Fixture mutation did not produce a distinct ctime');
    }
    await wait();
  }
}
