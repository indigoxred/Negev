import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';
import { inferReleaseState } from '../catalogue/infer-release-state.mjs';
import { hasStatedRegularEpisodes } from '../catalogue/stated-episode-count.mjs';
import { planRequest } from './plan-request.mjs';

const held = (reason) => ({ state: 'held', reason });

// The title page and request submission must agree on whether a complete
// current installment can still be watched for future episodes.
export function requestReleaseState(detail, currentDate) {
  const release = inferReleaseState({ ...detail, today: currentDate });
  if (!['airing', 'upcoming', 'completed'].includes(release.state)) return release.state;
  return detail.kind === 'series' && release.state === 'completed' &&
    !hasStatedRegularEpisodes(detail)
    ? 'airing' : release.state;
}

// Held-request orchestration. It never searches an indexer or dispatches
// qBittorrent. The authenticated caller supplies requesterId.
export function createHeldRequestSubmitter({ titleRegistry, confirmKnownTitle =
  (input) => titleRegistry?.isKnownTitle(input) ?? false,
  loadDetail, ledger, now, today, recentlyAvailable = () => false,
  authorizeRequester }) {
  if (typeof confirmKnownTitle !== 'function' ||
      typeof loadDetail !== 'function' || typeof ledger?.submit !== 'function' ||
      typeof ledger?.findSubmission !== 'function' ||
      typeof now !== 'function' || typeof today !== 'function' ||
      typeof recentlyAvailable !== 'function' ||
      typeof authorizeRequester !== 'function') {
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
    if (!(await confirmKnownTitle({ anidbId }))) return held('unknown_title');
    const detail = await collectAniDbDetail({ anidbId, loadPage: loadDetail });
    if (detail.state !== 'details') {
      return held(detail.state === 'detail_pending' ? 'detail_pending' : 'detail_unavailable');
    }
    if (typeof detail.restricted !== 'boolean') return held('restricted_or_unverified');
    let policy;
    try { policy = await authorizeRequester({ requesterId, anidbId,
      restricted: detail.restricted }); }
    catch { return held('authorization_unavailable'); }
    if (policy?.active === false) return held('account_access_changed');
    if (policy?.active !== true) return held('authorization_unavailable');
    if (detail.restricted && policy.adultAllowed !== true) {
      return held('adult_access_disabled');
    }
    const title = detail.title.trim();
    if (!title || title.length > 300 || /[\x00-\x1f\x7f]/.test(title)) {
      return held('detail_unavailable');
    }
    const currentDate = today();
    const releaseState = requestReleaseState(detail, currentDate);
    if (!['airing', 'upcoming', 'completed'].includes(releaseState)) return held('release_state_unknown');
    const intent = planRequest({ detail, releaseState,
      scope, episodeIds, today: currentDate });
    if (intent.state !== 'ready') return intent;
    const currentAvailability = await Promise.all(intent.episodeIds.map((episodeId) =>
      recentlyAvailable({ anidbId, episodeId })));
    const missingIds = intent.episodeIds.filter((_, index) =>
      currentAvailability[index] !== true);
    if (!intent.monitorFuture && missingIds.length === 0) {
      return held('already_available');
    }
    return ledger.submit({ requesterId, requestKey, commandKey,
      intent: { ...intent, episodeIds: missingIds, title }, nowMs: now() });
  };
}
