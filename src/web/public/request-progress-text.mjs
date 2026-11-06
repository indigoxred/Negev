// The primary member view separates a short stage from its evidence. It never
// infers a live transfer or delivery ETA from an old qBittorrent start intent.
export function requestPresentation(progress, kind,
  { monitorFuture = false, watchClosed = false } = {}) {
  const unavailable = { stage: 'Status unavailable',
    detail: 'Negev could not check this request right now.',
    note: '', group: 'active' };
  if (!progress || !['series', 'movie'].includes(kind) ||
      !['unverified', 'verified_recently'].includes(progress.publicAvailability) ||
      !Number.isSafeInteger(progress.targetCount) || progress.targetCount < 0) {
    return unavailable;
  }
  const watching = monitorFuture && !watchClosed;
  const attention = ['review_needed', 'request_interrupted'].includes(progress.state);
  const attentionNote = progress.state === 'review_needed'
    ? 'An earlier download needs owner review.' :
    progress.state === 'request_interrupted'
      ? 'A previous check was interrupted.' : '';
  const publicCount = progress.publicAvailability === 'verified_recently' &&
    Number.isSafeInteger(progress.publicVerifiedTargets) &&
    progress.publicVerifiedTargets > 0 &&
    progress.publicVerifiedTargets <= progress.targetCount
    ? progress.publicVerifiedTargets : 0;
  const complete = progress.targetCount > 0 && publicCount === progress.targetCount;
  const targetName = kind === 'movie' ? 'film parts' : 'episodes';
  const acquisition = (() => {
    switch (progress.state) {
      case 'saved': return { stage: watching && progress.targetCount === 0
        ? 'Watching for the first episode' : 'Requested',
      detail: watching && progress.targetCount === 0
        ? 'No episode is included in this request yet.' :
          'No download is confirmed in progress.', note: '' };
      case 'release_preparing': return { stage: 'Finding a download',
        detail: 'Negev is checking a release for this request.', note: '' };
      case 'torrent_unverified': return { stage: 'Checking download submission',
        detail: 'Negev is confirming that the download was accepted.', note: '' };
      case 'release_check_retrying': return { stage: 'Will check again',
        detail: 'The release check could not finish yet.', note: '' };
      case 'torrent_stopped': return { stage: 'Download not started',
        detail: 'A release was selected but its transfer has not begun.', note: '' };
      case 'download_unverified': return { stage: 'Checking download status',
        detail: 'Negev has requested a download but has not confirmed its current progress.',
        note: '' };
      case 'release_identity_unverified': return { stage: 'Checking the download',
        detail: 'The downloaded file has not been confirmed as the requested title yet.',
        note: 'Negev will check again.' };
      case 'release_retirement_pending': return { stage: 'Looking for another download',
        detail: 'The previous file could not be confirmed as the requested title.',
        note: '' };
      case 'partial_private_copy': return { stage: 'Adding to the library',
        detail: `${progress.privateVerifiedTargets ?? 0} of ${progress.targetCount} requested files checked; Plex playback is not confirmed yet.`,
        note: progress.identityCheckPending ?
          'Another downloaded file still needs identity checking.' :
          progress.identityRetirementPending ?
            'Another release is being checked.' : '' };
      case 'private_copy_recorded':
      case 'import_unverified': return { stage: 'Adding to the library',
        detail: 'The downloaded files were checked; Plex playback is not confirmed yet.',
        note: '' };
      case 'review_needed':
      case 'request_interrupted': return { stage: 'Needs attention',
        detail: 'The owner needs to check this request.', note: attentionNote };
      default: return { stage: unavailable.stage, detail: unavailable.detail,
        note: '' };
    }
  })();
  if (complete) return {
    stage: watching ? 'Watching for the next episode' : 'Ready to watch',
    detail: kind === 'movie' ? 'The requested film is playable in Plex.' :
      watching ? `All ${progress.targetCount} currently requested episodes are playable in Plex.` :
        `All ${progress.targetCount} requested episodes are playable in Plex.`,
    note: attentionNote, group: attention ? 'attention' :
      watching ? 'watching' : 'completed',
  };
  if (publicCount > 0) return { stage: 'Partly available',
    detail: `${publicCount} of ${progress.targetCount} requested ${targetName} playable in Plex.`,
    note: attentionNote || (progress.oneTimeAcquisitionComplete === true
      ? `Completed earlier; the other ${targetName} are not confirmed playable recently.`
      : progress.state === 'saved' ? '' : acquisition.stage),
    group: attention ? 'attention' : watching ? 'watching' :
      progress.oneTimeAcquisitionComplete === true ? 'completed' : 'active' };
  if (progress.oneTimeAcquisitionComplete === true) return {
    stage: 'Completed earlier',
    detail: 'This request was fulfilled, but playback has not been checked recently.',
    note: attentionNote, group: attention ? 'attention' : 'completed',
  };
  return { ...acquisition, group: attention ? 'attention' :
    watching ? 'watching' : 'active' };
}
