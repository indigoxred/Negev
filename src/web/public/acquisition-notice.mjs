export function acquisitionNotice(state) {
  if (state === 'waiting_with_review') {
    return 'Automatic acquisition is enabled. Some items need review; other requests continue.';
  }
  if (state === 'waiting' || state === 'running') {
    return 'Requests are reviewed automatically. Safety checks can hold a release before download or import.';
  }
  if (state === 'disabled') return 'Automatic acquisition is off.';
  if (state === 'unknown') {
    return 'Automatic acquisition status is unavailable.';
  }
  return 'Automatic acquisition is paused while its safety checks recover.';
}
