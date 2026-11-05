export const validPosterUid = (value) => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export async function readShokoPoster({ baseUrl, apiKey, uid,
  fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (!validPosterUid(uid) || typeof apiKey !== 'string' || !apiKey ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid poster request');
  }
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash) throw new TypeError('Invalid Shoko base URL');
  try {
    const response = await fetchImpl(new URL(`/api/v3/Image/${uid}`, base), {
      method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'image/jpeg,image/png,image/webp' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return { state: 'unavailable' };
    const type = response.headers?.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
      return { state: 'unavailable' };
    }
    const maxBytes = 2_000_000;
    const declared = response.headers?.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      return { state: 'unavailable' };
    }
    if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
      return { state: 'unavailable' };
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxBytes) return { state: 'unavailable' };
      chunks.push(chunk);
    }
    return { state: 'image', type, bytes: Buffer.concat(chunks, total) };
  } catch { return { state: 'unavailable' }; }
}
