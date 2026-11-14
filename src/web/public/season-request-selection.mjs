import { summarizeSeasonAvailability } from './season-availability-presentation.mjs';

function requestGate(status, detail) {
  return detail?.requestsOpen === false && status.selectable
    ? { ...status, text: `${status.text} · requests not open yet`, selectable: false }
    : status;
}

export function canOpenSeasonRequest(rows, hasMore) {
  return hasMore || rows.some((row) => row.status?.selectable && !row.requested);
}

export function seasonRequestStatus(detail) {
  if (detail?.kind === 'movie') return null;
  if (detail?.state === 'detail_unavailable') return { state: 'unverified',
    text: 'Episode details unavailable · retry later', selectable: false };
  if (detail?.state !== 'details' && detail?.state !== undefined) {
    return requestGate({ state: 'unverified',
      text: 'Episode list not available yet · request can be queued', selectable: true }, detail);
  }
  const full = detail?.regularSeason;
  const valid = Number.isSafeInteger(full?.total) && full.total > 0 &&
    Number.isSafeInteger(full.verified) && full.verified >= 0 &&
    full.verified <= full.total;
  const page = summarizeSeasonAvailability({ kind: detail?.kind,
    episodes: detail?.episodes, nextPage: detail?.nextPage });
  const season = valid ? full : page?.completeList ? page : null;
  if (!season?.total) {
    return requestGate({ state: 'unverified',
      text: 'Episode list not published yet · request can be queued', selectable: true }, detail);
  }
  const schedule = detail?.regularSchedule;
  if (schedule?.total === season.total && schedule.upcoming > 0 &&
      Number.isSafeInteger(schedule.aired) &&
      Number.isSafeInteger(schedule.verifiedAired) &&
      schedule.verifiedAired >= 0 && schedule.verifiedAired <= schedule.aired) {
    const suffix = `${schedule.verifiedAired}/${schedule.aired} aired · ${schedule.upcoming} upcoming`;
    if (schedule.aired === 0) return requestGate({ state: 'unverified',
      text: `No aired episodes yet · ${schedule.upcoming} upcoming`,
      selectable: true }, detail);
    if (schedule.verifiedAired === schedule.aired) return detail.monitorFuture === true
      ? requestGate({ state: 'watching', text: `Available so far · ${suffix}`,
        selectable: true }, detail)
      : { state: 'available', text: `Available so far · ${suffix}`,
        selectable: false };
    return requestGate({ state: schedule.verifiedAired ? 'partial' : 'unverified',
      text: `${schedule.verifiedAired ? 'Partial' : 'Availability unconfirmed'} · ${suffix}`,
      selectable: true }, detail);
  }
  if (season.verified === season.total) return detail.monitorFuture === true
    ? requestGate({ state: 'watching', text: 'Available so far · watch future episodes',
      selectable: true }, detail)
    : { state: 'available', text: `Available · ${season.total}/${season.total}`, selectable: false };
  if (season.verified > 0) return requestGate({ state: 'partial',
    text: `Partial · ${season.verified}/${season.total}`, selectable: true }, detail);
  return requestGate({ state: 'unverified',
    text: `Availability unconfirmed · 0/${season.total} verified`,
    selectable: true }, detail);
}

export function seasonSelectionSummary(rows) {
  return rows.map((row) => `${row.title} · ${row.status.state === 'partial'
    ? 'complete episodes not verified in Plex' : row.status.state === 'watching'
      ? 'watch future episodes' : 'request episodes not verified in Plex'}`).join('; ');
}
