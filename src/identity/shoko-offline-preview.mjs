import { readBoundedJson } from '../http/bounded-response.mjs';

const providerId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A filename preview predicts an episode. It does not prove file bytes,
// import, or public Plex availability.
export async function previewOfflineRelease({ baseUrl, apiKey, filename,
  fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw new TypeError('Invalid Shoko offline preview configuration'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey ||
      typeof filename !== 'string' || !filename || filename.length > 255 ||
      /[\\/\x00-\x1f\x7f]/.test(filename) ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > 60_000) {
    throw new TypeError('Invalid Shoko offline preview configuration');
  }
  const options = () => ({ method: 'GET', redirect: 'manual',
    headers: { Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs) });
  try {
    const listing = await fetchImpl(new URL('/api/v3/ReleaseInfo/Provider',
      base), options());
    if (listing.status !== 200) return { status: 0 };
    const providers = await readBoundedJson(listing, 128_000);
    if (!Array.isArray(providers) || providers.length > 100) return { status: 0 };
    const enabled = providers.filter((item) =>
      item?.Name === 'Offline Importer' && item.IsEnabled === true &&
      providerId.test(item.ID));
    if (enabled.length !== 1) return { status: 0 };
    const url = new URL(`/api/v3/ReleaseInfo/Provider/${enabled[0].ID}` +
      '/Preview/By-Release', base);
    url.searchParams.set('id', `search://${filename}`);
    const response = await fetchImpl(url, options());
    if (response.status !== 200) return { status: response.status };
    return { status: 200,
      release: await readBoundedJson(response, 1_000_000) };
  } catch {
    // The caller never receives a URL, file name, or API key in an error.
    return { status: 0 };
  }
}
