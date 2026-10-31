function validFile(file) {
  return Number.isSafeInteger(file?.fileId) && file.fileId > 0 &&
    Number.isSafeInteger(file.anidbId) && file.anidbId > 0 &&
    typeof file.storageKey === 'string' && file.storageKey.length > 0 &&
    Array.isArray(file.episodeIds) && file.episodeIds.length > 0 &&
    file.episodeIds.every((id) => Number.isSafeInteger(id) && id > 0) &&
    new Set(file.episodeIds).size === file.episodeIds.length &&
    Array.isArray(file.coverage) && file.coverage.length === file.episodeIds.length &&
    file.coverage.every((entry) => file.episodeIds.includes(entry?.episodeId) &&
      Number.isFinite(entry.start) && Number.isFinite(entry.end) &&
      entry.start >= 0 && entry.end <= 100 && entry.start < entry.end) &&
    new Set(file.coverage.map((entry) => entry.episodeId)).size === file.coverage.length;
}

function validPart(part) {
  return typeof part?.storageKey === 'string' && part.storageKey.length > 0 &&
    Number.isSafeInteger(part.libraryId) && part.libraryId > 0 &&
    typeof part.readable === 'boolean';
}

// Input adapters must prove storageKey identifies the same underlying bytes
// across Shoko and Plex mounts. This pure decision never matches titles or
// guesses a path translation.
export function evaluateExactAvailability({ target, shoko, plex, publicLibraryIds } = {}) {
  if (!Number.isSafeInteger(target?.anidbId) || target.anidbId <= 0 ||
      !Number.isSafeInteger(target.episodeId) || target.episodeId <= 0 ||
      !Array.isArray(publicLibraryIds) || publicLibraryIds.length === 0 ||
      publicLibraryIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new TypeError('Invalid availability target or public libraries');
  }
  if (shoko?.state !== 'ok' || shoko.complete !== true || !Array.isArray(shoko.files) ||
      plex?.state !== 'ok' || plex.complete !== true || !Array.isArray(plex.parts) ||
      shoko.files.some((file) => !validFile(file)) ||
      plex.parts.some((part) => !validPart(part))) {
    return { state: 'unknown', reason: 'observer_incomplete' };
  }
  const publicIds = new Set(publicLibraryIds);
  const claims = new Map();
  const conflicts = new Set();
  for (const file of shoko.files) {
    const key = file.storageKey;
    const signature = `${file.fileId}:${file.anidbId}:${[...file.coverage]
      .sort((a, b) => a.episodeId - b.episodeId)
      .map((entry) => `${entry.episodeId}:${entry.start}-${entry.end}`).join(',')}`;
    if (claims.has(key) && claims.get(key) !== signature) conflicts.add(key);
    claims.set(key, signature);
  }
  const matching = shoko.files.filter((file) => file.anidbId === target.anidbId &&
    file.episodeIds.includes(target.episodeId));
  if (matching.some((file) => conflicts.has(file.storageKey))) {
    return { state: 'held', reason: 'conflicting_storage_identity' };
  }
  if (matching.length === 0) return { state: 'absent' };
  let unreadable = false;
  let partial = false;
  for (const file of matching) {
    const range = file.coverage.find((entry) => entry.episodeId === target.episodeId);
    if (range.start !== 0 || range.end !== 100) { partial = true; continue; }
    for (const part of plex.parts) {
      if (part.storageKey !== file.storageKey || !publicIds.has(part.libraryId)) continue;
      if (part.readable) return { state: 'available', fileId: file.fileId };
      unreadable = true;
    }
  }
  return unreadable ? { state: 'held', reason: 'plex_part_unreadable' } :
    partial ? { state: 'held', reason: 'partial_episode' } : { state: 'awaiting_plex' };
}
