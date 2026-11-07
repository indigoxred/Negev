import { createHash } from 'node:crypto';

const fingerprint = (value) => typeof value === 'string' &&
  /^[0-9a-f]{64}$/.test(value);

// A quiet manual Import folder does not make a separate automated Source
// folder quiet. Both observations must pass before the first-time fence.
export function combineImportActivity(manual, automated, withFingerprint = false) {
  if (manual?.state === 'unavailable' || automated?.state === 'unavailable' ||
      !manual?.state || !automated?.state) return { state: 'unavailable' };
  if (manual.state === 'busy' || automated.state === 'busy') {
    // Keep one source's reason for the admin diagnostic. If both sources are
    // busy, a single reason would incorrectly imply which one holds Import.
    const source = manual.state === 'busy' && automated.state !== 'busy'
      ? manual : automated.state === 'busy' && manual.state !== 'busy'
        ? automated : null;
    return { state: 'busy',
      ...(typeof source?.reason === 'string' ? { reason: source.reason } : {}) };
  }
  if (manual.state !== 'quiet_observed') return { state: manual.state };
  if (automated.state !== 'quiet_observed') return { state: automated.state };
  if (!withFingerprint) return { state: 'quiet_observed' };
  if (!fingerprint(manual.fingerprint) ||
      !fingerprint(automated.fingerprint) ||
      (automated.unrelatedPendingKeys !== undefined &&
       (!Array.isArray(automated.unrelatedPendingKeys) ||
        automated.unrelatedPendingKeys.length > 128))) {
    return { state: 'unavailable' };
  }
  return { state: 'quiet_observed',
    fingerprint: createHash('sha256').update(`${manual.fingerprint}:${automated.fingerprint}`)
      .digest('hex'),
    unrelatedPendingKeys: automated.unrelatedPendingKeys ?? [] };
}
