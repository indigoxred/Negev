import { readBoundedJson } from '../http/bounded-response.mjs';

const held = () => ({ state: 'held', reason: 'shoko_source_unverified' });
const validPath = (value) => typeof value === 'string' &&
  value.startsWith('/') && value !== '/' && !value.startsWith('//') &&
  !/[\\\0\r\n]/.test(value) &&
  value.split('/').slice(1).every((part) => part && part !== '.' && part !== '..');

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
      !validPath(shokoPath) || typeof fetchImpl !== 'function') return held();
  try {
    const url = new URL(`/api/v3/ManagedFolder/${folderId}`, base);
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) return held();
    const folder = await readBoundedJson(response, 16_384);
    return folder?.ID === folderId && folder.Path === shokoPath &&
      folder.DropFolderType === 'Source' && folder.WatchForNewFiles === true
      ? { state: 'verified_shoko_source' } : held();
  } catch { return held(); }
}
