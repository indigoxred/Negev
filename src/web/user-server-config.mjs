import path from 'node:path';

function baseUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`Invalid ${label}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/' || value !== url.origin) {
    throw new TypeError(`Invalid ${label}`);
  }
  return url;
}

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const mount = (value) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).sort().join(',') ===
    'appRoot,localRoot' &&
  typeof value.appRoot === 'string' && value.appRoot !== '/' &&
  path.posix.isAbsolute(value.appRoot) &&
  path.posix.normalize(value.appRoot) === value.appRoot &&
  !/[\0\r\n\\]/.test(value.appRoot) &&
  typeof value.localRoot === 'string' && path.isAbsolute(value.localRoot) &&
  path.normalize(value.localRoot) === value.localRoot &&
  !/[\0\r\n]/.test(value.localRoot);
const within = (root, candidate) => candidate === root ||
  candidate.startsWith(`${root}/`);

function plexConfig(env, dataDir) {
  const names = ['NEGEV_PLEX_URL', 'NEGEV_PLEX_TOKEN_FILE',
    'NEGEV_PLEX_SECTIONS', 'NEGEV_SHOKO_MEDIA_MOUNT',
    'NEGEV_PLEX_MEDIA_MOUNTS', 'NEGEV_PLEX_TOKEN'];
  if (env.NEGEV_PLEX_OBSERVER != null &&
      !['0', '1'].includes(env.NEGEV_PLEX_OBSERVER)) {
    throw new TypeError('Invalid Plex observer flag');
  }
  if (env.NEGEV_PLEX_OBSERVER !== '1') {
    if (names.some((name) => Object.hasOwn(env, name))) {
      throw new TypeError('Plex observer is disabled');
    }
    return null;
  }
  if (Object.hasOwn(env, 'NEGEV_PLEX_TOKEN')) {
    throw new TypeError('Plex token must use a private file');
  }
  baseUrl(env.NEGEV_PLEX_URL, 'Plex URL');
  const plexTokenPath = path.join(dataDir, 'secrets', 'plex.token');
  if (env.NEGEV_PLEX_TOKEN_FILE !== plexTokenPath) {
    throw new TypeError('Private Plex token file required');
  }
  let sections, shokoMount, plexMounts;
  try {
    sections = JSON.parse(env.NEGEV_PLEX_SECTIONS);
    shokoMount = JSON.parse(env.NEGEV_SHOKO_MEDIA_MOUNT);
    plexMounts = JSON.parse(env.NEGEV_PLEX_MEDIA_MOUNTS);
  } catch { throw new TypeError('Invalid Plex observer JSON'); }
  if (!sections || typeof sections !== 'object' || Array.isArray(sections) ||
      Object.keys(sections).sort().join(',') !== 'episode,movie' ||
      !['episode', 'movie'].every((kind) =>
        Array.isArray(sections[kind]) && sections[kind].length <= 20 &&
        sections[kind].every(validId) &&
        new Set(sections[kind]).size === sections[kind].length) ||
      sections.episode.length + sections.movie.length === 0 ||
      new Set([...sections.episode, ...sections.movie]).size !==
        sections.episode.length + sections.movie.length ||
      !mount(shokoMount) || !Array.isArray(plexMounts) ||
      plexMounts.length < 1 || plexMounts.length > 8 ||
      plexMounts.some((entry) => !mount(entry)) ||
      plexMounts.some((entry, index) => plexMounts.some((other, otherIndex) =>
        index !== otherIndex && within(entry.appRoot, other.appRoot)))) {
    throw new TypeError('Invalid scoped Plex observer');
  }
  return { plexBaseUrl: env.NEGEV_PLEX_URL, plexTokenPath,
    publicSections: sections, shokoMount, plexMounts };
}

export function dateInZone(timeZone, instant = new Date()) {
  if (typeof timeZone !== 'string' || !timeZone ||
      !(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw new TypeError('Invalid local date configuration');
  }
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
  } catch { throw new TypeError('Invalid local time zone'); }
}

// Explicit, inert-by-default account-backed listener. It has no acquisition
// or public-availability worker and does not replace the private diagnostic.
export function parseUserServerConfig(env) {
  if (env?.NEGEV_USER_SERVER !== '1') throw new TypeError('User server mode required');
  const dataDir = env.NEGEV_DATA_DIR;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) ||
      path.normalize(dataDir) !== dataDir || dataDir.includes('\0')) {
    throw new TypeError('Absolute data directory required');
  }
  const shokoBaseUrl = env.NEGEV_SHOKO_URL;
  baseUrl(shokoBaseUrl, 'Shoko URL');
  if ([env.NEGEV_SHOKO_EVENTS, env.NEGEV_SHOKO_INVENTORY,
      env.NEGEV_AIRING_WATCH, env.NEGEV_PLEX_INDEX].some((flag) =>
    flag != null && !['0', '1'].includes(flag))) {
    throw new TypeError('Invalid observer flag');
  }
  if (env.NEGEV_PLEX_INDEX === '1' && env.NEGEV_PLEX_OBSERVER !== '1') {
    throw new TypeError('Plex index needs observer configuration');
  }
  const airingWatch = env.NEGEV_AIRING_WATCH === '1';
  if (airingWatch && !env.NEGEV_TIME_ZONE) {
    throw new TypeError('Airing watch time zone required');
  }
  const timeZone = env.NEGEV_TIME_ZONE ?? 'UTC';
  dateInZone(timeZone);
  const shokoApiKeyPath = path.join(dataDir, 'secrets', 'shoko.token');
  if (Object.hasOwn(env, 'NEGEV_SHOKO_API_KEY') ||
      env.NEGEV_SHOKO_API_KEY_FILE !== shokoApiKeyPath) {
    throw new TypeError('Private Shoko key file required');
  }
  const publicOrigin = env.NEGEV_PUBLIC_ORIGIN;
  const origin = baseUrl(publicOrigin, 'public origin');
  const host = env.NEGEV_LISTEN_HOST ?? '127.0.0.1';
  const exposed = host === '0.0.0.0' && env.NEGEV_EXPOSE_USERS === '1';
  if (host !== '127.0.0.1' && !exposed) throw new TypeError('User listener bind not allowed');
  if (exposed ? origin.protocol !== 'https:' :
      origin.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname)) {
    throw new TypeError('Public origin does not match listener safety');
  }
  const rawPort = env.NEGEV_PORT ?? '3000';
  if (typeof rawPort !== 'string' || !/^[1-9]\d{0,4}$/.test(rawPort)) {
    throw new TypeError('Invalid user server port');
  }
  const port = Number(rawPort);
  if (port > 65_535) throw new TypeError('Invalid user server port');
  return { dataDir, dbPath: path.join(dataDir, 'negev.sqlite'),
    sessionKeyPath: path.join(dataDir, 'session.key'),
    shokoBaseUrl, shokoApiKeyPath,
    shokoEvents: env.NEGEV_SHOKO_EVENTS === '1',
    shokoInventory: env.NEGEV_SHOKO_INVENTORY === '1',
    airingWatch, timeZone, plex: plexConfig(env, dataDir),
    plexIndex: env.NEGEV_PLEX_INDEX === '1', publicOrigin,
    secureCookies: exposed, host, port };
}
