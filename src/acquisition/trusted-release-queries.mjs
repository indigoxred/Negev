// Only the current AniDB detail and same-ID title source may supply these
// search terms. A browser-provided release query is never trusted directly.
export function trustedReleaseQueries(title, aliases = []) {
  const queries = [];
  const seen = new Set();
  const withoutCatalogueYear = typeof title === 'string'
    ? title.replace(/\s+\((?:19|20)\d{2}\)$/, '') : null;
  for (const value of [title, withoutCatalogueYear,
    ...(Array.isArray(aliases) ? aliases.slice(0, 10) : [])]) {
    if (typeof value !== 'string') continue;
    const full = value.trim();
    // AniDB can give a unique main title followed by a long subtitle. Use
    // that named main title when the full title cannot fit Prowlarr's query
    // limit. Independent title, episode, and file checks still gate a grab.
    const query = full.length > 120 ? full.split(/[:：]/u, 1)[0].trim() : full;
    const key = query.toLocaleLowerCase('en');
    if (query.length < 2 || query.length > 120 ||
        (full.length > 120 && (query === full || query.length < 16 ||
          query.split(/\s+/u).length < 3)) ||
        /[\x00-\x1f\x7f]/.test(query) ||
        seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length === 3) break;
  }
  return queries;
}

// A missing-episode search is derived only from the current same-ID title
// source and an AniDB episode number. Preserve it through preflight and
// submission so a broad title page cannot make an older hit disappear.
export function trustedTargetedQuery(title, aliases, episodeNumber) {
  return trustedTargetedQueries(title, aliases, episodeNumber)[0] ?? null;
}

export function trustedTargetedQueries(title, aliases, episodeNumber) {
  if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1 ||
      episodeNumber > 9_999) return [];
  const suffix = ` ${String(episodeNumber).padStart(2, '0')}`;
  return trustedReleaseQueries(title, aliases).map((query) => `${query}${suffix}`)
    .filter((query) => query.length <= 120).slice(0, 2);
}
