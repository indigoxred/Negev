import { readBoundedJson } from '../http/bounded-response.mjs';

const MAP_URL = 'https://animap.id/api/v1/map';
const ANIDB_URL = 'https://animap.id/api/anidb/';
// AniMap's map is currently about 10 MB on the wire, but gzip expands to
// about 52 MB. Bound the decoded stream, which is what JSON.parse receives.
const MAX_MAP_BYTES = 60_000_000;
const MAX_DETAIL_BYTES = 128_000;
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const seasons = new Set(['WINTER', 'SPRING', 'SUMMER', 'FALL']);
const browseSeasons = new Set(['ALL', ...seasons]);
const seasonOrder = new Map(['WINTER', 'SPRING', 'SUMMER', 'FALL'].map((value, index) => [value, index]));
const kinds = new Set(['all', 'series', 'movies']);
const statuses = new Set(['all', 'ongoing']);
const sorts = new Set(['newest', 'oldest', 'title_asc', 'title_desc']);
const validTag = (value) => typeof value === 'string' &&
  (value === '' || /^[a-z0-9][a-z0-9 -]{0,39}$/i.test(value));
const validTags = (value) => typeof value === 'string' && value.length <= 200 &&
  (value === '' || value.split(',').length <= 5 &&
    value.split(',').every((tag) => validTag(tag) && tag !== ''));
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value) => typeof value === 'string' &&
  datePattern.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

