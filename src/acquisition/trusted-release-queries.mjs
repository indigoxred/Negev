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
    const query = value.trim();
    const key = query.toLocaleLowerCase('en');
    if (query.length < 2 || query.length > 120 || /[\x00-\x1f\x7f]/.test(query) ||
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
  if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1 ||
      episodeNumber > 9_999) return null;
  const first = trustedReleaseQueries(title, aliases)[0];
  if (!first) return null;
  const query = `${first} ${String(episodeNumber).padStart(2, '0')}`;
  return query.length <= 120 ? query : null;
}
