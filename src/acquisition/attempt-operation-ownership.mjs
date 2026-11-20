// The service has one acquisition ledger and one writer process. Durable
// dispatch/start intents survive a crash; only live asynchronous operations
// belong here. A restart drops ownership so exact-hash recovery can proceed.
const owners = new WeakMap();

export function acquireAttemptOperation(ledger, attemptId) {
  if (!ledger || typeof ledger !== 'object' ||
      !Number.isSafeInteger(attemptId) || attemptId < 1) {
    throw new TypeError('Invalid attempt ownership');
  }
  let active = owners.get(ledger);
  if (!active) { active = new Set(); owners.set(ledger, active); }
  if (active.has(attemptId)) return null;
  active.add(attemptId);
  let released = false;
  return () => {
    if (!released) { released = true; active.delete(attemptId); }
  };
}
