import { summarizeSeasonAvailability } from './season-availability-presentation.mjs';

function requestGate(status, detail) {
  return detail?.requestsOpen === false && status.selectable
    ? { ...status, text: `${status.text} · requests not open yet`, selectable: false }
    : status;
}

export function canOpenSeasonRequest(rows, hasMore) {
  return hasMore || rows.some((row) => !row.requested &&
    (row.status?.selectable || row.detailFailed || row.loading));
}

export function seasonTriggerPresentation(rows, currentAnidbId, hasMore) {
  const current = rows.find((row) => row.anidbId === currentAnidbId);
  if (current?.status?.state === 'watching') return {
    showAvailable: false, showTrigger: true,
    triggerText: 'Watch future episodes' };
  if (current?.status?.state === 'partial') return {
    showAvailable: false, showTrigger: true,
    triggerText: 'Request episodes' };
  if (current?.status?.state !== 'available') return {
    showAvailable: false, showTrigger: true,
    triggerText: 'Request series' };
  const related = rows.filter((row) => row.anidbId !== currentAnidbId);
  return { showAvailable: true,
    showTrigger: canOpenSeasonRequest(related, hasMore),
    triggerText: related.some((row) => !row.requested && row.status?.selectable)
      ? 'Request other seasons' : 'Find other seasons' };
}

export function seasonRequestStatus(detail) {
  if (detail?.kind === 'movie') return null;
  if (detail?.releaseState === 'upcoming') return requestGate({ state: 'upcoming',
    text: 'Not yet released · request can be saved', selectable: true }, detail);
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

export function relatedAvailabilityText(detail) {
  if (detail?.releaseState === 'upcoming') return 'Not yet released';
  if (detail?.state !== 'details') return 'Availability unconfirmed';
  if (detail.kind === 'series') {
    const status = seasonRequestStatus({ ...detail, requestsOpen: true });
    return status?.state === 'unverified' &&
      !status.text.startsWith('Availability unconfirmed')
      ? 'Availability unconfirmed' : status?.text ?? 'Availability unconfirmed';
  }
  if (detail.kind !== 'movie' || !Array.isArray(detail.episodes))
    return 'Availability unconfirmed';
  const films = detail.episodes.filter((episode) => episode.type === 'Episode');
  const verified = films.filter((episode) => episode.availability === 'available').length;
  if (verified > 0 && detail.nextPage === null && verified === films.length)
    return `Available · ${verified}/${films.length}`;
  // One playable main film closes the title's request gate; the remaining
  // entries can be alternate editions, so do not label this title partial.
  if (verified) return `Available · ${verified} main film${verified === 1 ? '' : 's'} verified`;
  if (detail.nextPage !== null || !films.length) return 'Availability unconfirmed';
  return `Availability unconfirmed · 0/${films.length} verified`;
}

export function seasonSelectionSummary(rows) {
  return rows.map((row) => `${row.title} · ${row.status.state === 'partial'
    ? 'complete episodes not verified in Plex' : row.status.state === 'watching'
      ? 'watch future episodes' : row.status.state === 'upcoming'
        ? 'watch for release and future episodes'
        : 'request episodes not verified in Plex'}`).join('; ');
}
// A preview of the already selected request scope, not acquisition policy.
export function seasonSelectionScope(rows) {
  if(!rows.length)return 'Select a season to continue.';
  const ranges=values=>{const sorted=[...new Set(values)].sort((a,b)=>a-b),parts=[];for(let i=0;i<sorted.length;i++){const first=sorted[i];let last=first;while(sorted[i+1]===last+1)last=sorted[++i];parts.push(first===last?String(first):`${first}–${last}`);}return parts.join(', ');};
  return rows.map(row=>{
    const detail=row.detail;
    if(row.status?.state==='upcoming')return `${rows.length>1?row.title+': ':''}Watch for release and future episodes; no released episodes to download yet.`;
    const season=detail?.regularSeason,schedule=detail?.regularSchedule;
    if(!Number.isSafeInteger(season?.total)||!Number.isSafeInteger(season?.verified)||season.verified>season.total)return `${row.title}: request episodes not confirmed available; Specials stay separate.`;
    const datedScope=['airing','upcoming'].includes(detail.releaseState);
    const aired=datedScope&&schedule?.total===season.total&&Number.isSafeInteger(schedule.aired)&&Number.isSafeInteger(schedule.verifiedAired)&&schedule.verifiedAired<=schedule.aired;
    const total=aired?schedule.aired:season.total,skip=aired?schedule.verifiedAired:season.verified;
    const numbers=(detail.episodes??[]).filter(e=>e.type==='Episode'&&e.availability==='available'&&(!aired||e.airDate&&e.airDate<=schedule.asOf)).map(e=>e.number).filter(n=>Number.isSafeInteger(n)&&n>0);
    const skipText=skip?` ${skip} already available episode${skip===1?'':'s'}${numbers.length===skip?' ('+ranges(numbers)+')':''} will be skipped.`:'';
    return `${rows.length>1?row.title+': ':''}${total-skip} episode${total-skip===1?'':'s'} to request.${skipText}${datedScope?' Future episodes will also be monitored.':''} Specials stay separate.`;
  }).join(' ');
}
