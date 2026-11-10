const messages = {
  release_state_unknown: 'Negev could not confirm when this title starts airing. Please try again when its release date is listed.',
  invalid_episode_selection: 'The episode selection changed. Refresh this title and choose again.',
  episode_not_aired: 'That episode has not aired yet. Request the series to watch for future episodes.',
  already_available: 'This installment is already available in Negev’s Library.',
  detail_pending: 'Episode details are still being prepared. Please try again shortly.',
  detail_unavailable: 'Episode details are unavailable right now. Please try again.',
  request_cancelled: 'This request was cancelled. Refresh this title before requesting it again.',
  title_not_in_cutover: 'Requests for this title are not open yet. Please use Seerr for now.',
};

export function requestFailureMessage(error) {
  return messages[error?.reason] ?? messages[error?.message] ??
    'The request could not be saved. Please try again.';
}

export function savedRequestMessage(saved) {
  const hasId = Number.isSafeInteger(saved?.requestId) && saved.requestId > 0;
  const receipt = hasId
    ? `Request #${saved.requestId} saved.` : 'Request saved.';
  if (saved?.state === 'pending' && saved.waitingFor === 'release_schedule') {
    return `${receipt} Negev will watch for the release schedule and first episode. Follow it under My Requests.`;
  }
  if (saved?.state === 'pending') {
    return `${receipt} Negev will check the episode list and library before any download. Follow it under My Requests.`;
  }
  return `${receipt} ${hasId ? 'View its progress' : 'Follow it'} under My Requests.`;
}
