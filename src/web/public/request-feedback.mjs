const messages = {
  watch_paused_elsewhere: 'Watching is paused. Ask an administrator to re-enable the existing watch owner, then try again.',
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

export function preparationPresentation(item) {
  if(item.reason==='watch_paused_elsewhere')return {heading:'Watching is paused',body:requestFailureMessage(item)};
  if(item.state==='complete'){
    if(item.reason==='already_available')return {heading:'Already available',body:'Already available in Negev’s Library.'};
    if(item.reason==='already_monitored_elsewhere')return {heading:'Already monitored',body:requestFailureMessage(item)};
    if(item.reason==='ambiguous_movie_scope')return {heading:'Choose a film part',body:'Choose a film part on the title page to request it.'};
    return {heading:'Preparation finished',body:'This title could not be requested automatically.'};
  }
  if(item.state==='resolving')return {heading:'Finishing the request',body:'Finishing the request. Cancellation is unavailable during this step.'};
  if(item.reason==='release_state_unknown')return {heading:'Checking catalogue release dates',body:'Negev cannot confirm this title’s release timing yet. No download has started.'};
  return {heading:'Preparing episode details',body:'Waiting for a verified episode list before any download.'};
}
