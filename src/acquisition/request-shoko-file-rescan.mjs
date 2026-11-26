import { cancelResponseBody } from '../http/bounded-response.mjs';
export async function requestShokoFileRescan({ baseUrl, apiKey, fileId,
  fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw new TypeError('Invalid Shoko rescan URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.pathname !== '/' || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) ||
      !Number.isSafeInteger(fileId) || fileId < 1 ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > 60_000) throw new TypeError('Invalid Shoko rescan');
  const url = new URL(`/api/v3/File/${fileId}/Rescan`, base);
  url.searchParams.set('priority', 'true');
  try {
    const response = await fetchImpl(url, { method: 'POST',
      redirect: 'manual', headers: {
        Authorization: `Bearer ${apiKey}`, Accept: 'application/json',
      }, signal: AbortSignal.timeout(timeoutMs) });
    await cancelResponseBody(response);
    return { state: response.status === 200 ? 'accepted' : 'unconfirmed' };
  } catch { return { state: 'unconfirmed' }; }
}
