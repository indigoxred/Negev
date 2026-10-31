import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';

const held = (reason) => ({ state: 'held', reason });
const selectable = new Set(['Episode', 'Special']);

// Pure request intent. Classification must come from a trusted source; this
// function never guesses Airing/Completed from a title or current date.
export function planRequest({ detail, releaseState, scope, episodeIds } = {}) {
  const anidbId = detail?.anidbId;
  if (!isCompleteAniDbDetail(detail, anidbId) ||
      !['series', 'movie'].includes(detail.kind)) return held('detail_incomplete');
  if (!['airing', 'completed'].includes(releaseState) ||
      (detail.kind === 'movie' && releaseState !== 'completed')) return held('release_state_unknown');
  if (!['installment', 'episodes'].includes(scope)) return held('invalid_scope');

  let selected;
  if (scope === 'installment') {
    selected = detail.episodes.filter((episode) => episode.type === 'Episode').map((episode) => episode.id);
  } else {
    if (!Array.isArray(episodeIds) || episodeIds.length === 0 ||
        episodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(episodeIds).size !== episodeIds.length) return held('invalid_episode_selection');
    const byId = new Map(detail.episodes.map((episode) => [episode.id, episode]));
    if (episodeIds.some((id) => !selectable.has(byId.get(id)?.type))) {
      return held('invalid_episode_selection');
    }
    selected = episodeIds;
  }
  if (selected.length === 0) return held('invalid_episode_selection');
  return {
    state: 'ready', anidbId, kind: detail.kind,
    episodeIds: [...selected].sort((a, b) => a - b),
    monitorFuture: detail.kind === 'series' && releaseState === 'airing' && scope === 'installment',
  };
}
