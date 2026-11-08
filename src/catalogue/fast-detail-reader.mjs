// Prefer exact AniDB episode IDs from the public snapshot for a first-time
// title. Shoko remains the fallback and the sole authority for imported files.
export function createFastDetailReader({ archive, shoko }) {
  if (typeof archive !== 'function' || typeof shoko !== 'function') {
    throw new TypeError('Invalid fast detail reader');
  }
  return async (input) => {
    let result;
    try { result = await archive(input); }
    catch { /* Shoko can still have the catalogue page. */ }
    if (result?.state === 'details' && result.anidbId === input?.anidbId &&
        result.page === input?.page) return result;
    return shoko(input);
  };
}
