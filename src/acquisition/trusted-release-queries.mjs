// Only the current AniDB detail and same-ID title source may supply these
// search terms. A browser-provided release query is never trusted directly.
export function trustedReleaseQueries(title, aliases = []) {
  const queries = [];
  const seen = new Set();
  const withoutCatalogueYear = typeof title === 'string'
    ? title.replace(/\s+\((?:19|20)\d{2}\)$/, '') : null;
  const maxQueries = 4;
  for (const value of [title, withoutCatalogueYear,
    ...(Array.isArray(aliases) ? aliases.slice(0, 10) : [])]) {
    if (typeof value !== 'string') continue;
    const full = value.trim();
    // AniDB can give a unique main title followed by a long subtitle. Use
    // that named main title when the full title cannot fit Prowlarr's query
    // limit. Independent title, episode, and file checks still gate a grab.
    const long = full.length > 120;
    const main = long ? full.split(/[:：]/u, 1)[0].trim() : full;
    const query = !long || (main !== full && main.length >= 16 &&
      main.split(/\s+/u).length >= 3) ? main : null;
    if (query !== null && (query.length < 2 || query.length > 120 ||
        /[\x00-\x1f\x7f]/.test(query))) continue;
    // Prowlarr treats punctuation in a long AniDB main title literally for
    // some indexers. Search its distinctive leading words as a second same-ID
    // retrieval hint; torrent files still need exact identity validation.
    const words = long ? (query ?? full).match(/[\p{L}\p{N}]+/gu) ?? [] : [];
    const plainPrefix = words.slice(0, 3).join(' ');
    for (const candidate of [...(query ? [query] : []),
      ...(words.length >= 4 && plainPrefix.length >= 16 &&
        plainPrefix.length <= 120 ? [plainPrefix] : [])]) {
      const key = candidate.toLocaleLowerCase('en');
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push(candidate);
      if (queries.length === maxQueries) return queries;
    }
  }
  // Long official names can fit the provider limit while differing from
  // indexer spelling in later words. Reuse only spare slots for retrieval;
  // these prefixes never become trustedIdentityTitles or bypass exact preview.
  for (const value of [title, ...(Array.isArray(aliases) ? aliases.slice(0, 10) : [])]) {
    if (queries.length === maxQueries) break;
    if (typeof value !== 'string' || value.length < 60) continue;
    const words = value.match(/[\p{L}\p{N}]+/gu) ?? [];
    const prefix = words.slice(0, 3).join(' ');
    const key = prefix.toLocaleLowerCase('en');
    if (words.length < 8 || prefix.length < 16 || prefix.length > 120 || seen.has(key)) continue;
    queries.push(prefix);
    seen.add(key);
  }
  // Reuse spare query slots only after retaining the existing same-ID names.
  for (const query of [...queries]) {
    const neutral=query.replace(/[:：]/gu,' ').replace(/\s+/gu,' ').trim();
    const key=neutral.toLocaleLowerCase('en');
    if(neutral!==query&&!seen.has(key)) {
      queries.push(neutral);seen.add(key);
      if(queries.length===maxQueries)break;
    }
  }
  return queries;
}

// Search prefixes retrieve candidates; they are not evidence that a release
// belongs to the AniDB title. Only the main title or same-ID official names
// may establish the provisional file-planning identity.
export function trustedPackQueries(title, aliases = []) {
  return trustedReleaseQueries(title, aliases).map(query => `${query} batch`)
    .filter(query => query.length <= 120);
}

export function trustedIdentityTitles(title, aliases = []) {
  const source = [title, typeof title === 'string' ?
    title.replace(/\s+\((?:19|20)\d{2}\)$/, '') : null,
  ...(Array.isArray(aliases) ? aliases.slice(0, 10) : [])];
  const names = new Set();
  for (const value of source) {
    if (typeof value !== 'string') continue;
    const full = value.trim();
    const name = full.length > 120 ? full.split(/[:：]/u, 1)[0].trim() : full;
    if (name.length >= 2 && name.length <= 120 &&
        !/[\x00-\x1f\x7f]/.test(name)) names.add(name);
  }
  return trustedReleaseQueries(title, aliases).filter((query) => names.has(query));
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
    .filter((query) => query.length <= 120).slice(0, 4);
}
