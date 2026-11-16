import path from 'node:path';
import { readBoundedJson } from '../http/bounded-response.mjs';

export async function readShokoVideoExtensions({ baseUrl, apiKey,
  fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko settings URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || typeof apiKey !== 'string' || !apiKey ||
      typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Shoko settings request');
  }
  try {
    const response = await fetchImpl(new URL('/api/v3/Settings', base), {
      method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return { state: 'unavailable' };
    const settings = await readBoundedJson(response, 1_000_000);
    const values = settings?.Import?.VideoExtensions;
    if (!Array.isArray(values) || values.length < 1 || values.length > 100 ||
        values.some((value) => typeof value !== 'string' ||
          !/^\.[a-z0-9]{1,12}$/i.test(value))) return { state: 'unavailable' };
    return { state: 'extensions', values: [...new Set(values.map((v) =>
      v.toLowerCase()))] };
  } catch { return { state: 'unavailable' }; }
}

export function acceptsShokoVideo(name, result) {
  return typeof name === 'string' && result?.state === 'extensions' &&
    Array.isArray(result.values) && result.values.includes(
      path.posix.extname(name).toLowerCase());
}
