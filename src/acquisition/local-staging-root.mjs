import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const held = () => ({ state: 'held', reason: 'staging_root_unverified' });
const canonical = (value) => typeof value === 'string' &&
  path.posix.isAbsolute(value) && value !== '/' &&
  path.posix.normalize(value) === value && !/[\\\0\r\n]/.test(value);
const within = (root, child) => child === root || child.startsWith(`${root}/`);
const overlap = (a, b) => within(a, b) || within(b, a);
const decode = (value) => value.replace(/\\([0-7]{3})/g,
  (_, digits) => String.fromCharCode(Number.parseInt(digits, 8)));

// A local filesystem gate for a configured shared staging volume. It proves
// Negev's own paths are present, canonical and backed by a writable mount.
// qBittorrent's save path is checked separately through its Web API; Docker
// socket access is neither needed nor granted to this service.
export async function verifyLocalStagingRoot({ stagingRoot, importRoot,
  holdingRoot, resolve = realpath, read = readFile } = {}) {
  if ([stagingRoot, importRoot, holdingRoot].some((value) => !canonical(value)) ||
      overlap(stagingRoot, importRoot) || overlap(stagingRoot, holdingRoot) ||
      overlap(importRoot, holdingRoot) ||
      typeof resolve !== 'function' || typeof read !== 'function') return held();
  try {
    const [staging, imported, holding, info] = await Promise.all([
      resolve(stagingRoot), resolve(importRoot), resolve(holdingRoot),
      read('/proc/self/mountinfo', 'utf8'),
    ]);
    if (staging !== stagingRoot || imported !== importRoot ||
        holding !== holdingRoot || typeof info !== 'string' ||
        info.length < 1 || info.length > 1_000_000) return held();
    const mounts = [];
    for (const line of info.trimEnd().split('\n')) {
      const halves = line.split(' - ');
      if (halves.length !== 2) return held();
      const left = halves[0].split(' ');
      const right = halves[1].split(' ');
      const point = decode(left[4] ?? '');
      if (!path.posix.isAbsolute(point) ||
          path.posix.normalize(point) !== point ||
          !['rw', 'ro'].some((mode) => left[5]?.split(',').includes(mode)) ||
          !right[0]) return held();
      mounts.push({ point, type: right[0],
        writable: left[5].split(',').includes('rw') });
    }
    const covering = mounts.filter(({ point }) =>
      point === '/' || within(point, stagingRoot)).sort((a, b) =>
      b.point.length - a.point.length)[0];
    return covering?.point !== '/' && covering?.writable &&
      !['overlay', 'tmpfs', 'ramfs'].includes(covering.type)
      ? { state: 'verified_staging_root' } : held();
  } catch { return held(); }
}
