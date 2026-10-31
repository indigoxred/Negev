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
  const shokoApiKey = env.NEGEV_SHOKO_API_KEY;
  if (typeof shokoApiKey !== 'string' || !shokoApiKey || /[\r\n]/.test(shokoApiKey)) {
    throw new TypeError('Shoko key required');
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
    shokoBaseUrl, shokoApiKey, publicOrigin,
    secureCookies: exposed, host, port };
}
