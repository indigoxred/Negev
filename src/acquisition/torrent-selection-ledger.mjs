import { torrentFileKind } from './evaluate-stopped-manifest.mjs';
import { MAX_TORRENT_FILES } from './torrent-file-limits.mjs';

const held = reason => ({ state: 'held', reason });
function canonical(files, excludedFileNames = []) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_TORRENT_FILES ||
      !Array.isArray(excludedFileNames) || excludedFileNames.length > MAX_TORRENT_FILES) {
    throw new TypeError('Invalid torrent selection');
  }
  const names = new Set();
  const manifest = files.map(file => {
    if (typeof file?.name !== 'string' || file.name.length > 1000 ||
        !['video', 'subtitle', 'passive'].includes(torrentFileKind(file.name)) ||
        !Number.isSafeInteger(file.size) || file.size < 1 ||
        names.has(file.name.toLowerCase())) throw new TypeError('Invalid torrent selection file');
    names.add(file.name.toLowerCase());
    return { name: file.name, size: file.size };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const exactNames = new Set(manifest.map(file => file.name));
  if (new Set(excludedFileNames).size !== excludedFileNames.length ||
      excludedFileNames.some(name => !exactNames.has(name) ||
        !['video', 'subtitle'].includes(torrentFileKind(name)))) {
    throw new TypeError('Invalid torrent selection exclusion');
  }
  return { files: manifest, excludedFileNames: [...excludedFileNames].sort() };
}

// Retain the exact descriptor file universe before an add. Recovery must not
// derive exclusions from whatever files a downloader happens to report later.
export function createTorrentSelectionLedger(db, transact) {
  db.exec(`CREATE TABLE IF NOT EXISTS acquisition_torrent_selections (
    attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id) ON DELETE CASCADE,
    torrent_hash TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    excluded_json TEXT NOT NULL,
    recorded_ms INTEGER NOT NULL CHECK(recorded_ms>=0)
  ) STRICT`);
  const find = db.prepare('SELECT * FROM acquisition_torrent_selections WHERE attempt_id=?');
  return {
    recordTorrentSelection({ attemptId, hash, files, excludedFileNames = [], nowMs }) {
      if (!Number.isSafeInteger(attemptId) || attemptId < 1 ||
          typeof hash !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(hash) ||
          !Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('Invalid selection intent');
      const selection = canonical(files, excludedFileNames);
      const manifestJson = JSON.stringify(selection.files), excludedJson = JSON.stringify(selection.excludedFileNames);
      return transact(() => {
        const attempt = db.prepare('SELECT expected_hash,updated_ms FROM acquisition_attempts WHERE id=?').get(attemptId);
        if (!attempt) return held('attempt_missing');
        if (attempt.expected_hash !== hash.toLowerCase()) return held('torrent_conflict');
        const existing = find.get(attemptId);
        if (existing) return existing.torrent_hash === hash.toLowerCase() &&
          existing.manifest_json === manifestJson && existing.excluded_json === excludedJson
          ? { state: 'selection_recorded' } : held('torrent_selection_conflict');
        if (nowMs < attempt.updated_ms) return held('time_before_last_transition');
        if (db.prepare('SELECT 1 FROM acquisition_starts WHERE attempt_id=?').get(attemptId)) return held('start_already_recorded');
        db.prepare('INSERT INTO acquisition_torrent_selections VALUES (?,?,?,?,?)')
          .run(attemptId, hash.toLowerCase(), manifestJson, excludedJson, nowMs);
        return { state: 'selection_recorded' };
      });
    },
    getTorrentSelection(attemptId) {
      if (!Number.isSafeInteger(attemptId) || attemptId < 1) throw new TypeError('Invalid selection attempt');
      const row = find.get(attemptId);
      if (!row) return null;
      const selection = canonical(JSON.parse(row.manifest_json), JSON.parse(row.excluded_json));
      return { torrentHash: row.torrent_hash, ...selection };
    },
  };
}
