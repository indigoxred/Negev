import { readBoundedJson } from '../http/bounded-response.mjs';

const ED2K = /^[0-9A-F]{32}$/;
const unavailable = (reason) => ({ state: 'unavailable', reason });

// Observe the exact bytes after Shoko has had an opportunity to import and
// recognize them. A release here is evidence to assess, not an instruction
// to overwrite it or a claim of public Plex availability.
export async function readShokoImportedFile({ baseUrl, apiKey, ed2k, size,
  fetchImpl = fetch, timeoutMs = 15_000 }) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey || !ED2K.test(ed2k) ||
      !Number.isSafeInteger(size) || size < 1 ||
      typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Shoko imported-file lookup');
  }
  const url = new URL('/api/v3/File/Hash/ED2K', base);
  url.searchParams.set('hash', ed2k);
  url.searchParams.set('size', String(size));
  url.searchParams.set('include', 'XRefs,ReleaseInfo');
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs) });
  } catch { return unavailable('transport'); }
  if (response.status === 404) return { state: 'not_imported' };
  if (response.status !== 200) return unavailable(`http_${response.status}`);
  let raw;
  try { raw = await readBoundedJson(response, 1_000_000); }
  catch { return unavailable('invalid_response'); }
  if (!Number.isSafeInteger(raw?.ID) || raw.ID < 1 || raw.Size !== size ||
      !Array.isArray(raw.Hashes) || !raw.Hashes.some((hash) =>
        hash?.Type === 'ED2K' && hash.Value === ed2k)) {
    return unavailable('invalid_response');
  }
  const identity = { fileId: raw.ID, ed2k, size };
  if (raw.Release === undefined || raw.Release === null) {
    return { state: 'imported_unrecognized', ...identity };
  }
  const release = raw.Release;
  if (typeof release.ProviderName !== 'string' || !release.ProviderName ||
      (release.ID !== undefined && release.ID !== null &&
        typeof release.ID !== 'string') ||
      typeof release.IsCorrupted !== 'boolean' ||
      !Array.isArray(release.CrossReferences) ||
      release.CrossReferences.length < 1 ||
      release.CrossReferences.length > 50 ||
      release.CrossReferences.some((xref) =>
        !Number.isSafeInteger(xref?.AnidbAnimeID) || xref.AnidbAnimeID < 1 ||
        !Number.isSafeInteger(xref?.AnidbEpisodeID) || xref.AnidbEpisodeID < 1 ||
        !Number.isFinite(xref?.PercentageStart) ||
        !Number.isFinite(xref?.PercentageEnd) ||
        xref.PercentageStart < 0 || xref.PercentageEnd > 100 ||
        xref.PercentageStart >= xref.PercentageEnd)) {
    return unavailable('invalid_response');
  }
  return { state: 'imported_recognized', ...identity,
    release: { providerName: release.ProviderName, id: release.ID ?? null,
      isCorrupted: release.IsCorrupted,
      crossReferences: release.CrossReferences.map((xref) => ({
        animeId: xref.AnidbAnimeID, episodeId: xref.AnidbEpisodeID,
        start: xref.PercentageStart, end: xref.PercentageEnd,
      })) } };
}
