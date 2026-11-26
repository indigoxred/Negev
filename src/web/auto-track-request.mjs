export function autoTrackSavedAiringRequest({ result, requesterId, anidbId,
  readRequest, accounts }) {
  // Acquisition replay must respect a later explicit removal from the list.
  if (result?.created !== true) return;
  if (!Number.isSafeInteger(result?.requestId) || result.requestId < 1) return;
  try {
    const saved = readRequest(result.requestId);
    if (saved?.requesterId !== requesterId || saved.anidbId !== anidbId ||
        saved.status === 'cancelled' ||
        saved.kind !== 'series' || saved.monitorFuture !== true ||
        typeof accounts.changeAiringPreferences !== 'function') return;
    accounts.changeAiringPreferences({ userId: requesterId,
      action: 'track', anidbId });
  } catch { /* The request remains saved if the tracking preference is unavailable. */ }
}
