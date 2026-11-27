// Shape checks for service results that routes pass to the browser. Each
// returns null when the value is acceptable, or a short reason naming the
// first field that is not. Routes answer 503 and log the reason, so a
// mismatch between a service and its route shows up in the log.

const TAG = /^[a-z0-9][a-z0-9 -]{0,39}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ORDER_STATES = new Set(['schedule', 'fallback', 'score', 'popularity',
  'score_loading', 'score_unavailable', 'score_partial',
  'anilist_score', 'anilist_popular', 'anilist_stale', 'anilist_unavailable']);

const safeInt = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const optionalText = (value, max) => value === null || value === undefined ||
  (typeof value === 'string' && value.length <= max);
const firstProblem = (items, check) => {
  for (let index = 0; index < items.length; index++) {
    const problem = check(items[index]);
    if (problem) return `items[${index}].${problem}`;
  }
  return null;
};

export class ShapeError extends Error {
  constructor(label, problem) {
    super(`${label} returned an unexpected value: ${problem}`);
    this.name = 'ShapeError';
  }
}

function airingItemProblem(item) {
  if (!safeInt(item?.anidbId, 1)) return 'anidbId';
  if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 250) return 'title';
  if (item.englishTitle != null &&
      (typeof item.englishTitle !== 'string' || item.englishTitle.length > 500)) return 'englishTitle';
  if (typeof item.scheduledDate !== 'string' || !DATE.test(item.scheduledDate)) return 'scheduledDate';
  if (typeof item.episodeNumber !== 'string' || item.episodeNumber.length > 24) return 'episodeNumber';
  if (typeof item.adult !== 'boolean') return 'adult';
  if (item.chineseProduction !== undefined && typeof item.chineseProduction !== 'boolean') {
    return 'chineseProduction';
  }
  const presence = item.libraryPresence;
  if (!['in_library', 'unknown'].includes(presence?.state) ||
      !safeInt(presence.verifiedEpisodeCount) ||
      (presence.state === 'in_library') !== (presence.verifiedEpisodeCount > 0)) {
    return 'libraryPresence';
  }
  return null;
}

export function airingScheduleProblem(schedule, nowMs) {
  if (!['ready', 'stale'].includes(schedule?.state)) return 'state';
  if (!/^\d{4}-W\d{2}$/.test(schedule.week ?? '')) return 'week';
  if (!safeInt(schedule.checkedMs) || schedule.checkedMs > nowMs) return 'checkedMs';
  if (!Array.isArray(schedule.items) || schedule.items.length > 200) return 'items';
  return firstProblem(schedule.items, airingItemProblem);
}

function ratingProblem(rating) {
  if (rating === undefined) return null;
  if (rating?.score !== null && (typeof rating?.score !== 'number' ||
      !Number.isFinite(rating.score) || rating.score < 0 || rating.score > 10)) return 'rating.score';
  if (rating.source === 'anilist' ? rating.votes !== null
    : !safeInt(rating.votes) || (rating.score !== null && rating.votes === 0)) return 'rating.votes';
  if (!safeInt(rating.members)) return 'rating.members';
  if (!safeInt(rating.checkedMs)) return 'rating.checkedMs';
  return null;
}

function seasonItemProblem(item) {
  if (!safeInt(item?.anidbId, 1)) return 'anidbId';
  if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 300) return 'title';
  if (!optionalText(item.englishTitle, 500)) return 'englishTitle';
  if (typeof item.type !== 'string' || item.type.length > 80) return 'type';
  if (typeof item.adult !== 'boolean') return 'adult';
  if (item.chineseProduction !== undefined && typeof item.chineseProduction !== 'boolean') {
    return 'chineseProduction';
  }
  const presence = item.libraryPresence;
  if (presence !== undefined && (!['in_library', 'unknown'].includes(presence?.state) ||
      !safeInt(presence?.verifiedEpisodeCount) ||
      (presence.state === 'unknown' && presence.verifiedEpisodeCount !== 0))) {
    return 'libraryPresence';
  }
  if (item.releaseStatus !== null &&
      (typeof item.releaseStatus !== 'string' || item.releaseStatus.length > 80)) {
    return 'releaseStatus';
  }
  return ratingProblem(item.rating);
}

export function seasonPageProblem(page, { year, season, after, pageLimit }) {
  if (!['ready', 'partial', 'stale'].includes(page?.state)) return 'state';
  if (page.year !== year || page.season !== season) return 'year/season';
  if (typeof page.sourceDate !== 'string' || !DATE.test(page.sourceDate)) return 'sourceDate';
  if (!Array.isArray(page.items) || page.items.length > pageLimit) return 'items';
  if (!safeInt(page.total) || page.total > 100_000 || page.total < page.items.length) return 'total';
  if (!Array.isArray(page.availableTags) || page.availableTags.length > 5_000 ||
      page.availableTags.some((tag) => typeof tag !== 'string' || !TAG.test(tag))) {
    return 'availableTags';
  }
  const itemProblem = firstProblem(page.items, seasonItemProblem);
  if (itemProblem) return itemProblem;
  if (page.orderState !== undefined && !ORDER_STATES.has(page.orderState)) return 'orderState';
  if (page.scorePending !== undefined && typeof page.scorePending !== 'boolean') return 'scorePending';
  if (page.nextAfter !== null && (!Number.isSafeInteger(page.nextAfter) ||
      page.nextAfter <= after || page.nextAfter > 100_000)) return 'nextAfter';
  return null;
}
