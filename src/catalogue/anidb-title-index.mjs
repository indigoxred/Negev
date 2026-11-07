// AniDB's pipe-delimited .dat dump uses numeric title types. These are not
// the string-valued types in its XML title dump.
const TITLE_TYPES = new Map([
  ['1', 'main'], ['2', 'synonym'], ['3', 'short'], ['4', 'official'],
  ['5', 'kana'], ['6', 'card'],
]);

// Pure parser for a candidate AniDB pipe-delimited title dump. The caller
// must verify the downloaded format and freshness before using this index.
function prepareRows(text, { maxBytes = 32_000_000,
  maxLines = 500_000 } = {}) {
  if (typeof text !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !Number.isSafeInteger(maxLines) || maxLines < 1 ||
      Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new TypeError('Invalid AniDB title dump');
  }
  const rows = text.split(/\r?\n/);
  if (rows.length > maxLines + 1) throw new TypeError('Invalid AniDB title dump');
  return rows;
}

function addRow(byId, row) {
  if (!row || row.startsWith('#')) return;
  const first = row.indexOf('|');
  const second = row.indexOf('|', first + 1);
  const third = row.indexOf('|', second + 1);
  if (first < 1 || second < 0 || third < 0) throw new TypeError('Invalid AniDB title row');
  const rawId = row.slice(0, first);
  const type = TITLE_TYPES.get(row.slice(first + 1, second));
  const language = row.slice(second + 1, third);
  // One live official-title row contains an embedded tab. Treat that separator
  // as a space for search while still rejecting other control characters.
  const title = row.slice(third + 1).replace(/\t+/g, ' ').trim();
  const id = Number(rawId);
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) ||
      !type || !/^[a-z0-9-]{2,16}$/i.test(language) ||
      !title || title.length > 500 || /[\u0000-\u001f]/.test(title)) {
    throw new TypeError('Invalid AniDB title row');
  }
  let entry = byId.get(id);
  if (!entry) {
    entry = { anidbId: id, title: null, aliases: new Set(),
      englishOfficial: new Set() };
    byId.set(id, entry);
  }
  if (type === 'main') {
    if (entry.title && entry.title !== title) throw new TypeError('Conflicting AniDB main title');
    entry.title = title;
  }
  if (type === 'official' && language.toLowerCase() === 'en') {
    entry.englishOfficial.add(title);
  }
  entry.aliases.add(title.toLocaleLowerCase('en'));
}

function finishIndex(byId) {
  if (byId.size === 0 || [...byId.values()].some((entry) => !entry.title)) {
    throw new TypeError('Incomplete AniDB title dump');
  }
  for (const entry of byId.values()) {
    entry.releaseQueries = [...new Set([entry.title, ...entry.englishOfficial])].slice(0, 3);
    delete entry.englishOfficial;
  }
  return byId;
}

export function parseAniDbTitleDump(text, options) {
  const rows = prepareRows(text, options);
  const byId = new Map();
  for (const row of rows) addRow(byId, row);
  return finishIndex(byId);
}

// Parse the same bounded dump in small batches so a catalogue refresh does
// not monopolize the web event loop. The completed map is published only
// after every row and every main-title requirement has passed validation.
export async function parseAniDbTitleDumpAsync(text, options) {
  const rows = prepareRows(text, options);
  const byId = new Map();
  for (let index = 0; index < rows.length; index++) {
    addRow(byId, rows[index]);
    if ((index + 1) % 2_048 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return finishIndex(byId);
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
  const words = needle.match(/[\p{L}\p{N}]+/gu) ?? [];
  const matches = [];
  for (const entry of index.values()) {
    let rank = Infinity;
    for (const alias of entry.aliases) {
      if (alias === needle) rank = 0;
      else if (alias.startsWith(needle)) rank = Math.min(rank, 1);
      else if (alias.includes(needle)) rank = Math.min(rank, 2);
      else if (words.length > 1) {
        const tokens = alias.match(/[\p{L}\p{N}]+/gu) ?? [];
        if (words.every((word) => tokens.some((token) => token.startsWith(word)))) {
          let cursor = 0;
          const ordered = words.every((word) => {
            const next = tokens.findIndex((token, index) =>
              index >= cursor && token.startsWith(word));
            if (next < 0) return false;
            cursor = next + 1;
            return true;
          });
          rank = Math.min(rank, ordered
            ? tokens[0].startsWith(words[0]) ? 3 : 4 : 5);
        }
      }
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
