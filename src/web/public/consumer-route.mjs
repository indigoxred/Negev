const mainPages = new Set(['discover', 'airing', 'library', 'requests', 'admin']);
const home = () => ({ page: 'discover', anidbId: null, query: '' });

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
  if (path !== 'discover') return search ? home() : { page: path, anidbId: null, query: '' };
  const params = new URLSearchParams(search);
  if ([...params.keys()].some((key) => key !== 'q')) return home();
  const query = params.get('q')?.trim() ?? '';
  if (query.length > 120) return home();
  return { page: path, anidbId: null, query };
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
