import path from 'node:path';

const CONTAINER_PATH = '/negev-staging';
const held = (reason) => ({ state: 'held', reason });

function canonicalAbsolute(value) {
  return typeof value === 'string' && value.startsWith('/') &&
    !value.includes('\\') && !value.includes('\0') &&
    !value.split('/').includes('..') && !value.split('/').includes('.') &&
    path.posix.normalize(value) === value;
}

function overlaps(a, b) {
  return a === '/' || b === '/' || a === b ||
    a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// Evaluate fresh Docker inspect Mounts arrays for only the three relevant
// containers. This cannot establish that the host path has no symlink or that
// the mount map will remain unchanged; the runtime caller must check both.
export function evaluateStagingMountIsolation({ qbittorrent, shoko, plex } = {}, { hostPath } = {}) {
  if (!canonicalAbsolute(hostPath) || hostPath === '/') return held('invalid_staging_path');
  for (const [index, mounts] of [qbittorrent, shoko, plex].entries()) {
    if (!Array.isArray(mounts) || (index > 0 && mounts.length === 0) ||
        mounts.length > 100 ||
        mounts.some((mount) => !mount || !canonicalAbsolute(mount.Source) ||
          !canonicalAbsolute(mount.Destination) || typeof mount.Type !== 'string' ||
          typeof mount.RW !== 'boolean')) return held('invalid_mount_evidence');
  }
  const stagingBinds = qbittorrent.filter((mount) => mount.Destination === CONTAINER_PATH);
  if (stagingBinds.length === 0) return held('staging_bind_missing');
  if (stagingBinds.length !== 1 || stagingBinds[0].Type !== 'bind' ||
      stagingBinds[0].Source !== hostPath || !stagingBinds[0].RW) {
    return held('staging_bind_mismatch');
  }
  if (shoko.some((mount) => overlaps(hostPath, mount.Source))) {
    return held('staging_visible_to_shoko');
  }
  if (plex.some((mount) => overlaps(hostPath, mount.Source))) {
    return held('staging_visible_to_plex');
  }
  return { state: 'isolated_mount', hostPath, containerPath: CONTAINER_PATH };
}
