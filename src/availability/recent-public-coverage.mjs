const validIds = (items, maximum) => Array.isArray(items) &&
  items.length <= maximum && items.every((id) =>
    Number.isSafeInteger(id) && id > 0);

// Both sources contain only current exact Plex positives. A target verified
// through both paths must count once toward its request's public progress.
export function recentPublicCoverage({ episodeIds, directIds, titleIds }) {
  if (!validIds(episodeIds, 2_000) || !validIds(directIds, 10_000) ||
      !validIds(titleIds, 10_000)) {
    throw new TypeError('Invalid public availability coverage');
  }
  const positives = new Set([...directIds, ...titleIds]);
  return { verifiedTargets: episodeIds.filter((id) => positives.has(id)).length,
    targetCount: episodeIds.length };
}
