// Recognition preservation has its own terminal journal; it is not an
// unsent reservation release or a media retirement. All recovery-admission
// readers must agree that only its final `released` state ends the attempt.
export function pendingRecognitionSql(db, alias) {
  if (!/^[a-z_]+$/.test(alias)) throw new TypeError('Invalid attempt alias');
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recognition_recoveries'").get()) return '1=1';
  return `NOT EXISTS (SELECT 1 FROM recognition_recoveries recognition
    WHERE recognition.attempt_id=${alias}.id AND recognition.status='released')`;
}

// One definition for queue resumption and its read-only member warning.
// Inactive ownership alone cannot resolve an attempt; an observed retained
// attempt still needs its saved hash and at least one active owned target.
export function unreconciledAttemptSql(db, alias) {
  const pending = pendingRecognitionSql(db, alias);
  const ended = ['acquisition_releases', 'acquisition_retirements']
    .filter(table => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    .map(table => `NOT EXISTS (SELECT 1 FROM ${table} ended WHERE ended.attempt_id=${alias}.id)`);
  const claims = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='acquisition_target_claims'").get();
  const unobserved = claims
    ? `(${alias}.status<>'torrent_observed' OR ${alias}.torrent_hash IS NULL OR
        NOT EXISTS (SELECT 1 FROM acquisition_target_claims owned
          WHERE owned.attempt_id=${alias}.id AND owned.active=1))`
    : '1=1';
  return [pending, ...ended, unobserved].join(' AND ');
}
