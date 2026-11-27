import { MAX_ACQUISITION_TARGETS } from './torrent-file-limits.mjs';
import { collectUnimportedTargets } from './collect-unimported-targets.mjs';

import { heldReporter } from '../runtime/held-diagnostics.mjs';
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });
const heldAfter = heldReporter('acquisition/collect-target-scoped-uncertain');

// A first acquisition is explicitly uncertain when Plex can confirm source
// health but cannot enumerate a complete absence. Recheck only this request's
// AniDB targets and public source; an unrelated Import job is not a gate.
export async function collectTargetScopedUncertain({ anidbId, episodeIds,
  kind, publicLibraryIds, readEpisode, probePublic,
  now = Date.now } = {}) {
  if (!validId(anidbId) || !Array.isArray(episodeIds) ||
      episodeIds.length < 1 || episodeIds.length > MAX_ACQUISITION_TARGETS ||
      episodeIds.some((id) => !validId(id)) ||
      new Set(episodeIds).size !== episodeIds.length ||
      !['series', 'movie'].includes(kind) ||
      !Array.isArray(publicLibraryIds) ||
      publicLibraryIds.length < 1 || publicLibraryIds.length > 4 ||
      publicLibraryIds.some((id) => !validId(id)) ||
      new Set(publicLibraryIds).size !== publicLibraryIds.length ||
      [readEpisode, probePublic, now].some((value) =>
        typeof value !== 'function')) {
    throw new TypeError('Invalid target-scoped first-time observation');
  }
  const scope = { anidbId, episodeIds: [...episodeIds] };
  const inspectShoko = () => collectUnimportedTargets({ ...scope, readEpisode });
  const inspectPublic = async () => {
    let result;
    try { result = await probePublic({ kind }); }
    catch (error) { return heldAfter(error, 'public_probe_unverified'); }
    if (result?.state !== 'healthy_unconfirmed' ||
        result.probeCoverage !== 'health_only' ||
        result.sourceVerified !== true || result.complete !== false ||
        !Array.isArray(result.libraryIds) ||
        result.libraryIds.length !== publicLibraryIds.length ||
        new Set(result.libraryIds).size !== publicLibraryIds.length ||
        publicLibraryIds.some((id) => !result.libraryIds.includes(id)) ||
        !Array.isArray(result.parts) || result.parts.length !== 0) {
      return held('public_probe_unverified');
    }
    return { state: 'healthy_unconfirmed',
      libraryIds: [...publicLibraryIds], parts: [], complete: false,
      probeCoverage: 'health_only', sourceVerified: true };
  };
  const firstShoko = await inspectShoko();
  if (firstShoko.state !== 'unimported_targets') return firstShoko;
  const firstPublic = await inspectPublic();
  if (firstPublic.state !== 'healthy_unconfirmed') return firstPublic;
  const beforeObservedAtMs = now();
  const secondShoko = await inspectShoko();
  if (secondShoko.state !== 'unimported_targets') return secondShoko;
  const secondPublic = await inspectPublic();
  if (secondPublic.state !== 'healthy_unconfirmed') return secondPublic;
  const observedAtMs = now();
  if (!Number.isSafeInteger(beforeObservedAtMs) ||
      !Number.isSafeInteger(observedAtMs) ||
      beforeObservedAtMs < 0 || observedAtMs < beforeObservedAtMs ||
      observedAtMs - beforeObservedAtMs > 30_000) {
    return held('availability_evidence_stale');
  }
  return { ...scope, observedAtMs, shoko: secondShoko,
    plex: secondPublic,
    importFence: { state: 'target_rechecked', ...scope,
      beforeObservedAtMs, afterObservedAtMs: observedAtMs } };
}
