import { readBoundedJson } from '../http/bounded-response.mjs';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => ({ state: 'unavailable' });

// Shoko 6's built-in hasher uses native RHash unless its managed hasher is
// forced. Native failures can still fall back per file, so only the forced
// managed setting proves an ED2K boundary mode for a future import.
export async function readShokoEd2kMode({ baseUrl, apiKey, fetchImpl = fetch,
  timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof apiKey !== 'string' || !apiKey || typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Shoko hash-mode configuration');
  }
  const get = async (pathname) => {
    const url = new URL(pathname, base);
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return null;
    return readBoundedJson(response, 100_000);
  };
  try {
    const providers = await get('/api/v3/Hashing/Provider');
    if (!Array.isArray(providers) || providers.length < 1 || providers.length > 20) {
      return unavailable();
    }
    const enabled = providers.filter((item) =>
      Array.isArray(item?.EnabledHashTypes) && item.EnabledHashTypes.includes('ED2K'));
    if (enabled.length !== 1 || enabled[0].Name !== 'Built-In Hasher' ||
        !GUID.test(enabled[0]?.Configuration?.ID)) return unavailable();
    const config = await get(`/api/v3/Configuration/${enabled[0].Configuration.ID}`);
    if (config?.AlwaysUseSharpHasher === true) {
      return { state: 'mode', mode: 'edonkey', basis: 'forced_sharp' };
    }
    // Native hashing is a preference: Shoko can fall back to C# for one file.
    // Its configured preference therefore cannot prove that file's ED2K mode.
    if (config?.AlwaysUseSharpHasher === false) return unavailable();
    return unavailable();
  } catch { return unavailable(); }
}
