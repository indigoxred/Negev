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
