import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';

const held = (reason) => ({ state: 'held', reason });
const selectable = new Set(['Episode', 'Special']);
const fullDate = (value) => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// Pure request intent. Classification must come from a trusted source; this
// function never guesses Airing/Completed from a title or current date.
export function planRequest({ detail, releaseState, scope, episodeIds, today } = {}) {
  const anidbId = detail?.anidbId;
  if (!isCompleteAniDbDetail(detail, anidbId, {
    allowEmptySeries: ['airing', 'upcoming'].includes(releaseState) && scope === 'installment',
  }) ||
      !['series', 'movie'].includes(detail.kind)) return held('detail_incomplete');
  if (!['airing', 'upcoming', 'completed'].includes(releaseState) ||
      (detail.kind === 'movie' && releaseState !== 'completed')) return held('release_state_unknown');
  if (!['installment', 'episodes'].includes(scope)) return held('invalid_scope');
  if (['airing', 'upcoming'].includes(releaseState) && !fullDate(today)) return held('invalid_current_date');

  let selected;
  if (scope === 'installment') {
    selected = detail.episodes.filter((episode) => episode.type === 'Episode' &&
      (releaseState === 'completed' ||
        (fullDate(episode.airDate) && episode.airDate <= today))).map((episode) => episode.id);
  } else {
    if (!Array.isArray(episodeIds) || episodeIds.length === 0 ||
        episodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(episodeIds).size !== episodeIds.length) return held('invalid_episode_selection');
    const byId = new Map(detail.episodes.map((episode) => [episode.id, episode]));
    if (episodeIds.some((id) => !selectable.has(byId.get(id)?.type))) {
      return held('invalid_episode_selection');
    }
    if (['airing', 'upcoming'].includes(releaseState) && episodeIds.some((id) => {
      const episode = byId.get(id);
      return episode.type === 'Episode' &&
        (!fullDate(episode.airDate) || episode.airDate > today);
    })) return held('episode_not_aired');
    selected = episodeIds;
  }
  // AniDB may list a complete movie alongside alternative multipart entries.
  // A film request must name one exact target; never acquire all editions.
  if (detail.kind === 'movie' && selected.length !== 1) {
    return held('ambiguous_movie_scope');
  }
  if (selected.length === 0 && !(['airing', 'upcoming'].includes(releaseState) &&
    detail.kind === 'series' && scope === 'installment')) {
    return held('invalid_episode_selection');
  }
  return {
    state: 'ready', anidbId, kind: detail.kind,
    episodeIds: [...selected].sort((a, b) => a - b),
    monitorFuture: detail.kind === 'series' &&
      ['airing', 'upcoming'].includes(releaseState) && scope === 'installment',
  };
}
