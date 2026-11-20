import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const deterministic = new Set(['release_title_mismatch', 'shoko_preview_wrong_identity',
  'targeted_result_wrong_episode', 'shoko_video_format_unsupported',
  'related_installment_mismatch', 'invalid_metainfo', 'unsafe_torrent_path',
  'unsafe_file_type', 'duplicate_episode', 'ambiguous_episode_numbering']);
for (const reason of ['ambiguous_catalogue_number','ambiguous_movie_scope',
  'ambiguous_or_unrequested_video','ambiguous_pack_numbering','no_requested_video',
  'unsafe_or_unselected_file','video_budget_exceeded','conflicting_file_views',
  'invalid_piece_list','unsupported_torrent_version']) deterministic.add(reason);
const fields = ['state', 'reason', 'requestId', 'anidbId', 'searchQuery', 'identityTitle',
  'torrentHash', 'shokoPreview', 'shokoPreviewConflict', 'correspondence', 'version', 'totalBytes',
  'episodeIds', 'files', 'subtitles', 'filesToExclude', 'registeredInAniDb', 'downloadStarted'];
const keyFor = ({ request, candidate }) => createHash('sha256').update(JSON.stringify([
  'candidate-check-v3', request.id, request.anidbId, request.kind,
  [...request.episodeIds].sort((a, b) => a - b), candidate.indexerId,
  request.title, candidate.guid, candidate.title, candidate.size,
  candidate.sourceQuery, candidate.targetEpisodeId,
])).digest('hex');

// Private bounded memo of read-only checks, never a dispatch authorization.
// No raw GUID, download URL, credential or torrent bytes are persisted.
export function openCandidateCheckCache(dbPath, { now = Date.now } = {}) {
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  db.exec(`CREATE TABLE IF NOT EXISTS acquisition_candidate_checks (
    cache_key TEXT PRIMARY KEY, anidb_id INTEGER NOT NULL,
    targets_json TEXT NOT NULL, result_json TEXT NOT NULL,
    checked_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL
  ) STRICT`);
  const get = db.prepare('SELECT result_json FROM acquisition_candidate_checks WHERE cache_key=? AND expires_ms>?');
  const put = db.prepare(`INSERT INTO acquisition_candidate_checks VALUES (?,?,?,?,?,?)
    ON CONFLICT(cache_key) DO UPDATE SET result_json=excluded.result_json,
    checked_ms=excluded.checked_ms,expires_ms=excluded.expires_ms`);
  const prune = db.prepare(`DELETE FROM acquisition_candidate_checks WHERE cache_key IN
    (SELECT cache_key FROM acquisition_candidate_checks ORDER BY checked_ms DESC LIMIT -1 OFFSET 512)`);
  const invalidate = db.prepare(`DELETE FROM acquisition_candidate_checks WHERE anidb_id=?
    AND EXISTS (SELECT 1 FROM json_each(targets_json) WHERE value=?)`);
  db.prepare('DELETE FROM acquisition_candidate_checks WHERE expires_ms<=?').run(now());
  return {
    get(input) {
      const row = get.get(keyFor(input), now());
      try { return row ? JSON.parse(row.result_json) : null; } catch { return null; }
    },
    put({ request, candidate, result }) {
      const positive = result?.state === 'preflight';
      if (!positive && !(result?.state === 'held' && deterministic.has(result.reason))) return;
      const safe = Object.fromEntries(fields.filter(key => result[key] !== undefined)
        .map(key => [key, result[key]]));
      const json = JSON.stringify(safe);
      if (Buffer.byteLength(json) > 64_000) return;
      const checkedMs = now();
      put.run(keyFor({ request, candidate }), request.anidbId,
        JSON.stringify(positive ? result.episodeIds : request.episodeIds), json, checkedMs,
        checkedMs + (positive ? 15 * 60_000 : 6 * 3_600_000));
      prune.run();
    },
    invalidateTarget({ anidbId, episodeId }) { invalidate.run(anidbId, episodeId); },
    invalidateTitle(anidbId) {
      db.prepare('DELETE FROM acquisition_candidate_checks WHERE anidb_id=?').run(anidbId);
    },
    close() { db.close(); },
  };
}
