import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { verifyHandoffMountRoots } from './handoff-mount-roots.mjs';

const held = () => ({ state: 'held', reason: 'import_child_unavailable' });
const canonical = (value) => typeof value === 'string' &&
  path.isAbsolute(value) && path.normalize(value) === value &&
  path.parse(value).root !== value && !/[\0\r\n]/.test(value);

// Shoko may remove an empty child inside its watched Import folder. Recreate
// only Negev's dedicated empty child, after proving the parent and holding
// root still resolve on the same explicit media mount. Never create a parent.
export async function ensureImportChild({ importRoot, holdingRoot,
  verifyHandoffMounts = verifyHandoffMountRoots,
  resolve = realpath, inspect = lstat, create = mkdir } = {}) {
  if (!canonical(importRoot) || !canonical(holdingRoot) ||
      path.basename(importRoot) !== 'Negev' ||
      typeof verifyHandoffMounts !== 'function' ||
      typeof resolve !== 'function' || typeof inspect !== 'function' ||
      typeof create !== 'function') return held();
  const parent = path.dirname(importRoot);
  if (!canonical(parent) || parent === holdingRoot ||
      importRoot.startsWith(`${holdingRoot}${path.sep}`) ||
      holdingRoot.startsWith(`${parent}${path.sep}`)) return held();
  try {
    if (await resolve(parent) !== parent ||
        (await verifyHandoffMounts({ holdingRoot,
          importRoot: parent }))?.state !== 'mounted_handoff_roots') return held();
    let child;
    try { child = await inspect(importRoot); }
    catch (error) {
      if (error?.code !== 'ENOENT') return held();
      try { await create(importRoot, { mode: 0o770 }); }
      catch (created) { if (created?.code !== 'EEXIST') return held(); }
      child = await inspect(importRoot);
    }
    if (!child.isDirectory() || child.isSymbolicLink() ||
        await resolve(parent) !== parent ||
        await resolve(importRoot) !== importRoot ||
        (await verifyHandoffMounts({ holdingRoot,
          importRoot }))?.state !== 'mounted_handoff_roots') return held();
    return { state: 'import_child_ready' };
  } catch { return held(); }
}
