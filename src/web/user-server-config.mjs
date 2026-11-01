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
const validRuntimePath = (value) => typeof value === 'string' &&
  path.isAbsolute(value) && path.parse(value).root !== value &&
  path.normalize(value) === value && !/[\0\r\n]/.test(value);
const runtimePathsOverlap = (a, b) => {
  const relative = path.relative(a, b);
  return relative === '' || (relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const validSourceText = (value) => typeof value === 'string' &&
  value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const validSourceRoot = (value) => typeof value === 'string' &&
  value !== '/' && value.length <= 4_096 &&
  path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
  !/[\\\x00-\x1f\x7f]/.test(value);

function plexSourcePolicy(raw, sections) {
  if (raw === undefined) return null;
  let policy;
  try { policy = JSON.parse(raw); }
  catch { throw new TypeError('Invalid Plex source policy'); }
  const count = sections.episode.length + sections.movie.length;
  if (!Array.isArray(policy) || policy.length !== count || count > 4 ||
      policy.some((entry) => !entry || typeof entry !== 'object' ||
        Array.isArray(entry) ||
        Object.keys(entry).sort().join(',') !==
          'agent,libraryId,roots,scanner,type' ||
        !validId(entry.libraryId) ||
        entry.type !== (sections.episode.includes(entry.libraryId)
          ? 'show' : sections.movie.includes(entry.libraryId)
            ? 'movie' : null) ||
        !validSourceText(entry.agent) || !validSourceText(entry.scanner) ||
        !Array.isArray(entry.roots) || entry.roots.length < 1 ||
        entry.roots.length > 16 ||
        entry.roots.some((root) => !validSourceRoot(root)) ||
        new Set(entry.roots).size !== entry.roots.length) ||
      new Set(policy.map((entry) => entry.libraryId)).size !== count) {
    throw new TypeError('Invalid Plex source policy');
  }
  return policy;
}

function plexConfig(env, dataDir) {
  const names = ['NEGEV_PLEX_URL', 'NEGEV_PLEX_TOKEN_FILE',
    'NEGEV_PLEX_SECTIONS', 'NEGEV_SHOKO_MEDIA_MOUNT',
    'NEGEV_PLEX_MEDIA_MOUNTS', 'NEGEV_PLEX_TOKEN',
    'NEGEV_PLEX_GUID_PROBE', 'NEGEV_PLEX_SOURCE_POLICY'];
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
  if (env.NEGEV_PLEX_GUID_PROBE != null &&
      !['0', '1'].includes(env.NEGEV_PLEX_GUID_PROBE)) {
    throw new TypeError('Invalid Plex GUID probe flag');
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
      (env.NEGEV_PLEX_GUID_PROBE === '1' &&
        sections.episode.length + sections.movie.length > 4) ||
      new Set([...sections.episode, ...sections.movie]).size !==
        sections.episode.length + sections.movie.length ||
      !mount(shokoMount) || !Array.isArray(plexMounts) ||
      plexMounts.length < 1 || plexMounts.length > 8 ||
      plexMounts.some((entry) => !mount(entry)) ||
      plexMounts.some((entry, index) => plexMounts.some((other, otherIndex) =>
        index !== otherIndex && within(entry.appRoot, other.appRoot)))) {
    throw new TypeError('Invalid scoped Plex observer');
  }
  const sourcePolicy = plexSourcePolicy(env.NEGEV_PLEX_SOURCE_POLICY, sections);
  return { plexBaseUrl: env.NEGEV_PLEX_URL, plexTokenPath,
    publicSections: sections, shokoMount, plexMounts,
    guidProbe: env.NEGEV_PLEX_GUID_PROBE === '1', sourcePolicy };
}

function prowlarrConfig(env, dataDir) {
  const names = ['NEGEV_PROWLARR_URL', 'NEGEV_PROWLARR_KEY_FILE',
    'NEGEV_PROWLARR_INDEXERS', 'NEGEV_PROWLARR_API_KEY'];
  if (env.NEGEV_PROWLARR_DISCOVERY != null &&
      !['0', '1'].includes(env.NEGEV_PROWLARR_DISCOVERY)) {
    throw new TypeError('Invalid Prowlarr discovery flag');
  }
  if (env.NEGEV_PROWLARR_DISCOVERY !== '1') {
    if (names.some((name) => Object.hasOwn(env, name))) {
      throw new TypeError('Prowlarr discovery is disabled');
    }
    return null;
  }
  if (Object.hasOwn(env, 'NEGEV_PROWLARR_API_KEY')) {
    throw new TypeError('Prowlarr key must use a private file');
  }
  baseUrl(env.NEGEV_PROWLARR_URL, 'Prowlarr URL');
  const keyPath = path.join(dataDir, 'secrets', 'prowlarr.token');
  if (env.NEGEV_PROWLARR_KEY_FILE !== keyPath) {
    throw new TypeError('Private Prowlarr key file required');
  }
  let indexerIds;
  try { indexerIds = JSON.parse(env.NEGEV_PROWLARR_INDEXERS); }
  catch { throw new TypeError('Invalid Prowlarr indexers'); }
  if (!Array.isArray(indexerIds) || indexerIds.length < 1 ||
      indexerIds.length > 20 || indexerIds.some((id) => !validId(id)) ||
      new Set(indexerIds).size !== indexerIds.length) {
    throw new TypeError('Invalid Prowlarr indexers');
  }
  return { baseUrl: env.NEGEV_PROWLARR_URL, keyPath, indexerIds };
}

function qbitSidecarConfig(env, dataDir, shokoImportFolderId) {
  const names = ['NEGEV_QBITTORRENT_URL', 'NEGEV_QBITTORRENT_USERNAME',
    'NEGEV_QBITTORRENT_PASSWORD_FILE', 'NEGEV_QBITTORRENT_IMPORT_SAVE_PATH'];
  if (env.NEGEV_QBITTORRENT_SIDECAR_READ != null &&
      !['0', '1'].includes(env.NEGEV_QBITTORRENT_SIDECAR_READ)) {
    throw new TypeError('Invalid qBittorrent sidecar flag');
  }
  if (env.NEGEV_QBITTORRENT_SIDECAR_READ !== '1') {
    if (names.some((name) => Object.hasOwn(env, name))) {
      throw new TypeError('qBittorrent sidecar observation is disabled');
    }
    return null;
  }
  if (shokoImportFolderId === null) {
    throw new TypeError('qBittorrent sidecar observation needs a scoped Import folder');
  }
  baseUrl(env.NEGEV_QBITTORRENT_URL, 'qBittorrent URL');
  const username = env.NEGEV_QBITTORRENT_USERNAME;
  const passwordPath = path.join(dataDir, 'secrets', 'qbittorrent.password');
  const importSavePath = env.NEGEV_QBITTORRENT_IMPORT_SAVE_PATH;
  if (typeof username !== 'string' || !username || username.length > 256 ||
      /[\x00-\x1f\x7f]/.test(username) ||
      env.NEGEV_QBITTORRENT_PASSWORD_FILE !== passwordPath ||
      typeof importSavePath !== 'string' || importSavePath === '/' ||
      !path.posix.isAbsolute(importSavePath) ||
      path.posix.normalize(importSavePath) !== importSavePath ||
      /[\0\r\n\\]/.test(importSavePath)) {
    throw new TypeError('Invalid qBittorrent sidecar configuration');
  }
  return { baseUrl: env.NEGEV_QBITTORRENT_URL, username, passwordPath,
    importSavePath };
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
  if (Object.hasOwn(env, 'NEGEV_QBITTORRENT_PASSWORD') ||
      Object.hasOwn(env, 'NEGEV_QBITTORRENT_SID')) {
    throw new TypeError('qBittorrent credentials cannot use environment variables');
  }
  if (env.NEGEV_ACQUISITION_RUNTIME != null &&
      !['0', '1'].includes(env.NEGEV_ACQUISITION_RUNTIME)) {
    throw new TypeError('Invalid acquisition runtime flag');
  }
  const acquisitionRuntime = env.NEGEV_ACQUISITION_RUNTIME === '1';
  const dataDir = env.NEGEV_DATA_DIR;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) ||
      path.normalize(dataDir) !== dataDir || dataDir.includes('\0')) {
    throw new TypeError('Absolute data directory required');
  }
  const shokoBaseUrl = env.NEGEV_SHOKO_URL;
  baseUrl(shokoBaseUrl, 'Shoko URL');
  const shokoImportRoot = env.NEGEV_SHOKO_IMPORT_ROOT ?? null;
  if (shokoImportRoot !== null &&
      (typeof shokoImportRoot !== 'string' ||
       !path.isAbsolute(shokoImportRoot) ||
       path.parse(shokoImportRoot).root === shokoImportRoot ||
       path.normalize(shokoImportRoot) !== shokoImportRoot ||
       /[\0\r\n]/.test(shokoImportRoot))) {
    throw new TypeError('Invalid Shoko Import root');
  }
  const rawImportFolderId = env.NEGEV_SHOKO_IMPORT_FOLDER_ID;
  const shokoImportFolderId = rawImportFolderId === undefined ? null :
    Number(rawImportFolderId);
  if (rawImportFolderId !== undefined &&
      (shokoImportRoot === null || typeof rawImportFolderId !== 'string' ||
       !/^[1-9]\d*$/.test(rawImportFolderId) ||
       !validId(shokoImportFolderId))) {
    throw new TypeError('Invalid Shoko Import folder ID');
  }
  if ([env.NEGEV_SHOKO_EVENTS, env.NEGEV_SHOKO_INVENTORY,
      env.NEGEV_SHOKO_RECENT,
      env.NEGEV_AIRING_WATCH, env.NEGEV_PLEX_INDEX,
      env.NEGEV_DIRECT_AVAILABILITY,
      env.NEGEV_TITLE_CHECK,
      env.NEGEV_SHOKO_HYDRATION,
      env.NEGEV_ANIDB_TITLE_DUMP].some((flag) =>
    flag != null && !['0', '1'].includes(flag))) {
    throw new TypeError('Invalid observer flag');
  }
  if (env.NEGEV_PLEX_INDEX === '1' && env.NEGEV_PLEX_OBSERVER !== '1') {
    throw new TypeError('Plex index needs observer configuration');
  }
  if (env.NEGEV_DIRECT_AVAILABILITY === '1' &&
      ((env.NEGEV_PLEX_INDEX !== '1' &&
        env.NEGEV_PLEX_GUID_PROBE !== '1') ||
       env.NEGEV_SHOKO_INVENTORY !== '1' &&
       env.NEGEV_SHOKO_RECENT !== '1')) {
    throw new TypeError('Direct availability needs a Shoko observer and Plex discovery');
  }
  const rawDirectDelay = env.NEGEV_DIRECT_ACTIVE_DELAY_MS;
  if (rawDirectDelay !== undefined &&
      (env.NEGEV_DIRECT_AVAILABILITY !== '1' ||
       typeof rawDirectDelay !== 'string' ||
       !/^[1-9]\d*$/.test(rawDirectDelay) ||
       Number(rawDirectDelay) < 10_000 || Number(rawDirectDelay) > 300_000)) {
    throw new TypeError('Invalid direct availability active delay');
  }
  if (env.NEGEV_TITLE_CHECK === '1' &&
      (env.NEGEV_PLEX_INDEX !== '1' ||
       env.NEGEV_PLEX_OBSERVER !== '1')) {
    throw new TypeError('Title check needs a public Plex index');
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
  const plex = plexConfig(env, dataDir);
  const prowlarr = prowlarrConfig(env, dataDir);
  const qbitSidecar = qbitSidecarConfig(env, dataDir, shokoImportFolderId);
  const acquisitionNames = ['NEGEV_STAGING_HOST_PATH', 'NEGEV_HOLDING_ROOT',
    'NEGEV_MOUNT_WITNESS_SOCKET', 'NEGEV_SHOKO_RELEASE_PROVIDER_ID'];
  let acquisition = null;
  if (acquisitionRuntime) {
    const stagingHostPath = env.NEGEV_STAGING_HOST_PATH;
    const holdingRoot = env.NEGEV_HOLDING_ROOT;
    const mountWitnessSocket = env.NEGEV_MOUNT_WITNESS_SOCKET;
    const shokoProviderId = env.NEGEV_SHOKO_RELEASE_PROVIDER_ID;
    if (!prowlarr || !plex?.sourcePolicy || !plex.guidProbe || !qbitSidecar ||
        shokoImportFolderId === null || shokoImportRoot === null ||
        env.NEGEV_SHOKO_EVENTS !== '1' || env.NEGEV_SHOKO_RECENT !== '1' ||
        env.NEGEV_DIRECT_AVAILABILITY !== '1' ||
        !validRuntimePath(stagingHostPath) || !validRuntimePath(holdingRoot) ||
        stagingHostPath === shokoImportRoot ||
        runtimePathsOverlap(shokoImportRoot, stagingHostPath) ||
        runtimePathsOverlap(stagingHostPath, shokoImportRoot) ||
        runtimePathsOverlap(shokoImportRoot, holdingRoot) ||
        runtimePathsOverlap(holdingRoot, shokoImportRoot) ||
        runtimePathsOverlap(stagingHostPath, holdingRoot) ||
        runtimePathsOverlap(holdingRoot, stagingHostPath) ||
        mountWitnessSocket !== path.join(dataDir, 'mount-witness', 'mount.sock') ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(shokoProviderId)) {
      throw new TypeError('Acquisition runtime is unavailable without guarded providers and mounts');
    }
    acquisition = { stagingHostPath, holdingRoot,
      importRoot: path.join(shokoImportRoot, 'Negev'),
      mountWitnessSocket, shokoProviderId };
  } else if (acquisitionNames.some((name) => Object.hasOwn(env, name))) {
    throw new TypeError('Acquisition runtime is disabled');
  }
  return { dataDir, dbPath: path.join(dataDir, 'negev.sqlite'),
    acquisitionRuntime, acquisition,
    sessionKeyPath: path.join(dataDir, 'session.key'),
    shokoBaseUrl, shokoApiKeyPath, shokoImportRoot, shokoImportFolderId,
    shokoEvents: env.NEGEV_SHOKO_EVENTS === '1',
    shokoInventory: env.NEGEV_SHOKO_INVENTORY === '1',
    shokoRecent: env.NEGEV_SHOKO_RECENT === '1',
    directAvailability: env.NEGEV_DIRECT_AVAILABILITY === '1',
    directActiveDelayMs: rawDirectDelay === undefined ? 60_000 :
      Number(rawDirectDelay),
    titleCheck: env.NEGEV_TITLE_CHECK === '1',
    shokoHydration: env.NEGEV_SHOKO_HYDRATION === '1',
    anidbTitleDump: env.NEGEV_ANIDB_TITLE_DUMP === '1',
    airingWatch, timeZone, plex,
    prowlarr, qbitSidecar,
    plexIndex: env.NEGEV_PLEX_INDEX === '1', publicOrigin,
    secureCookies: exposed, host, port };
}
