const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = () => ({ state: 'held', reason: 'availability_unverified' });

// Cached positives select which exact targets to inspect; they are not proof
// that a previously imported file still exists after a stopped-service reset.
export async function verifyCachedPositiveCoverage({ request, cached,
  readShoko, readPublic } = {}) {
  if (!validId(request?.anidbId) ||
      !['series', 'movie'].includes(request.kind) ||
      !Array.isArray(request.episodeIds) ||
      request.episodeIds.length < 1 || request.episodeIds.length > 2_000 ||
      request.episodeIds.some((id) => !validId(id)) ||
      new Set(request.episodeIds).size !== request.episodeIds.length ||
      cached?.targetCount !== request.episodeIds.length ||
      !Array.isArray(cached.availableEpisodeIds) ||
      cached.availableEpisodeIds.length !== cached.verifiedTargets ||
      new Set(cached.availableEpisodeIds).size !==
        cached.availableEpisodeIds.length ||
      cached.availableEpisodeIds.some((id) =>
        !request.episodeIds.includes(id)) ||
      typeof readShoko !== 'function' || typeof readPublic !== 'function') {
    throw new TypeError('Invalid cached positive coverage check');
  }
  const confirmed = new Set();
  let next = 0;
  let failed = false;
  const ids = cached.availableEpisodeIds;
  const worker = async () => {
    while (!failed && next < ids.length) {
      const episodeId = ids[next++];
      const target = { anidbId: request.anidbId, episodeId,
        kind: request.kind };
      let shoko;
      try { shoko = await readShoko(target); }
      catch { failed = true; return; }
      if (shoko?.state === 'not_imported' ||
          (shoko?.state === 'ok' && shoko.complete === true &&
            Array.isArray(shoko.files) && shoko.files.length === 0)) {
        continue;
      }
      if (shoko?.state !== 'ok' || shoko.complete !== true ||
          !Array.isArray(shoko.files) || shoko.files.length === 0) {
        failed = true; return;
      }
      let publicResult;
      try { publicResult = await readPublic(target, shoko); }
      catch { failed = true; return; }
      if (publicResult?.state !== 'available') {
        failed = true; return;
      }
      confirmed.add(episodeId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, ids.length) },
    () => worker()));
  if (failed) return held();
  const availableEpisodeIds = request.episodeIds.filter((id) =>
    confirmed.has(id));
  return { verifiedTargets: availableEpisodeIds.length,
    targetCount: request.episodeIds.length, availableEpisodeIds };
}
