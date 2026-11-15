export function trackingAction(preferences, anidbId) {
  if (!preferences) return 'Loading tracking…';
  return preferences.trackedAnidbIds.includes(anidbId)
    ? 'Stop tracking' : 'Track this title';
}

export function changeTrackedIds(preferences, anidbId) {
  const ids = new Set(preferences.trackedAnidbIds);
  if (ids.has(anidbId)) ids.delete(anidbId);
  else ids.add(anidbId);
  return { mode: preferences.mode, trackedAnidbIds: [...ids] };
}
