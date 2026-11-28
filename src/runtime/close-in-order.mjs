// Finish each dependency before the next one. A failed close is reported only
// after all remaining resources have had their turn to stop and close.
export async function closeInOrder(steps) {
  if (!Array.isArray(steps) || steps.some(step => !Array.isArray(step) ||
      typeof step[0] !== 'string' || typeof step[1] !== 'function')) {
    throw new TypeError('Invalid cleanup steps');
  }
  const errors = [];
  for (const [name, close] of steps) {
    try { await close(); }
    catch (cause) { errors.push(new Error(`${name} did not close`, { cause })); }
  }
  if (errors.length) throw new AggregateError(errors,
    `Cleanup failed: ${errors.map(error => error.message).join('; ')}`);
}

// Event emitters do not await signal listeners. Handle the single shutdown
// promise here so neither a close failure nor a reporting failure escapes it.
export function createShutdownListener(stop, report) {
  if (typeof stop !== 'function' || typeof report !== 'function') throw new TypeError('Invalid shutdown listener');
  let completion;
  return () => completion ??= Promise.resolve().then(stop).catch(async error => {
    try { await report(error); } catch { /* Reporting cannot interrupt cleanup. */ }
  });
}