async function parseMap(response) {
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('Invalid seasonal map stream');
  }
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_MAP_BYTES)) {
    throw new TypeError('Seasonal map too large');
  }
  const groups = new Map();
  let sourceDate = null;
  let count = 0;
  const addEntry = (entry) => {
    const year = entry?.animeSeason?.year;
    const season = entry?.animeSeason?.season;
    if (!Number.isSafeInteger(year) || year < 1900 || year > 2100 ||
        !seasons.has(season) || !Array.isArray(entry.sources) ||
        entry.sources.length > 100 || typeof entry.title !== 'string' ||
        !entry.title.trim() || entry.title.length > 300) return;
    const ids = entry.sources.map((source) =>
      /^https:\/\/anidb\.net\/anime\/([1-9]\d*)$/.exec(source)?.[1])
      .filter(Boolean).map(Number);
    if (ids.length !== 1 || !validId(ids[0])) return;
    const key = `${year}-${season}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ anidbId: ids[0], title: entry.title.trim(),
      type: typeof entry.type === 'string' ? entry.type.toUpperCase() : '',
      tags: Array.isArray(entry.tags) && entry.tags.length <= 100
        ? entry.tags.filter((tag) => validTag(tag) && tag !== '')
          .map((tag) => tag.trim().toLowerCase()) : [],
      releaseStatus: typeof entry.status === 'string' && entry.status.length <= 80
        ? entry.status : null });
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let phase = 'prefix';
  let prefix = '';
  let object = '';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  const accept = (char) => {
    if (phase === 'prefix') {
      prefix += char;
      if (prefix.length > 10_000) throw new TypeError('Seasonal map header too large');
      if (/"data"\s*:\s*\[$/.test(prefix)) {
        const header = JSON.parse(`${prefix}]}`);
        if (!validDate(header?.lastUpdate)) {
          throw new TypeError('Invalid seasonal map date');
        }
        sourceDate = header.lastUpdate;
        phase = 'between';
      }
      return;
    }
    if (phase === 'between' || phase === 'expectObject') {
      if (/\s/.test(char)) return;
      if (char === '{') {
        phase = 'object'; object = '{'; depth = 1;
        quoted = false; escaped = false;
      } else if (char === ']' && phase === 'between') phase = 'afterArray';
      else throw new TypeError('Invalid seasonal map entry');
      return;
    }
    if (phase === 'object') {
      object += char;
      if (object.length > 128_000) throw new TypeError('Seasonal map entry too large');
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          if (++count > 100_000) throw new TypeError('Too many seasonal entries');
          addEntry(JSON.parse(object));
          object = '';
          phase = 'afterObject';
        }
      }
      return;
    }
    if (phase === 'afterObject') {
      if (/\s/.test(char)) return;
      if (char === ',') phase = 'expectObject';
      else if (char === ']') phase = 'afterArray';
      else throw new TypeError('Invalid seasonal map separator');
      return;
    }
    if (phase === 'afterArray') {
      if (/\s/.test(char)) return;
      if (char === '}') phase = 'done';
      else throw new TypeError('Invalid seasonal map ending');
      return;
    }
    if (!/\s/.test(char)) throw new TypeError('Invalid trailing seasonal data');
  };
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_MAP_BYTES) throw new TypeError('Seasonal map too large');
    for (const char of decoder.decode(chunk, { stream: true })) accept(char);
  }
  for (const char of decoder.decode()) accept(char);
  if (phase !== 'done') throw new TypeError('Incomplete seasonal map');
  for (const [key, entries] of groups) {
    const seen = new Set();
    const duplicate = new Set();
    for (const entry of entries) {
      if (seen.has(entry.anidbId)) duplicate.add(entry.anidbId);
      seen.add(entry.anidbId);
    }
    groups.set(key, entries.filter((entry) => !duplicate.has(entry.anidbId))
      .sort((a, b) => a.title.localeCompare(b.title) || a.anidbId - b.anidbId));
  }
  const seenArchiveIds = new Set();
  const allEntries = [...groups.entries()]
    .sort(([left], [right]) => {
      const [leftYear, leftSeason] = left.split('-');
      const [rightYear, rightSeason] = right.split('-');
      return Number(rightYear) - Number(leftYear) ||
        seasonOrder.get(rightSeason) - seasonOrder.get(leftSeason);
    })
    .flatMap(([key, entries]) => {
      const [year, season] = key.split('-');
      return entries.map((entry) => ({ ...entry, year: Number(year), season }));
    }).filter((entry) => {
      if (seenArchiveIds.has(entry.anidbId)) return false;
      seenArchiveIds.add(entry.anidbId);
      return true;
    });
  return { sourceDate, groups, allEntries };
}

// Presentation data only. The acquisition and availability pipelines do not
// consume this reader or treat a seasonal map as proof of an exact file.
export function createSeasonalCatalogue({ fetchImpl = fetch, now = Date.now,
  cacheMs = 24 * 60 * 60_000, staleMs = 7 * 24 * 60 * 60_000,
  timeoutMs = 12_000 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      ![cacheMs, staleMs, timeoutMs].every((value) =>
        Number.isSafeInteger(value) && value > 0) || staleMs <= cacheMs ||
      staleMs > 14 * 24 * 60 * 60_000 || timeoutMs > 60_000) {
    throw new TypeError('Invalid seasonal catalogue configuration');
  }
  let cached = null;
  let checkedMs = null;
  let attemptedMs = null;
  let pendingMap = null;
  const detailCache = new Map();
  const options = () => ({ method: 'GET', redirect: 'manual',
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  async function loadMap(time) {
    if (cached && checkedMs + cacheMs > time) return 'ready';
    if (pendingMap) {
      try { await pendingMap; return 'ready'; }
      catch { return cached && checkedMs + staleMs > time ? 'stale' : 'unavailable'; }
    }
    if (attemptedMs === null || attemptedMs + 60_000 <= time) {
      if (!pendingMap) {
        attemptedMs = time;
        pendingMap = (async () => {
          const response = await fetchImpl(MAP_URL, options());
          if (response.status !== 200) throw new Error('Seasonal map unavailable');
          const parsed = await parseMap(response);
          cached = parsed;
          checkedMs = time;
        })().finally(() => { pendingMap = null; });
      }
      try { await pendingMap; return 'ready'; }
      catch { /* Preserve a visibly stale observation only. */ }
    }
    return cached && checkedMs + staleMs > time ? 'stale' : 'unavailable';
  }
  async function detail(id, time) {
    const saved = detailCache.get(id);
    if (saved && saved.checkedMs +
        (saved.value.kind === 'unknown' ? 10 * 60_000 : cacheMs) > time) {
      return saved.value;
    }
    try {
      const response = await fetchImpl(`${ANIDB_URL}${id}`, options());
      if (response.status !== 200) return { kind: 'unknown' };
      const data = await readBoundedJson(response, MAX_DETAIL_BYTES);
      if (data?.anidb_id !== id || typeof data.restricted !== 'boolean') {
        return { kind: 'unknown' };
      }
      const value = typeof data.title === 'string' && data.title.trim() &&
        data.title.length <= 300 && typeof data.type === 'string' &&
        data.type.length <= 80
          ? { kind: 'verified', title: data.title.trim(), type: data.type,
            adult: data.restricted }
          : { kind: 'unknown' };
      detailCache.set(id, { value, checkedMs: time });
      while (detailCache.size > 1_000) detailCache.delete(detailCache.keys().next().value);
      return value;
    } catch { return { kind: 'unknown' }; }
  }
  return { async read({ year, season, after = 0, limit = 12,
    kind = 'all', tag = '', status = 'all', sort = 'newest' } = {}) {
    if (!Number.isSafeInteger(year) || year !== 0 && (year < 1900 || year > 2100) ||
        !browseSeasons.has(season) || !Number.isSafeInteger(after) || after < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
        !kinds.has(kind) || !validTags(tag) || !statuses.has(status) ||
        !sorts.has(sort)) {
      throw new TypeError('Invalid season page');
    }
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) return { state: 'unavailable' };
    const mapState = await loadMap(time);
    if (mapState === 'unavailable') return { state: 'unavailable' };
    const seasonEntries = year === 0 || season === 'ALL'
      ? cached.allEntries.filter((entry) =>
        (year === 0 || entry.year === year) &&
        (season === 'ALL' || entry.season === season))
      : cached.groups.get(`${year}-${season}`) ?? [];
    const tagEntries = status === 'ongoing'
      ? seasonEntries.filter((entry) => entry.releaseStatus === 'ONGOING')
      : seasonEntries;
    const availableTags = [...new Set(tagEntries.flatMap((entry) => entry.tags))]
      .sort((a, b) => a.localeCompare(b));
    const selectedTags = tag ? tag.split(',').map((value) => value.trim().toLowerCase()) : [];
    const entries = seasonEntries
      .filter((entry) => (status === 'all' || entry.releaseStatus === 'ONGOING') &&
        (kind === 'all' || (kind === 'movies'
        ? entry.type === 'MOVIE'
        : ['TV', 'OVA', 'ONA', 'SPECIAL'].includes(entry.type))) &&
        selectedTags.every((selected) => entry.tags.includes(selected)));
    if (sort === 'oldest') entries.sort((a, b) =>
      (a.year ?? year) - (b.year ?? year) ||
      (seasonOrder.get(a.season ?? season) ?? 0) -
        (seasonOrder.get(b.season ?? season) ?? 0) ||
      a.title.localeCompare(b.title) || a.anidbId - b.anidbId);
    if (sort === 'title_asc' || sort === 'title_desc') {
      const direction = sort === 'title_desc' ? -1 : 1;
      entries.sort((a, b) => direction * a.title.localeCompare(b.title) ||
        a.anidbId - b.anidbId);
    }
    const page = entries.slice(after, after + limit);
    const found = [];
    for (let offset = 0; offset < page.length; offset += 4) {
      found.push(...await Promise.all(page.slice(offset, offset + 4)
        .map(async (entry) => ({ entry,
          verification: await detail(entry.anidbId, time) }))));
    }
    const partial = found.some(({ verification }) => verification.kind === 'unknown');
    const items = found.filter(({ verification }) => verification.kind === 'verified')
      .map(({ entry, verification }) => ({ anidbId: entry.anidbId,
        title: verification.title, type: verification.type,
        releaseStatus: entry.releaseStatus, adult: verification.adult }));
    return { state: mapState === 'stale' ? 'stale' : partial ? 'partial' : 'ready',
      year, season, sourceDate: cached.sourceDate, items, availableTags,
      nextAfter: after + limit < entries.length ? after + limit : null };
  } };
}
