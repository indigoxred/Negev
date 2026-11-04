import { createQbittorrentSessionFetch } from './qbittorrent-session-fetch.mjs';

const held = (reason) => ({ state: 'held', reason });
const validReason = (reason) => typeof reason === 'string' &&
  /^[a-z][a-z0-9_]{0,79}$/.test(reason);

// The three download stages use a single rate-limited login gate. No login or
// provider call occurs while this is constructed. Publication is independent
// of qBittorrent and can continue when its session is unavailable.
export function createAcquisitionSessionRunners({ qbBaseUrl, sessionGate,
  fetchImpl = fetch, processRequest, processStart, processCompletion,
  processPublish } = {}) {
  let base;
  try { base = new URL(qbBaseUrl); }
  catch { throw new TypeError('Invalid qBittorrent runtime URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.pathname !== '/' || base.search || base.hash ||
      typeof sessionGate?.get !== 'function' ||
      typeof sessionGate.invalidate !== 'function' ||
      [fetchImpl, processRequest, processStart, processCompletion,
        processPublish].some((fn) => typeof fn !== 'function')) {
    throw new TypeError('Invalid acquisition session runners');
  }
  const withSession = (processor, providers = {}, allowRenew = false) => async (input) => {
    let session;
    try { session = await sessionGate.get(); }
    catch { return held('authentication_unavailable'); }
    if (session?.state !== 'authenticated') {
      return held(validReason(session?.reason) ? session.reason :
        'authentication_unavailable');
    }
    let scopedFetch;
    try {
      scopedFetch = createQbittorrentSessionFetch({ baseUrl: qbBaseUrl,
        sessionId: session.sessionId, sessionGate, fetchImpl });
    } catch { return held('authentication_unavailable'); }
    const renewQbittorrent = allowRenew && typeof sessionGate.renew === 'function'
      ? async (expectedSessionId) => {
        let renewed;
        try { renewed = await sessionGate.renew(expectedSessionId); }
        catch { return held('authentication_unavailable'); }
        if (renewed?.state !== 'authenticated') return held(renewed?.reason ??
          'authentication_unavailable');
        try {
          return { state: 'authenticated', sessionId: renewed.sessionId,
            fetchImpl: createQbittorrentSessionFetch({ baseUrl: qbBaseUrl,
              sessionId: renewed.sessionId, sessionGate, fetchImpl }) };
        } catch { return held('authentication_unavailable'); }
      } : undefined;
    return processor({ ...input, ...providers,
      qbittorrent: { baseUrl: qbBaseUrl, sessionId: session.sessionId },
      fetchImpl: scopedFetch, ...(allowRenew ? { renewQbittorrent } : {}) });
  };
  return {
    processRequest: withSession(processRequest,
      { providerFetchImpl: fetchImpl }),
    processStart: withSession(processStart),
    processCompletion: withSession(processCompletion,
      { shokoFetchImpl: fetchImpl }, true),
    processPublish,
  };
}
