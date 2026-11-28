const held = reason => ({ state: 'held', reason });

// Remove only whole physical files whose every target has current positive
// public proof. A combined video cannot be split around an owned episode.
export function selectMissingFiles(files, episodeIds, availableEpisodeIds) {
  if (!Array.isArray(files) || !files.length || !Array.isArray(episodeIds) ||
      !Array.isArray(availableEpisodeIds)) return held('file_plan_mismatch');
  const wanted = new Set(episodeIds), available = new Set(availableEpisodeIds), seen = new Set();
  const kept = [], excluded = [];
  for (const file of files) {
    if (!Array.isArray(file?.episodeIds) || !file.episodeIds.length ||
        file.episodeIds.some(id => !wanted.has(id) || seen.has(id))) return held('file_plan_mismatch');
    for (const id of file.episodeIds) seen.add(id);
    const owned = file.episodeIds.filter(id => available.has(id));
    if (owned.length && owned.length !== file.episodeIds.length) return held('target_already_available');
    (owned.length ? excluded : kept).push({ ...file, episodeIds: [...file.episodeIds] });
  }
  if (seen.size !== wanted.size) return held('file_plan_mismatch');
  if (!kept.length) return held('target_already_available');
  return { state: 'missing_files', files: kept, excludedFiles: excluded,
    episodeIds: kept.flatMap(file => file.episodeIds).sort((a, b) => a - b),
    excludedEpisodeIds: excluded.flatMap(file => file.episodeIds).sort((a, b) => a - b) };
}
