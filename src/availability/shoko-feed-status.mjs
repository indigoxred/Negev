// Log only transport state changes; event payloads and credentials stay private.
export function createShokoFeedStatusReporter({
  write = (message) => process.stdout.write(message),
} = {}) {
  if (typeof write !== 'function') throw new TypeError('Invalid status writer');
  let state;
  return (reason) => {
    const next = reason === 'feed_started' || reason === 'feed_reconnected'
      ? 'connected' : reason === 'feed_disconnected' ? 'disconnected' : null;
    if (!next || state === next) return;
    state = next;
    write(`Shoko file feed ${next}\n`);
  };
}
