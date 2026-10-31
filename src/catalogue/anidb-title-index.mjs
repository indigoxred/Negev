const TITLE_TYPES = new Set(['main', 'official', 'synonym', 'short']);

// Pure parser for a candidate AniDB pipe-delimited title dump. The caller
// must verify the downloaded format and freshness before using this index.
export function parseAniDbTitleDump(text, { maxBytes = 32_000_000,
  maxLines = 500_000 } = {}) {
  if (typeof text !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !Number.isSafeInteger(maxLines) || maxLines < 1 ||
      Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new TypeError('Invalid AniDB title dump');
  }
  const rows = text.split(/\r?\n/);
  if (rows.length > maxLines + 1) throw new TypeError('Invalid AniDB title dump');
  const byId = new Map();
  for (const row of rows) {
    if (!row || row.startsWith('#')) continue;
    const first = row.indexOf('|');
    const second = row.indexOf('|', first + 1);
    const third = row.indexOf('|', second + 1);
    if (first < 1 || second < 0 || third < 0) throw new TypeError('Invalid AniDB title row');
    const rawId = row.slice(0, first);
    const type = row.slice(first + 1, second);
    const language = row.slice(second + 1, third);
    const title = row.slice(third + 1).trim();
    const id = Number(rawId);
    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) ||
        !TITLE_TYPES.has(type) || !/^[a-z0-9-]{2,16}$/i.test(language) ||
        !title || title.length > 500 || /[\u0000-\u001f]/.test(title)) {
      throw new TypeError('Invalid AniDB title row');
    }
    let entry = byId.get(id);
    if (!entry) {
      entry = { anidbId: id, title: null, aliases: new Set() };
      byId.set(id, entry);
    }
    if (type === 'main') {
      if (entry.title && entry.title !== title) throw new TypeError('Conflicting AniDB main title');
      entry.title = title;
    }
    entry.aliases.add(title.toLocaleLowerCase('en'));
  }
  if (byId.size === 0 || [...byId.values()].some((entry) => !entry.title)) {
    throw new TypeError('Incomplete AniDB title dump');
  }
  return byId;
}

export function searchAniDbTitleIndex(index, { query, page = 1,
  pageSize = 20 } = {}) {
  const term = typeof query === 'string' ? query.trim() : '';
  if (!(index instanceof Map) || term.length < 2 || term.length > 120 ||
      !Number.isSafeInteger(page) || page < 1 || page > 1000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    return { state: 'invalid_query' };
  }
  const needle = term.toLocaleLowerCase('en');
  const matches = [];
  for (const entry of index.values()) {
    let rank = Infinity;
    for (const alias of entry.aliases) {
      if (alias === needle) rank = 0;
      else if (alias.startsWith(needle)) rank = Math.min(rank, 1);
      else if (alias.includes(needle)) rank = Math.min(rank, 2);
    }
    if (rank < Infinity) matches.push({ entry, rank });
  }
  matches.sort((a, b) => a.rank - b.rank ||
    a.entry.title.localeCompare(b.entry.title) || a.entry.anidbId - b.entry.anidbId);
  return { state: 'results', total: matches.length, page,
    items: matches.slice((page - 1) * pageSize, page * pageSize)
      .map(({ entry }) => ({ anidbId: entry.anidbId,
        title: entry.title, detailState: 'pending', requestable: false })) };
}
