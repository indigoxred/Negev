const messages = {
  release_state_unknown: 'Negev could not confirm this title’s release timing from catalogue dates. Please try again shortly.',
  invalid_episode_selection: 'The episode selection changed. Refresh this title and choose again.',
  episode_not_aired: 'That episode has not aired yet. Request the series to watch for future episodes.',
  already_available: 'This installment is already available in Negev’s Library.',
  already_monitored_elsewhere: 'Future episodes are already monitored. No second request is needed.',
  detail_pending: 'Episode details are still being prepared. Please try again shortly.',
  detail_unavailable: 'Episode details are unavailable right now. Please try again.',
  request_cancelled: 'This request was cancelled. You can try requesting it again.',
  title_not_in_cutover: 'Anime requests for this title are temporarily unavailable in Negev. Please try again later.',
};

export function requestFailureMessage(error) {
  return messages[error?.reason] ?? messages[error?.message] ??
    'The request could not be saved. Please try again.';
}

export function savedRequestMessage(saved) {
  const hasId = Number.isSafeInteger(saved?.requestId) && saved.requestId > 0;
  if (saved?.reason === 'already_monitored') {
    return `Future episodes are already monitored by your request${hasId ? ` #${saved.requestId}` : ''}. View it under My Requests.`;
  }
  const receipt = hasId
    ? `Request #${saved.requestId} saved.` : 'Request saved.';
  if (saved?.state === 'pending' && saved.waitingFor === 'release_schedule') {
    return `${receipt} Negev is checking catalogue dates and episodes. No download has started. Follow it under My Requests.`;
  }
  if (saved?.state === 'pending') {
    return `${receipt} Negev will check the episode list and library before any download. Follow it under My Requests.`;
  }
  return `${receipt} ${hasId ? 'View its progress' : 'Follow it'} under My Requests.`;
}
