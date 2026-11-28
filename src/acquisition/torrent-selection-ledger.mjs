import { exclusiveSubtitleNames } from './exclusive-subtitle-names.mjs';
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
  db.exec(`CREATE TABLE IF NOT EXISTS acquisition_selection_revisions (
    attempt_id INTEGER NOT NULL REFERENCES acquisition_attempts(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, previous_plan_json TEXT NOT NULL,
    remaining_plan_json TEXT NOT NULL, excluded_episode_ids_json TEXT NOT NULL,
    checked_ms INTEGER NOT NULL, revised_ms INTEGER NOT NULL,
    PRIMARY KEY(attempt_id,revision)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS acquisition_selection_excluded_targets (
    attempt_id INTEGER NOT NULL REFERENCES acquisition_attempts(id) ON DELETE CASCADE,
    episode_id INTEGER NOT NULL, excluded_ms INTEGER NOT NULL,
    PRIMARY KEY(attempt_id,episode_id)
  ) STRICT`);
  db.exec(`CREATE TABLE IF NOT EXISTS acquisition_subtitle_selection_revisions (
    attempt_id INTEGER NOT NULL REFERENCES acquisition_attempts(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, previous_excluded_json TEXT NOT NULL,
    remaining_excluded_json TEXT NOT NULL, revised_ms INTEGER NOT NULL,
    PRIMARY KEY(attempt_id,revision)
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
        const attempt = db.prepare('SELECT expected_hash,updated_ms,status FROM acquisition_attempts WHERE id=?').get(attemptId);
        if (!attempt) return held('attempt_missing');
        if (attempt.expected_hash !== hash.toLowerCase()) return held('torrent_conflict');
        const existing = find.get(attemptId);
        if (existing) {
          if(existing.torrent_hash!==hash.toLowerCase()||existing.manifest_json!==manifestJson)return held('torrent_selection_conflict');
          if(existing.excluded_json===excludedJson)return {state:'selection_recorded'};
          if(nowMs<attempt.updated_ms)return held('time_before_last_transition');
          if(db.prepare('SELECT 1 FROM acquisition_starts WHERE attempt_id=?').get(attemptId))return held('torrent_selection_conflict');
          const previous=JSON.parse(existing.excluded_json);
          const videoNames=names=>names.filter(name=>torrentFileKind(name)==='video').sort();
          if(JSON.stringify(videoNames(previous))!==JSON.stringify(videoNames(selection.excludedFileNames)))return held('torrent_selection_conflict');
          const retained=[...db.prepare('SELECT file_name name,file_size size FROM acquisition_file_plans WHERE attempt_id=?').all(attemptId),
            ...db.prepare('SELECT file_name name,size FROM acquisition_bonus_files WHERE attempt_id=? AND excluded_before_start=0').all(attemptId)];
          const retainedNames=new Set(retained.map(file=>file.name));
          if(!retained.length||retained.length!==retainedNames.size||retained.some(file=>!selection.files.some(other=>other.name===file.name&&other.size===file.size)))return held('torrent_selection_conflict');
          const excludedVideos=selection.files.filter(file=>torrentFileKind(file.name)==='video'&&!retainedNames.has(file.name)).map(file=>file.name).sort();
          if(JSON.stringify(excludedVideos)!==JSON.stringify(videoNames(previous)))return held('torrent_selection_conflict');
          const revised=[...excludedVideos,...exclusiveSubtitleNames(selection.files,excludedVideos,[...retainedNames])].sort();
          if(JSON.stringify(revised)!==excludedJson)return held('torrent_selection_conflict');
          // A sent add keeps its original journal and exact observed priorities.
          // Only an unsent reservation can adopt the current sidecar policy.
          if(attempt.status!=='reserved')return {state:'selection_recorded',excludedFileNames:previous};
          const revision=db.prepare('SELECT COALESCE(MAX(revision),0)+1 n FROM acquisition_subtitle_selection_revisions WHERE attempt_id=?').get(attemptId).n;
          db.prepare('INSERT INTO acquisition_subtitle_selection_revisions VALUES (?,?,?,?,?)').run(attemptId,revision,existing.excluded_json,excludedJson,nowMs);
          db.prepare('UPDATE acquisition_torrent_selections SET excluded_json=?,recorded_ms=? WHERE attempt_id=?').run(excludedJson,nowMs,attemptId);
          return {state:'selection_recorded'};
        }
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
