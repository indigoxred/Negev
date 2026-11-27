// Many workers turn an exception into a durable "held" reason and retry
// later. That is deliberate, but the exception itself used to be dropped, so
// the log could not say why something was held. heldReporter(scope) returns
// a function that keeps the same held result and reports the error once per
// scope, reason and message every ten minutes. Reporting is off until the
// server installs a writer (see src/web/user-server.mjs).
const REPEAT_MS = 10 * 60 * 1000;
const MAX_REMEMBERED = 500;
let writer = null;
let clock = Date.now;
const lastReported = new Map();

const redact = (text) => String(text ?? '')
  .replace(/([?&](?:x-plex-token|apikey|api_key|token|password|sid)=)[^&\s]+/gi, '$1[redacted]')
  .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, '$1 [redacted]');

export function setHeldDiagnostics(write, { now = Date.now } = {}) {
  if (write !== null && typeof write !== 'function') throw new TypeError('Invalid diagnostics writer');
  writer = write;
  clock = now;
  lastReported.clear();
}

export function heldReporter(scope) {
  if (typeof scope !== 'string' || !scope) throw new TypeError('Invalid diagnostics scope');
  return (error, reason, extra = {}) => {
    if (writer) {
      const message = redact(error?.message ?? error).slice(0, 300);
      const key = `${scope}\0${reason}\0${message}`;
      const at = clock();
      const previous = lastReported.get(key);
      if (previous === undefined || at - previous >= REPEAT_MS) {
        lastReported.delete(key);
        lastReported.set(key, at);
        while (lastReported.size > MAX_REMEMBERED) lastReported.delete(lastReported.keys().next().value);
        try {
          writer({ scope, reason, error: `${error?.name ?? 'Error'}: ${message}` });
        } catch { /* Reporting must never change the held result. */ }
      }
    }
    return { state: 'held', reason, ...extra };
  };
}
