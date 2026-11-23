// Sweep progress is not availability evidence. Its lifetime is independent of
// the short provider-uncertainty cache and is discarded with that cache.
const sweepsByCache = new WeakMap();
const SWEEP_LIMIT_MS = 15 * 60_000;
const validId = (value) => Number.isSafeInteger(value) && value > 0;

// Cached positives select which exact targets to inspect; they are not proof
// that a previously imported file still exists after a stopped-service reset.
export async function verifyCachedPositiveCoverage({ request, cached,
  readShoko, readPublic, cache = new Map(), now = Date.now,
  readRevision = () => '', ownedEpisodeIds = [], maxChecks = 16, timeoutMs = 5_000 } = {}) {
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
      typeof readShoko !== 'function' || typeof readPublic !== 'function' ||
      !(cache instanceof Map) || typeof now !== 'function' ||
      typeof readRevision !== 'function' || !Number.isInteger(maxChecks) ||
      !Array.isArray(ownedEpisodeIds) || ownedEpisodeIds.some(id => !request.episodeIds.includes(id)) ||
      maxChecks < 1 || maxChecks > 64 || !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 10_000) {
    throw new TypeError('Invalid cached positive coverage check');
  }
  const protectedIds=[...new Set([...cached.availableEpisodeIds,...ownedEpisodeIds])].sort((a,b)=>a-b);
  const scope=JSON.stringify([request.id??null,request.anidbId,request.kind,request.episodeIds,protectedIds]);
  let sweeps=sweepsByCache.get(cache);
  if(!sweeps){sweeps=new Map();sweepsByCache.set(cache,sweeps);}
  let sweep=sweeps.get(scope);
  for(const [key,value] of sweeps)if(key!==scope&&value.until<=now())sweeps.delete(key);
  if(!sweep){
    // Capacity cannot evict an unfinished sweep and make it spin from zero.
    // Protect overflow scopes as uncertain until their normal later retry.
    sweep={until:sweeps.size<64?now()+SWEEP_LIMIT_MS:0,visited:new Map()};
    if(sweep.until)sweeps.set(scope,sweep);
  }
  const expired=now()>=sweep.until;
  const confirmed = new Set(), uncertain = new Set();
  const pending = [];
  const keyFor = (id) => request.anidbId + ':' + request.kind + ':' + id;
  const targetFor = (id) => ({ anidbId: request.anidbId, kind: request.kind, episodeId: id });
  for (const id of protectedIds) {
    const target = targetFor(id), saved = cache.get(keyFor(id));
    let revision;
    try { revision = readRevision(target); } catch { uncertain.add(id); continue; }
    if (saved && saved.until > now() && saved.revision === revision) {
      sweep.visited.set(id,revision);
      if (saved.state === 'available') confirmed.add(id);
      else if (saved.state !== 'absent') uncertain.add(id);
    } else if(expired||sweep.visited.has(id)&&sweep.visited.get(id)===revision){
      // An expired result cannot prove availability or absence. It has still
      // been observed this pass, so protect it without restarting the sweep.
      uncertain.add(id);
    } else pending.push({ id, target, revision });
  }
  pending.sort((left, right) => (cache.get(keyFor(left.id))?.checkedMs ?? -1) -
    (cache.get(keyFor(right.id))?.checkedMs ?? -1));
  // Old cached positives beyond this pass's budget stay protected, never missing.
  const deferred = new Set(pending.slice(maxChecks).map(item => item.id));
  for (const id of deferred) uncertain.add(id);
  const selected = pending.slice(0, maxChecks);
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const { id, target, revision } = selected[next++];
      const controller = new AbortController();
      let timer;
      const observe = async () => {
        const shoko = await readShoko({ ...target, signal: controller.signal });
        if (controller.signal.aborted) return 'uncertain';
        if (shoko?.state === 'not_imported' || shoko?.state === 'ok' &&
            shoko.complete === true && Array.isArray(shoko.files) && !shoko.files.length) return 'absent';
        if (shoko?.state !== 'ok' || shoko.complete !== true ||
            !Array.isArray(shoko.files) || !shoko.files.length) return 'uncertain';
        const result = await readPublic(target, shoko);
        return result?.state === 'available' ? 'available' : 'uncertain';
      };
      let state;
      try {
        state = await Promise.race([observe().catch(() => 'uncertain'),
          new Promise(resolve => { timer = setTimeout(() => {
            controller.abort(); resolve('uncertain');
          }, timeoutMs); })]);
        if (readRevision(target) !== revision) state = 'uncertain';
      } catch { state = 'uncertain'; }
      finally { clearTimeout(timer); }
      sweep.visited.set(id,revision);
      cache.delete(keyFor(id));
      cache.set(keyFor(id), { state, revision, checkedMs: now(), until: now() +
        (state === 'available' ? 300_000 : state === 'absent' ? 10_000 : 5_000) });
      while (cache.size > 2_048) cache.delete(cache.keys().next().value);
      if (state === 'available') confirmed.add(id);
      else if (state !== 'absent') uncertain.add(id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, () => worker()));
  if(!deferred.size)sweeps.delete(scope);
  const availableEpisodeIds = request.episodeIds.filter(id => confirmed.has(id));
  return { verifiedTargets: availableEpisodeIds.length,
    targetCount: request.episodeIds.length, availableEpisodeIds,
    ...(deferred.size ? { pendingEpisodeIds: request.episodeIds.filter(id => deferred.has(id)) } : {}),
    ...(uncertain.size ? { uncertainEpisodeIds: request.episodeIds.filter(id => uncertain.has(id)) } : {}) };
}
