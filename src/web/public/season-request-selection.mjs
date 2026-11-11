import { summarizeSeasonAvailability } from './season-availability-presentation.mjs';

export function canOpenSeasonRequest(rows, hasMore) {
  return hasMore || rows.some((row) => row.status?.selectable && !row.requested);
}

export function seasonRequestStatus(detail) {
  if (detail?.kind === 'movie') return null;
  if (detail?.state !== 'details' && detail?.state !== undefined) {
    return { state: 'unverified', text: 'Checking episode details', selectable: true };
  }
  const full = detail?.regularSeason;
  const valid = Number.isSafeInteger(full?.total) && full.total > 0 &&
    Number.isSafeInteger(full.verified) && full.verified >= 0 &&
    full.verified <= full.total;
  const page = summarizeSeasonAvailability({ kind: detail?.kind,
    episodes: detail?.episodes, nextPage: detail?.nextPage });
  const season = valid ? full : page?.completeList ? page : null;
  if (!season?.total) {
    return { state: 'unverified', text: 'Checking episode details', selectable: true };
  }
  if (season.verified === season.total) return detail.monitorFuture === true
    ? { state: 'watching', text: 'Available so far · watch future episodes', selectable: true }
    : { state: 'available', text: `Available · ${season.total}/${season.total}`, selectable: false };
  if (season.verified > 0) return { state: 'partial',
    text: `Partial · ${season.verified}/${season.total}`, selectable: true };
  return { state: 'missing', text: `Missing · 0/${season.total}`, selectable: true };
}

export function seasonSelectionSummary(rows) {
  return rows.map((row) => `${row.title} · ${row.status.state === 'partial'
    ? 'complete missing episodes' : row.status.state === 'watching'
      ? 'watch future episodes' : 'request missing episodes'}`).join('; ');
}
