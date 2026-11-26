// Recognition preservation has its own terminal journal; it is not an
// unsent reservation release or a media retirement. All recovery-admission
// readers must agree that only its final `released` state ends the attempt.
export function pendingRecognitionSql(db, alias) {
  if (!/^[a-z_]+$/.test(alias)) throw new TypeError('Invalid attempt alias');
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recognition_recoveries'").get()) return '1=1';
  return `NOT EXISTS (SELECT 1 FROM recognition_recoveries recognition
    WHERE recognition.attempt_id=${alias}.id AND recognition.status='released')`;
}
