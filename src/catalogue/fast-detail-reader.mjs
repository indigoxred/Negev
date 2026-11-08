// Prefer exact AniDB episode IDs from the public snapshot for a first-time
// title. Shoko remains the fallback and the sole authority for imported files.
export function createFastDetailReader({ archive, shoko, prefer = 'archive' }) {
  if (typeof archive !== 'function' || typeof shoko !== 'function' ||
      !['archive', 'shoko'].includes(prefer)) {
    throw new TypeError('Invalid fast detail reader');
  }
  const first = prefer === 'archive' ? archive : shoko;
  const fallback = prefer === 'archive' ? shoko : archive;
  return async (input) => {
    let result;
    try { result = await first(input); }
    catch { /* The other source can still have the catalogue page. */ }
    if (result?.state === 'details' && result.anidbId === input?.anidbId &&
        result.page === input?.page) return result;
    return fallback(input);
  };
}
