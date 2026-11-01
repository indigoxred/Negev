// Public playback and local acquisition history are separate facts. Show both
// when a failed attempt still needs review after a file becomes playable.
function acquisitionText(progress, kind) {
  const target = kind === 'movie' ? 'film' : 'episode';
  if (progress.state === 'review_needed') return 'Needs owner review';
  switch (progress.state) {
    case 'saved': return progress.targetCount === 0 && kind === 'series'
      ? 'Watching for the first aired episode' : 'Saved · no download recorded';
    case 'release_preparing': return 'Preparing a release';
    case 'torrent_unverified': return 'Checking torrent submission';
    case 'torrent_stopped': return 'Release selected · download not started';
    case 'download_unverified': return 'Download requested · completion unverified';
    case 'partial_private_copy':
      return `${progress.privateVerifiedTargets}/${progress.targetCount} ${target} target${progress.targetCount === 1 ? '' : 's'} ${progress.targetCount === 1 ? 'has' : 'have'} a recorded private copy · Plex unverified`;
    case 'private_copy_recorded':
      return 'Files verified privately · Shoko import unverified';
    case 'import_unverified': return 'Shoko import outcome unverified · Plex unverified';
    default: return 'Request status unavailable';
  }
}

export function progressText(progress, kind) {
  if (!progress || !['unverified', 'verified_recently'].includes(progress.publicAvailability)) {
    return 'Request status unavailable';
  }
  if (progress.publicAvailability === 'verified_recently') {
    const complete = progress.publicVerifiedTargets === progress.targetCount;
    const playback = complete
      ? `All requested ${kind === 'movie' ? 'film targets' : 'episodes'} checked playable in Plex recently`
      : `${progress.publicVerifiedTargets}/${progress.targetCount} requested ${kind === 'movie' ? 'film targets' : 'episodes'} checked playable in Plex recently`;
    if (progress.state === 'review_needed') return `${playback} · Earlier download needs review`;
    return !complete && progress.state !== 'saved'
      ? `${playback} · ${acquisitionText(progress, kind)}` : playback;
  }
  return acquisitionText(progress, kind);
}
