import { createCatalogueReadPacer } from './search-pages.mjs';

// Owns authenticated API requests and catalogue pacing. Construction does not register event handlers.
export function createApiClient({ clearWorkspace, requestKeys, sessionResponses, state, refreshSession, fetch = globalThis.fetch }) {
  const cataloguePacers = { seasons: createCatalogueReadPacer(), library: createCatalogueReadPacer() };

  async function api(url, options = {}) {
    const { catalogueCurrent, ...fetchOptions } = options;
    const pacer = /^\/api\/seasons(?:\?|$)/.test(url) ? cataloguePacers.seasons :
      /^\/api\/library(?:\?|$)/.test(url) ? cataloguePacers.library : null;
    const userId = state.user?.id;
    const session = sessionResponses.current();
    const read = async () => {
      const headers = { Accept: 'application/json', ...fetchOptions.headers };
      if (fetchOptions.body !== undefined) headers['Content-Type'] = 'application/json';
      if (fetchOptions.method && fetchOptions.method !== 'GET' && state.csrf) headers['x-negev-csrf'] = state.csrf;
      const signal = fetchOptions.signal ?? (pacer ? AbortSignal.timeout(30_000) : undefined);
      const response = await fetch(url, { credentials: 'same-origin', ...fetchOptions, headers, signal });
      const data = await response.json().catch(() => ({}));
      const adultAllowed = response.headers?.get('x-negev-adult-allowed');
      if (url !== '/api/session' && typeof refreshSession === 'function' &&
          sessionResponses.isCurrent(session) && state.user?.id === userId &&
          ((['true', 'false'].includes(adultAllowed) &&
            (adultAllowed === 'true') !== state.user.adultAllowed) ||
            data.reason === 'adult_access_disabled' && state.user.adultAllowed !== false)) {
        await refreshSession({ background: true });
      }
      if (pacer && [429, 503].includes(response.status)) pacer.defer(response.headers.get('Retry-After'), response.status === 429 ? 60_000 : 5000);
      if (pacer && data.state === 'unavailable') pacer.defer(null, 30_000);
      if (!response.ok) {
        if (data.reason === 'request_cancelled' && sessionResponses.isCurrent(session) &&
            state.user?.id === userId && ['/api/requests', '/api/release-previews'].includes(url)) {
          const body = JSON.parse(fetchOptions.body ?? '{}');
          const selections = body.scope === 'episodes' && body.episodeIds?.length === 1
            ? [`episode-${body.episodeIds[0]}`, `film-entry-${body.episodeIds[0]}`] : ['installment'];
          for (const selection of selections) requestKeys.rejected({ userId,
            anidbId: body.anidbId, selection }, data, body.requestKey);
        }
        if (response.status === 401 && !['/api/login', '/api/register'].includes(url) &&
            sessionResponses.isCurrent(session)) clearWorkspace();
        const error = new Error(data.error || data.reason || 'Request failed ('+response.status+')');
        error.status = response.status; error.reason = data.reason; error.field = data.field;
        error.retryAfter = response.headers?.get('Retry-After'); throw error;
      }
      return data;
    };
    return pacer ? pacer.run(read, catalogueCurrent ?? (() => sessionResponses.isCurrent(session) && state.user?.id === userId)) : read();
  }
  return { api };
}
