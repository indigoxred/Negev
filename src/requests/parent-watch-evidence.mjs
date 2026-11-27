import { heldReporter } from '../runtime/held-diagnostics.mjs';
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });
const heldAfter = heldReporter('requests/parent-watch-evidence');

// A TVDB parent is only a bridge from a former Sonarr monitor. A title's
// spelling cannot establish that bridge. Ambiguous cross-series entries hold.
export function mapParentInstallments({ map, tvdbId } = {}) {
  if (!validId(tvdbId) || map?.version !== 2 || !Array.isArray(map.anime) ||
      map.anime.length > 100_000) return held('parent_mapping_invalid');
  const matched = new Set();
  const seen = new Set();
  for (const item of map.anime) {
    if (!validId(item?.anidb_id) || seen.has(item.anidb_id) ||
        (item.tvdb_id != null && !validId(item.tvdb_id)) ||
        (item.episodes != null && !Array.isArray(item.episodes))) {
      return held('parent_mapping_invalid');
    }
    seen.add(item.anidb_id);
    const parents = new Set(item.tvdb_id == null ? [] : [item.tvdb_id]);
    for (const run of item.episodes ?? []) {
      if (run?.tvdb == null) continue;
      if (!Array.isArray(run.tvdb)) return held('parent_mapping_invalid');
      for (const target of run.tvdb) {
        const id = target?.series ?? item.tvdb_id;
        if (id != null && !validId(id)) return held('parent_mapping_invalid');
        if (id != null) parents.add(id);
      }
    }
    if (!parents.has(tvdbId)) continue;
    if (parents.size !== 1) return held('ambiguous_parent_mapping');
    matched.add(item.anidb_id);
  }
  return matched.size > 0
    ? { state: 'mapped', anidbIds: [...matched].sort((a, b) => a - b) }
    : held('parent_mapping_missing');
}

export function validRelations(value, id) {
  return value?.state === 'related_titles' && value.anidbId === id &&
    Array.isArray(value.items) && value.items.length <= 50 &&
    value.items.every((item) => validId(item?.anidbId) &&
      typeof item.relation === 'string' && item.relation.length <= 40) &&
    new Set(value.items.map((item) => item.anidbId)).size === value.items.length;
}

// A direct sequel is candidate watch evidence only when the target confirms
// the reverse prequel. Its own complete AniDB detail and release state are
// checked before any request is submitted.
export async function confirmedSequelIds({ sourceId, readRelations, branchOffset = 0 } = {}) {
  if (!validId(sourceId) || typeof readRelations !== 'function') {
    throw new TypeError('Invalid sequel evidence request');
  }
  let source;
  try { source = await readRelations(sourceId); }
  catch (error) { return heldAfter(error, 'relation_unavailable'); }
  if (!validRelations(source, sourceId)) return held('relation_unavailable');
  const confirmed = [];
  const heldIds = [];
  const offset = Number.isSafeInteger(branchOffset) && branchOffset >= 0
    ? branchOffset % Math.max(1, source.items.length) : 0;
  const branches = [...source.items.slice(offset), ...source.items.slice(0, offset)];
  for (const item of branches) {
    if (item.relation !== 'Sequel' || item.anidbId === sourceId) continue;
    let target;
    try { target = await readRelations(item.anidbId); }
    catch { heldIds.push(item.anidbId); continue; }
    if (!validRelations(target, item.anidbId)) { heldIds.push(item.anidbId); continue; }
    if (target.items.some((related) => related.anidbId === sourceId &&
        related.relation === 'Prequel')) confirmed.push(item.anidbId);
  }
  return { state: 'confirmed', anidbIds: confirmed.sort((a, b) => a - b),
    ...(heldIds.length ? { heldIds } : {}) };
}
