const mainPages = new Set(['discover', 'airing', 'library', 'requests', 'admin']);
const home = () => ({ page: 'discover', anidbId: null, query: '' });
const validKind = (value) => ['all', 'series', 'movies'].includes(value);
const validTag = (value) => typeof value === 'string' && value.length <= 200 &&
  (value === '' || value.split(',').length <= 5 &&
    value.split(',').every((tag) => /^[a-z0-9][a-z0-9 -]{0,39}$/i.test(tag)));

export function parseConsumerRoute(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#/')) return home();
  const raw = hash.slice(2);
  const [path, search = ''] = raw.split('?');
  if (path === 'title' || path.startsWith('title/')) {
    if (search || !/^title\/[1-9]\d*$/.test(path)) return home();
    const anidbId = Number(path.slice(6));
    return Number.isSafeInteger(anidbId) && anidbId <= 2_147_483_647
      ? { page: 'title', anidbId, query: '' } : home();
  }
  if (!mainPages.has(path)) return home();
  if (path === 'discover' && search && new URLSearchParams(search).has('year')) {
    const params = new URLSearchParams(search);
    if ([...params.keys()].some((key) => !['year', 'season', 'after', 'kind', 'tag'].includes(key)) ||
        !/^\d{4}$/.test(params.get('year') ?? '') ||
        !['WINTER', 'SPRING', 'SUMMER', 'FALL'].includes(params.get('season')) ||
        params.has('after') && !/^(0|[1-9]\d*)$/.test(params.get('after')) ||
        !validKind(params.get('kind') ?? 'all') ||
        !validTag(params.get('tag') ?? '')) return home();
    const year = Number(params.get('year'));
    const after = Number(params.get('after') ?? '0');
    return year >= 1900 && year <= 2100 && Number.isSafeInteger(after) &&
      after <= 100_000 ? { page: 'discover', anidbId: null, query: '',
        year, season: params.get('season'), after,
        ...(params.has('kind') ? { kind: params.get('kind') } : {}),
        ...(params.has('tag') ? { tag: params.get('tag') } : {}) } : home();
  }
  if (path !== 'discover') return search ? home() : { page: path, anidbId: null, query: '' };
  const params = new URLSearchParams(search);
  if ([...params.keys()].some((key) => key !== 'q')) return home();
  const query = params.get('q')?.trim() ?? '';
  if (query.length > 120) return home();
  return { page: path, anidbId: null, query };
}

export function seasonRoute(year, season, after = 0,
  { kind = 'all', tag = '' } = {}) {
  if (!Number.isSafeInteger(year) || year < 1900 || year > 2100 ||
      !['WINTER', 'SPRING', 'SUMMER', 'FALL'].includes(season) ||
      !Number.isSafeInteger(after) || after < 0 || after > 100_000 ||
      !validKind(kind) || !validTag(tag)) {
    throw new TypeError('Invalid seasonal route');
  }
  const params = new URLSearchParams({ year: String(year), season });
  if (after) params.set('after', String(after));
  if (kind !== 'all') params.set('kind', kind);
  if (tag) params.set('tag', tag.trim().toLowerCase());
  return `#/discover?${params}`;
}

export function titleRoute(anidbId) {
  if (!Number.isSafeInteger(anidbId) || anidbId < 1 || anidbId > 2_147_483_647) {
    throw new TypeError('Invalid title ID');
  }
  return `#/title/${anidbId}`;
}

export function searchRoute(query) {
  if (typeof query !== 'string' || query.trim().length > 120) {
    throw new TypeError('Invalid search query');
  }
  const term = query.trim();
  return term ? `#/discover?${new URLSearchParams({ q: term })}` : '#/discover';
}
