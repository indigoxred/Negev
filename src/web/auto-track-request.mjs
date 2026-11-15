export function autoTrackSavedAiringRequest({ result, requesterId, anidbId,
  readRequest, accounts }) {
  if (!Number.isSafeInteger(result?.requestId) || result.requestId < 1) return;
  try {
    const saved = readRequest(result.requestId);
    if (saved?.requesterId !== requesterId || saved.anidbId !== anidbId ||
        saved.status === 'cancelled' ||
        saved.kind !== 'series' || saved.monitorFuture !== true ||
        typeof accounts.getAiringPreferences !== 'function' ||
        typeof accounts.setAiringPreferences !== 'function') return;
    const preferences = accounts.getAiringPreferences({ userId: requesterId });
    if (!preferences || preferences.trackedAnidbIds.includes(anidbId) ||
        preferences.trackedAnidbIds.length >= 200) return;
    accounts.setAiringPreferences({ userId: requesterId,
      mode: preferences.mode,
      trackedAnidbIds: [...preferences.trackedAnidbIds, anidbId] });
  } catch { /* The request remains saved if the tracking preference is unavailable. */ }
}
