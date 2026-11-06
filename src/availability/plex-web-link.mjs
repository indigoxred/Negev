import { readBoundedJson } from '../http/bounded-response.mjs';

const validMachineId = (value) => typeof value === 'string' &&
  /^[a-f0-9]{40}$/i.test(value);

// A single optional Plex root read. The token is used only in the request
// header; an unavailable server simply suppresses the consumer link.
export async function readPlexMachineIdentifier({ baseUrl, token,
  fetchImpl = fetch, timeoutMs = 5_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Plex URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.search || base.hash || base.pathname !== '/' ||
      typeof token !== 'string' || !token ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new TypeError('Invalid Plex identity reader');
  }
  try {
    const response = await fetchImpl(base, { method: 'GET',
      redirect: 'manual',
      headers: { 'X-Plex-Token': token, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return null;
    const id = (await readBoundedJson(response, 20_000))?.MediaContainer?.machineIdentifier;
    return validMachineId(id) ? id : null;
  } catch { return null; }
}

export function plexWebItemUrl({ machineId, ratingKey } = {}) {
  if (!validMachineId(machineId) || !Number.isSafeInteger(ratingKey) ||
      ratingKey < 1) return null;
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
  return `https://app.plex.tv/desktop/#!/server/${machineId}/details?key=${key}`;
}
