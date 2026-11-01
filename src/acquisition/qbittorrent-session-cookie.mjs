const TOKEN = '[A-Za-z0-9_+/-]{1,256}';
const LEGACY = new RegExp(`^${TOKEN}$`);
const MODERN = new RegExp(`^QBT_SID_([1-9][0-9]{0,4})=(${TOKEN})$`);

// Keep the modern cookie's name with its value. Its suffix is qBittorrent's
// configured WebUI port, which need not equal a reverse proxy's URL port.
export function validQbittorrentSessionId(value) {
  if (typeof value !== 'string') return false;
  if (LEGACY.test(value)) return true;
  const match = MODERN.exec(value);
  return match !== null && Number(match[1]) <= 65_535;
}

export function qbittorrentSessionCookie(sessionId) {
  if (!validQbittorrentSessionId(sessionId)) {
    throw new TypeError('Invalid qBittorrent session');
  }
  return MODERN.test(sessionId) ? sessionId : `SID=${sessionId}`;
}
