import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';
import { inferReleaseState } from '../catalogue/infer-release-state.mjs';
import { confirmedSequelIds, mapParentInstallments } from './parent-watch-evidence.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });
const validTitle = (value) => typeof value === 'string' &&
  value.length > 0 && value.length <= 300 && value.trim() === value &&
  !/[\x00-\x1f\x7f]/.test(value);

// This creates held request-ledger watches only. The acquisition queue's
// independent Sonarr guard remains the authority for a torrent start.
export async function reconcileParentWatch({ parent, map, parents, requests,
  loadDetail, readRelations, today, nowMs } = {}) {
  if (!validId(parent?.tvdbId) || !validId(parent?.requesterId) ||
      !validId(parent?.sourceSeriesId) ||
      typeof parents?.listInstallments !== 'function' ||
      typeof parents?.claimInstallment !== 'function' ||
      typeof parents?.recordInstallment !== 'function' ||
      typeof requests?.submit !== 'function' ||
      typeof loadDetail !== 'function' ||
      typeof readRelations !== 'function' ||
      typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today) ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('Invalid parent watch reconciliation');
  }
  const mapped = mapParentInstallments({ map, tvdbId: parent.tvdbId });
  if (mapped.state !== 'mapped') return mapped;
  const recorded = new Set(parents.listInstallments({ tvdbId: parent.tvdbId })
    .filter((item) => validId(item.requestId)).map((item) => item.anidbId));
  const candidates = new Set(mapped.anidbIds);
  const relationHolds = [];
  const queue = [...new Set([...mapped.anidbIds, ...recorded])];
  const visited = new Set();
  while (queue.length > 0) {
    if (visited.size >= 20) return held('too_many_parent_relations');
    const sourceId = queue.shift();
    if (visited.has(sourceId)) continue;
    visited.add(sourceId);
    const related = await confirmedSequelIds({ sourceId,
      readRelations });
    if (related.state === 'confirmed') {
      for (const id of related.anidbIds) {
        candidates.add(id);
        if (!visited.has(id)) queue.push(id);
      }
    } else relationHolds.push(sourceId);
    if (candidates.size > 100) return held('too_many_parent_candidates');
  }
  const created = [];
  const existing = [];
  const skipped = [];
  const heldCandidates = [];
  const cutoffMs = Date.parse(`${today}T00:00:00Z`) - 180 * 24 * 60 * 60_000;
  for (const anidbId of [...candidates].sort((a, b) => a - b)) {
    if (recorded.has(anidbId)) { existing.push(anidbId); continue; }
    let detail;
    try { detail = await loadDetail({ anidbId }); }
    catch { heldCandidates.push(anidbId); continue; }
    if (!isCompleteAniDbDetail(detail, anidbId, { allowEmptySeries: true }) ||
        typeof detail.restricted !== 'boolean') {
      heldCandidates.push(anidbId); continue;
    }
    if (detail.kind !== 'series') { skipped.push(anidbId); continue; }
    const release = inferReleaseState({ today, kind: detail.kind,
      airDate: detail.airDate, endDate: detail.endDate,
      episodeCount: detail.episodeCount, episodes: detail.episodes });
    if (release.state === 'completed') { skipped.push(anidbId); continue; }
    if (!['airing', 'upcoming'].includes(release.state)) {
      heldCandidates.push(anidbId); continue;
    }
    if (release.state === 'airing' && detail.endDate == null &&
        ![detail.airDate, ...detail.episodes.filter((episode) =>
          episode.type === 'Episode').map((episode) => episode.airDate)]
          .some((value) => typeof value === 'string' && value.length === 10 &&
            Date.parse(`${value}T00:00:00Z`) >= cutoffMs)) {
      heldCandidates.push(anidbId); continue;
    }
    const requestKey = `parent-${parent.tvdbId}-${anidbId}`;
    const claim = parents.claimInstallment({ tvdbId: parent.tvdbId,
      anidbId, nowMs });
    if (claim.state !== 'claimed') {
      heldCandidates.push(anidbId); continue;
    }
    const submitted = requests.submit({ requesterId: parent.requesterId,
      requestKey, intent: { state: 'ready', anidbId, kind: 'series',
        episodeIds: [], monitorFuture: true,
        ...(validTitle(detail.title) ? { title: detail.title } : {}) }, nowMs });
    if (!validId(submitted?.requestId)) return held('watch_submit_unavailable');
    const saved = parents.recordInstallment({ tvdbId: parent.tvdbId,
      anidbId, requestId: submitted.requestId, nowMs });
    if (saved.state !== 'recorded') return held('watch_record_unavailable');
    (submitted.created ? created : existing).push(anidbId);
  }
  return { state: 'reconciled', created, existing, skipped,
    ...(heldCandidates.length ? { heldCandidates } : {}),
    ...(relationHolds.length ? { relationHolds } : {}) };
}
