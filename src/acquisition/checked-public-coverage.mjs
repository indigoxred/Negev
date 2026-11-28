// Only positive, complete target-scoped public proof may narrow a selection.
export async function checkedPublicCoverage(read, request, now = Date.now) {
  if (read === undefined) return { availableEpisodeIds: [] };
  try {
    const startedMs = now();
    const result = await read(request);
    const ids = result?.availableEpisodeIds ?? (result?.verifiedTargets === 0 ? [] : undefined);
    if (result?.targetCount !== request.episodeIds.length || !Array.isArray(ids) ||
        result.verifiedTargets !== ids.length || new Set(ids).size !== ids.length ||
        ids.some(id => !request.episodeIds.includes(id))) throw new Error('Invalid coverage');
    const finishedMs = now();
    if (ids.length && (!Number.isSafeInteger(startedMs) || startedMs < 0 || !Number.isSafeInteger(finishedMs) || finishedMs < startedMs || finishedMs - startedMs > 30_000)) return { state: 'held', reason: 'availability_evidence_stale' };
    return { availableEpisodeIds: ids, checkedAtMs: startedMs };
  } catch { return { state: 'held', reason: 'availability_unavailable' }; }
}
