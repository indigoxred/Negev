import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';
import { inferReleaseState } from '../catalogue/infer-release-state.mjs';
import { planRequest } from './plan-request.mjs';

const held = (reason) => ({ state: 'held', reason });

// Held-request orchestration. It never searches an indexer or dispatches
// qBittorrent. The authenticated caller supplies requesterId.
export function createHeldRequestSubmitter({ titleRegistry, loadDetail, ledger, now, today }) {
  if (typeof titleRegistry?.isKnownTitle !== 'function' ||
      typeof loadDetail !== 'function' || typeof ledger?.submit !== 'function' ||
      typeof ledger?.findSubmission !== 'function' ||
      typeof now !== 'function' || typeof today !== 'function') {
    throw new TypeError('Invalid held-request configuration');
  }
  return async ({ requesterId, anidbId, scope, episodeIds, requestKey }) => {
    if (!Number.isSafeInteger(requesterId) || requesterId <= 0 ||
        !Number.isSafeInteger(anidbId) || anidbId <= 0 ||
        !['installment', 'episodes'].includes(scope) ||
        typeof requestKey !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(requestKey) ||
        (scope === 'installment' && episodeIds !== undefined) ||
        (scope === 'episodes' && (!Array.isArray(episodeIds) || episodeIds.length === 0 ||
          episodeIds.length > 2_000 || episodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0)))) {
      return held('invalid_request');
    }
    const commandKey = JSON.stringify([anidbId, scope,
      scope === 'episodes' ? [...new Set(episodeIds)].sort((a, b) => a - b) : null]);
    const previous = ledger.findSubmission({ requesterId, requestKey, commandKey });
    if (previous) return previous;
    if (!titleRegistry.isKnownTitle({ anidbId })) return held('unknown_title');
    const detail = await collectAniDbDetail({ anidbId, loadPage: loadDetail });
    if (detail.state !== 'details') {
      return held(detail.state === 'detail_pending' ? 'detail_pending' : 'detail_unavailable');
    }
    if (detail.restricted !== false) return held('restricted_or_unverified');
    const title = detail.title.trim();
    if (!title || title.length > 300 || /[\x00-\x1f\x7f]/.test(title)) {
      return held('detail_unavailable');
    }
    const currentDate = today();
    const release = inferReleaseState({ ...detail, today: currentDate });
    if (!['airing', 'completed'].includes(release.state)) return held('release_state_unknown');
    // A full declared episode count is only an inferred ending. Keep a new
    // series request watched until AniDB supplies an explicit end date, just
    // as the Airing poll does for an existing request.
    const releaseState = detail.kind === 'series' && release.state === 'completed' &&
      detail.endDate == null ? 'airing' : release.state;
    const intent = planRequest({ detail, releaseState,
      scope, episodeIds, today: currentDate });
    if (intent.state !== 'ready') return intent;
    return ledger.submit({ requesterId, requestKey, commandKey,
      intent: { ...intent, title }, nowMs: now() });
  };
}
