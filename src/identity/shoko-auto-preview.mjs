import { readBoundedJson } from '../http/bounded-response.mjs';

const unavailable = (reason) => ({ state: 'unavailable', reason });
const PROVIDER_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Shoko's AutoPreview endpoint runs enabled providers by default, or only the
// explicitly named providers. It does not save or replace the current release.
// A later writer must re-read the file.
export async function previewShokoImportedRelease({ baseUrl, apiKey, fileId,
  providerIds, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey ||
      !Number.isSafeInteger(fileId) || fileId < 1 ||
      (providerIds !== undefined && (!Array.isArray(providerIds) ||
        providerIds.length < 1 || providerIds.length > 5 ||
        providerIds.some((id) => typeof id !== 'string' ||
          !PROVIDER_ID.test(id)) ||
        new Set(providerIds.map((id) => id.toLowerCase())).size !==
          providerIds.length)) ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Shoko auto-preview request');
  }
  const url = new URL(`/api/v3/ReleaseInfo/File/${fileId}/AutoPreview`, base);
  if (providerIds !== undefined) {
    url.searchParams.set('strict', 'true');
    url.searchParams.set('providerIDs', providerIds.join(','));
  }
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs) });
  } catch { return unavailable('transport'); }
  if (response.status === 204) return { state: 'no_match' };
  if (response.status !== 200) return unavailable(`http_${response.status}`);
  let raw;
  try { raw = await readBoundedJson(response, 1_000_000); }
  catch { return unavailable('invalid_response'); }
  if (typeof raw?.ProviderName !== 'string' || !raw.ProviderName ||
      typeof raw.IsCorrupted !== 'boolean' ||
      !Array.isArray(raw.CrossReferences) ||
      raw.CrossReferences.length < 1 || raw.CrossReferences.length > 50 ||
      raw.CrossReferences.some((xref) =>
        !Number.isSafeInteger(xref?.AnidbAnimeID) || xref.AnidbAnimeID < 1 ||
        !Number.isSafeInteger(xref?.AnidbEpisodeID) || xref.AnidbEpisodeID < 1 ||
        !Number.isFinite(xref?.PercentageStart) ||
        !Number.isFinite(xref?.PercentageEnd) ||
        xref.PercentageStart < 0 || xref.PercentageEnd > 100 ||
        xref.PercentageStart >= xref.PercentageEnd)) {
    return unavailable('invalid_response');
  }
  return { state: 'match', release: {
    providerName: raw.ProviderName, isCorrupted: raw.IsCorrupted,
    crossReferences: raw.CrossReferences.map((xref) => ({
      animeId: xref.AnidbAnimeID, episodeId: xref.AnidbEpisodeID,
      start: xref.PercentageStart, end: xref.PercentageEnd,
    })),
  } };
}
