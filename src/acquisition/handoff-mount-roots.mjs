import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const held = () => ({ state: 'held', reason: 'handoff_mount_unavailable' });
const canonical = (value) => typeof value === 'string' &&
  path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
  !/[\\\0\r\n]/.test(value);
const within = (parent, child) => child === parent ||
  child.startsWith(parent === '/' ? '/' : `${parent}/`);
const decode = (value) => value.replace(/\\([0-7]{3})/g,
  (_, digits) => String.fromCharCode(Number.parseInt(digits, 8)));
const nonMediaTypes = new Set(['overlay', 'tmpfs', 'ramfs']);

// st_dev alone is insufficient: distinct bind mounts on one device cannot
// provide the same atomic rename, and a lost bind may expose Docker overlay.
export function evaluateHandoffMountInfo({ mountInfo, holdingRoot,
  importRoot } = {}) {
  if (typeof mountInfo !== 'string' || !mountInfo ||
      mountInfo.length > 1_000_000 || !canonical(holdingRoot) ||
      !canonical(importRoot)) return held();
  const entries = [];
  const ids = new Set();
  const points = new Set();
  for (const line of mountInfo.trimEnd().split('\n')) {
    const sides = line.split(' - ');
    if (sides.length !== 2) return held();
    const left = sides[0].split(' ');
    const right = sides[1].split(' ');
    const mountPoint = decode(left[4] ?? '');
    if (!/^[1-9]\d*$/.test(left[0] ?? '') || ids.has(left[0]) ||
        points.has(mountPoint) ||
        left.length < 6 || !canonical(mountPoint) ||
        !right[0]) return held();
    ids.add(left[0]);
    points.add(mountPoint);
    entries.push({ id: left[0], mountPoint, type: right[0] });
  }
  const covering = (target) => entries.filter((entry) =>
    within(entry.mountPoint, target)).sort((a, b) =>
    b.mountPoint.length - a.mountPoint.length)[0];
  const holding = covering(holdingRoot);
  const imported = covering(importRoot);
  return holding && imported && holding.id === imported.id &&
    holding.mountPoint !== '/' && !nonMediaTypes.has(holding.type)
    ? { state: 'mounted_handoff_roots' } : held();
}

export async function verifyHandoffMountRoots({ holdingRoot, importRoot,
  read = readFile, resolve = realpath } = {}) {
  if (typeof read !== 'function' || typeof resolve !== 'function' ||
      !canonical(holdingRoot) || !canonical(importRoot)) return held();
  try {
    const [holding, imported, mountInfo] = await Promise.all([
      resolve(holdingRoot), resolve(importRoot),
      read('/proc/self/mountinfo', 'utf8'),
    ]);
    return evaluateHandoffMountInfo({ mountInfo,
      holdingRoot: holding, importRoot: imported });
  } catch { return held(); }
}
