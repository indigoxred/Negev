// The short observed-title window limits incidental lookups, but it is not a
// durable identity source. On a miss, consult only the validated AniDB index.
export function createKnownTitleResolver({ registry, source }) {
  if (typeof registry?.isKnownTitle !== 'function' ||
      typeof registry?.observe !== 'function' ||
      (source !== null && source !== undefined &&
        (typeof source.refresh !== 'function' ||
         typeof source.getTitle !== 'function'))) {
    throw new TypeError('Invalid known-title resolver');
  }
  return async ({ anidbId }) => {
    if (!Number.isSafeInteger(anidbId) || anidbId < 1) return false;
    if (registry.isKnownTitle({ anidbId })) return true;
    if (!source) return false;
    let status;
    try { status = await source.refresh(); }
    catch { return false; }
    if (!['ready', 'stale'].includes(status?.state)) return false;
    const title = source.getTitle(anidbId);
    if (typeof title !== 'string' || !title.trim()) return false;
    return registry.observe({ state: 'results', total: 1,
      items: [{ anidbId, title }] });
  };
}
