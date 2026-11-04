const validIds = (items, maximum) => Array.isArray(items) &&
  items.length <= maximum && items.every((id) =>
    Number.isSafeInteger(id) && id > 0);

// Each source contains only current exact Plex positives. A target verified
// through multiple paths counts once toward its request's public progress.
export function recentPublicCoverage({ episodeIds, directIds, titleIds,
  fileIds = [], includeIds = false }) {
  if (!validIds(episodeIds, 2_000) || !validIds(directIds, 10_000) ||
      !validIds(titleIds, 10_000) || !validIds(fileIds, 10_000) ||
      typeof includeIds !== 'boolean') {
    throw new TypeError('Invalid public availability coverage');
  }
  const positives = new Set([...directIds, ...titleIds, ...fileIds]);
  const availableEpisodeIds = episodeIds.filter((id) => positives.has(id));
  return { verifiedTargets: availableEpisodeIds.length,
    targetCount: episodeIds.length,
    ...(includeIds ? { availableEpisodeIds } : {}) };
}
