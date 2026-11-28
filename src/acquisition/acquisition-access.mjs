const held = reason => ({ state: 'held', reason });

export async function checkAcquisitionAccess(authorizeRequest, input) {
  if (authorizeRequest === undefined) return { state: 'authorized' };
  try {
    const result = await authorizeRequest(input);
    if (result?.state === 'authorized' && typeof result.restricted === 'boolean') return result;
    return result?.state === 'held' && typeof result.reason === 'string'
      ? result : held('restricted_or_unverified');
  } catch { return held('restricted_or_unverified'); }
}

// No classification memo: every new reservation/add/start checks the current
// catalogue and then the current owner. Existing send intents reconcile through
// their normal journal paths without invoking this new-send authorization.
export function createAcquisitionAccess({ readRequest, readAttempt, readUser, loadDetail, readBonuses }) {
  if ([readRequest, readAttempt, readUser, loadDetail, readBonuses].some(value => typeof value !== 'function'))
    throw new TypeError('Acquisition access readers required');
  return async ({ requestId, attemptId } = {}) => {
    try {
      const request = readRequest(requestId ?? readAttempt(attemptId)?.requestId);
      if (!request || request.status !== 'held') return held('request_missing');
      const owner = () => readUser(request.requesterId);
      if (owner()?.id !== request.requesterId) return held('account_access_changed');
      const ids = new Set([request.anidbId]);
      if (attemptId !== undefined) for (const bonus of readBonuses(attemptId) ?? []) ids.add(bonus.anidbId);
      let restricted = false;
      for (const anidbId of ids) {
        if (!Number.isSafeInteger(anidbId) || anidbId < 1) return held('restricted_or_unverified');
        const detail = await loadDetail({ anidbId, page: 1 });
        if (detail?.state !== 'details' || detail.anidbId !== anidbId || typeof detail.restricted !== 'boolean')
          return held('restricted_or_unverified');
        restricted ||= detail.restricted;
      }
      const current = owner(), latestRequest = readRequest(request.id);
      if (current?.id !== request.requesterId || latestRequest?.requesterId !== request.requesterId)
        return held('account_access_changed');
      if (latestRequest.status !== 'held') return held('request_missing');
      if (restricted && current.adultAllowed !== true) return held('adult_access_disabled');
      return { state: 'authorized', restricted };
    } catch { return held('restricted_or_unverified'); }
  };
}
