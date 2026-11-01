import path from 'node:path';
import { localPath, validMount } from './known-card-availability.mjs';
import { probePhysicalCandidate } from './physical-plex-part.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const unknown = (reason, probes) => ({ state: 'unknown', reason, probes });
const validRemote = (value) => typeof value === 'string' &&
  value.length <= 4096 && path.posix.isAbsolute(value) &&
  path.posix.normalize(value) === value && !/[\0\r\n\\]/.test(value);

// Positive nomination only. A physical key in the public-card index is a
// discovery hint; the caller must still read the fresh Shoko file and Plex
// card and prove exact episode/movie and same readable file before Available.
export async function nominateIndexedFile({ fileId, inventory, cardIndex,
  shokoMount, publicLibraryIds, probeImpl = probePhysicalCandidate } = {}) {
  if (!validId(fileId) || typeof inventory?.getFile !== 'function' ||
      typeof inventory?.getFileHint !== 'function' ||
      typeof cardIndex?.lookupCardsByCandidateKey !== 'function' ||
      !validMount(shokoMount) || !Array.isArray(publicLibraryIds) ||
      publicLibraryIds.length < 1 || publicLibraryIds.length > 20 ||
      publicLibraryIds.some((id) => !validId(id)) ||
      new Set(publicLibraryIds).size !== publicLibraryIds.length ||
      typeof probeImpl !== 'function') {
    throw new TypeError('Invalid indexed file nomination');
  }
  let file, hint;
  try {
    file = inventory.getFile(fileId);
    hint = inventory.getFileHint(fileId);
  } catch { return unknown('file_hint_unverified', 0); }
  if (file?.state !== 'linked' || file.fileId !== fileId ||
      !Array.isArray(file.pairs) || file.pairs.length < 1 ||
      file.pairs.length > 100 || file.pairs.some((pair) =>
        !validId(pair?.anidbId) || !validId(pair.episodeId)) ||
      hint?.updated !== file.updated || !validId(hint.size) ||
      !Array.isArray(hint.sourcePaths) ||
      hint.sourcePaths.length < 1 || hint.sourcePaths.length > 20 ||
      hint.sourcePaths.some((source) => !validRemote(source)) ||
      new Set(hint.sourcePaths).size !== hint.sourcePaths.length) {
    return unknown('file_hint_unverified', 0);
  }
  const keys = new Set();
  let probes = 0;
  for (const remote of hint.sourcePaths) {
    const filePath = localPath(remote, shokoMount);
    if (!filePath) return unknown('path_mapping_failed', probes);
    probes++;
    let candidate;
    try { candidate = await probeImpl({ filePath,
      allowedRoot: shokoMount.localRoot, expectedSize: hint.size }); }
    catch { continue; }
    const key = candidate?.candidateKey;
    if (candidate?.state === 'candidate' && typeof key === 'string' &&
        key.length <= 100 && /^\d+:\d+:\d+$/.test(key) &&
        key.endsWith(`:${hint.size}`)) keys.add(key);
  }
  if (keys.size === 0) return unknown('source_probe_unavailable', probes);
  const cards = new Map();
  for (const kind of ['episode', 'movie']) {
    let result;
    try { result = cardIndex.lookupCardsByCandidateKey({
      keys: [...keys], libraryIds: publicLibraryIds, kind }); }
    catch { return unknown('public_index_unavailable', probes); }
    if (result?.state === 'held') return { state: 'held',
      reason: result.reason ?? 'candidate_budget_exceeded', probes };
    if (Array.isArray(result?.cards) && result.cards.length > 10) {
      return { state: 'held', reason: 'candidate_budget_exceeded', probes };
    }
    if (result?.state !== 'candidates' || !Array.isArray(result.cards) ||
        result.cards.some((card) =>
          !publicLibraryIds.includes(card?.libraryId) ||
          !validId(card.ratingKey))) {
      return unknown('public_index_unavailable', probes);
    }
    for (const card of result.cards) {
      cards.set(`${card.libraryId}:${card.ratingKey}:${kind}`,
        { libraryId: card.libraryId, ratingKey: card.ratingKey, kind });
      if (cards.size > 10) return { state: 'held',
        reason: 'candidate_budget_exceeded', probes };
    }
  }
  if (cards.size === 0) return unknown('no_indexed_candidate', probes);
  return { state: 'nominated', fileId, pairs: file.pairs,
    cards: [...cards.values()].sort((a, b) =>
      a.libraryId - b.libraryId || a.ratingKey - b.ratingKey ||
      a.kind.localeCompare(b.kind)), probes };
}
