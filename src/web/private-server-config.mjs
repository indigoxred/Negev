// This configuration is deliberately restricted to a diagnostic catalogue
// service. It is not authentication for an end-user request site.
export function parsePrivateServerConfig(env) {
  if (env?.NEGEV_PRIVATE_TEST !== '1') throw new TypeError('Private test mode is required');
  const shokoBaseUrl = env.NEGEV_SHOKO_URL;
  let url;
  try { url = new URL(shokoBaseUrl); } catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Invalid Shoko URL');
  }
  const shokoApiKey = env.NEGEV_SHOKO_API_KEY;
  const testToken = env.NEGEV_TEST_TOKEN;
  const dataDir = env.NEGEV_DATA_DIR;
  if (typeof shokoApiKey !== 'string' || !shokoApiKey ||
      typeof testToken !== 'string' || testToken.length < 16 ||
      typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new TypeError('Missing private catalogue configuration');
  }
  const host = env.NEGEV_LISTEN_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && !(host === '0.0.0.0' && env.NEGEV_EXPOSE_PRIVATE_TEST === '1')) {
    throw new TypeError('Private catalogue bind not allowed');
  }
  const rawPort = env.NEGEV_PORT ?? '3000';
  if (!/^\d+$/.test(rawPort)) throw new TypeError('Invalid private catalogue port');
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('Invalid private catalogue port');
  }
  const prowlarrValues = [env.NEGEV_PROWLARR_URL, env.NEGEV_PROWLARR_API_KEY,
    env.NEGEV_PROWLARR_INDEXER_IDS];
  let prowlarr = {};
  if (prowlarrValues.some((value) => value !== undefined)) {
    let prowlarrUrl;
    try { prowlarrUrl = new URL(env.NEGEV_PROWLARR_URL); }
    catch { throw new TypeError('Invalid Prowlarr URL'); }
    const ids = typeof env.NEGEV_PROWLARR_INDEXER_IDS === 'string' &&
      /^\d+(,\d+)*$/.test(env.NEGEV_PROWLARR_INDEXER_IDS)
      ? env.NEGEV_PROWLARR_INDEXER_IDS.split(',').map(Number) : [];
    if (!['http:', 'https:'].includes(prowlarrUrl.protocol) || prowlarrUrl.username ||
        prowlarrUrl.password || prowlarrUrl.search || prowlarrUrl.hash ||
        typeof env.NEGEV_PROWLARR_API_KEY !== 'string' || !env.NEGEV_PROWLARR_API_KEY ||
        ids.length === 0 || ids.length > 20 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(ids).size !== ids.length) {
      throw new TypeError('Invalid Prowlarr search configuration');
    }
    prowlarr = { prowlarrBaseUrl: env.NEGEV_PROWLARR_URL,
      prowlarrApiKey: env.NEGEV_PROWLARR_API_KEY, prowlarrIndexerIds: ids };
  }
  return { shokoBaseUrl, shokoApiKey, testToken, dataDir, host, port, ...prowlarr };
}
