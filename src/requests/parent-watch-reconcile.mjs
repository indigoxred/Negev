import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';
import { inferReleaseState } from '../catalogue/infer-release-state.mjs';
import { confirmedSequelIds, mapParentInstallments, validRelations } from './parent-watch-evidence.mjs';

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
  if (mapped.state !== 'mapped') {
    // A fully validated replacement map can retire the obsolete traversal,
    // while adoption and existing installment watches remain intact. Outages
    // and invalid/ambiguous evidence must keep their recoverable frontier.
    if (mapped.reason === 'parent_mapping_missing') {
      parents.saveRelationFrontier?.(parent.tvdbId, null);
    }
    return mapped;
  }
  const recorded = new Set(parents.listInstallments({ tvdbId: parent.tvdbId })
    .filter((item) => validId(item.requestId)).map((item) => item.anidbId));
  // Persist validated relation evidence for this exact mapped seed set.
  const seeds = mapped.anidbIds;
  const roots = [...new Set([...seeds, ...recorded])].sort((a,b)=>a-b);
  const saved = parents.getRelationFrontier?.(parent.tvdbId);
  const compatible = saved && JSON.stringify(saved.seeds) === JSON.stringify(seeds) &&
    Array.isArray(saved.relations);
  const maxEvidenceAgeMs = 24 * 60 * 60_000;
  const relationCache = new Map(compatible ? saved.relations.filter(entry =>
    Array.isArray(entry) && entry.length === 2 && validRelations(entry[1]?.value, entry[0]) &&
    Number.isSafeInteger(entry[1].observedMs) && entry[1].observedMs >= 0 &&
    entry[1].observedMs <= nowMs && nowMs - entry[1].observedMs < maxEvidenceAgeMs) : []);
  const pass = compatible && Number.isSafeInteger(saved.pass) && saved.pass >= 0 ? saved.pass : 0;
  const candidates = new Set(mapped.anidbIds);
  const relationHolds = [];
  const rootOffset = ((pass % Math.max(1, roots.length)) * 12) % Math.max(1, roots.length);
  const queue = [...roots.slice(rootOffset), ...roots.slice(0, rootOffset)];
  const visited = new Set();
  let reads = 0;
  let validatedReads = 0;
  let relationBudgetExhausted = false;
  const budgetedRelations = async (anidbId) => {
    if (relationCache.has(anidbId)) return relationCache.get(anidbId).value;
    if (reads >= 12) {
      relationBudgetExhausted = true;
      return { state: 'unavailable' };
    }
    reads++;
    const result = await readRelations(anidbId);
    if (validRelations(result, anidbId)) {
      validatedReads++;
      relationCache.set(anidbId, { value: result, observedMs: nowMs });
    }
    return result;
  };
  while (queue.length > 0) {
    const sourceId = queue.shift();
    if (visited.has(sourceId)) continue;
    visited.add(sourceId);
    const related = await confirmedSequelIds({ sourceId, readRelations: budgetedRelations, branchOffset: (pass % 50) * 12 });
    if (related.state === 'confirmed') {
      for (const id of related.anidbIds) {
        candidates.add(id);
        if (!visited.has(id)) queue.push(id);
      }
    } else relationHolds.push(sourceId);
    if (related.heldIds?.length) relationHolds.push(sourceId);
    if (relationBudgetExhausted) break;
  }
  const ordered = [...candidates].sort((a,b)=>a-b);
  const afterId = compatible && validId(saved.candidateAfterId) ? saved.candidateAfterId : 0;
  const remaining = ordered.filter(id=>id>afterId);
  const candidatePage = (remaining.length ? remaining : ordered).slice(0,100);
  const nextAfterId = candidatePage.at(-1) ?? 0;
  const candidateContinuation = (remaining.length ? remaining : ordered).length > 100;
  parents.saveRelationFrontier?.(parent.tvdbId,
    relationHolds.length || relationBudgetExhausted || candidateContinuation
      ? { seeds, relations: [...relationCache], pass: pass < Number.MAX_SAFE_INTEGER ? pass + 1 : 0,
          candidateAfterId: nextAfterId,
          continueSoon: candidateContinuation || (relationBudgetExhausted && validatedReads > 0) } : null);
  const created = [];
  const existing = [];
  const skipped = [];
  const heldCandidates = [];
  const cutoffMs = Date.parse(`${today}T00:00:00Z`) - 180 * 24 * 60 * 60_000;
  for (const anidbId of candidatePage) {
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
    ...(relationHolds.length ? { relationHolds } : {}),
    ...(relationBudgetExhausted ? { relationBudgetExhausted: true } : {}) };
}
