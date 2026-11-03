import { readBoundedJson } from '../http/bounded-response.mjs';
import path from 'node:path';

const held = () => ({ state: 'held', reason: 'shoko_source_unverified' });
const canonicalDirectory = (value) => {
  if (typeof value !== 'string' || value.length > 4_096 ||
      !value.startsWith('/') || value.startsWith('//') ||
      value.endsWith('//') || /[\\\0\r\n]/.test(value)) return null;
  const directory = value.endsWith('/') ? value.slice(0, -1) : value;
  return directory !== '' && directory !== '/' &&
    path.posix.normalize(directory) === directory ? directory : null;
};

// Read Shoko's installed managed-folder record before enabling a handoff.
// This attests Shoko's configuration, not the other container's bind source.
export async function verifyShokoSourceFolder({ baseUrl, apiKey,
  folderId, shokoPath, fetchImpl = fetch } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { return held(); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.pathname !== '/' || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) ||
      !Number.isSafeInteger(folderId) || folderId < 1 ||
      !canonicalDirectory(shokoPath) ||
      typeof fetchImpl !== 'function') return held();
  try {
    const url = new URL(`/api/v3/ManagedFolder/${folderId}`, base);
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) return held();
    const folder = await readBoundedJson(response, 16_384);
    return folder?.ID === folderId &&
      canonicalDirectory(folder.Path) === canonicalDirectory(shokoPath) &&
      folder.DropFolderType === 'Source' && folder.WatchForNewFiles === true
      ? { state: 'verified_shoko_source' } : held();
  } catch { return held(); }
}
