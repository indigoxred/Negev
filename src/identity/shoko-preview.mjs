const PROVIDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ED2K = /^[0-9A-F]{32}$/;

// Read-only transport for the installed Shoko v6 AniDB release provider.
// The caller supplies a trusted internal base URL and an admin API key.
export async function previewAniDbRelease({
  baseUrl, providerId, apiKey, ed2k, size,
  fetchImpl = fetch, timeoutMs = 15_000,
}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko base URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || !PROVIDER_ID.test(providerId) ||
      !ED2K.test(ed2k) || !Number.isSafeInteger(size) || size <= 0 ||
      typeof apiKey !== 'string' || apiKey.length === 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Shoko preview configuration');
  }

  const url = new URL(`/api/v3/ReleaseInfo/Provider/${providerId}/Preview/By-Release`, base);
  url.searchParams.set('id', `anidb://${ed2k}+${size}`);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return { status: response.status };
    const body = await response.text();
    if (body.length > 1_000_000) return { status: 0 };
    return { status: 200, release: JSON.parse(body) };
  } catch {
    // Never include the URL or credential in an error returned to callers.
    return { status: 0 };
  }
}
