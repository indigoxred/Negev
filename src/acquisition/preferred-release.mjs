import { durableSelection, rememberLegacySelection } from './durable-release-candidate.mjs';
import { releaseFacts } from '../web/public/release-choice-fields.mjs';
import { compareReleases, compareReleaseRecognitionTier } from './release-preference.mjs';

export const PREFERRED_GROUP_WAIT_MS = 2 * 60 * 60_000;
const key = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : '';
export const matchesPreferredGroup = (candidate, group) => !!key(group) && key(releaseFacts(candidate?.title).group) === key(group);
export const validPreferredGroup = value => typeof value === 'string' && value.length > 0 && value.length <= 80 &&
  value.trim() === value && !/[\x00-\x1f\x7f/\\:<>]/.test(value) && !!key(value);
export const validReleasePreference = value => value === null || value && validPreferredGroup(value.group) &&
  ['japanese','dual','english'].includes(value.audio) && Number.isSafeInteger(value.createdMs) && value.createdMs >= 0 &&
  Array.isArray(value.knownEpisodeIds) && value.knownEpisodeIds.length <= 2000 &&
  value.knownEpisodeIds.every(id => Number.isSafeInteger(id) && id > 0);

export function initializePreferredReleases(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS preferred_release_waits (
    request_id INTEGER NOT NULL REFERENCES requests(id),
    episode_id INTEGER NOT NULL CHECK(episode_id>0),
    first_seen_ms INTEGER NOT NULL CHECK(first_seen_ms>=0),
    deadline_ms INTEGER NOT NULL CHECK(deadline_ms>=first_seen_ms),
    closed_ms INTEGER CHECK(closed_ms>=first_seen_ms),
    fallback_json TEXT NOT NULL,
    PRIMARY KEY(request_id,episode_id)
  ) STRICT`);
  for(const row of db.prepare(`SELECT request_id,episode_id,fallback_json FROM preferred_release_waits`).all()) {
    let parsed;try{parsed=JSON.parse(row.fallback_json);}catch{continue;}
    rememberLegacySelection(db,parsed);
    const clean=JSON.stringify(durableSelection(parsed));
    db.prepare('UPDATE preferred_release_waits SET fallback_json=? WHERE request_id=? AND episode_id=? AND fallback_json=?').run(clean,row.request_id,row.episode_id,row.fallback_json);
  }
}
export function checkPreferredRelease(db, preference, { requestId, candidate, preview, releaseState, nowMs }) {
  if (!preference || releaseState === 'completed' || matchesPreferredGroup(candidate, preference.group)) return { state: 'ready' };
  const watch = db.prepare('SELECT monitor_future,watch_closed,cancelled_ms FROM requests WHERE id=?').get(requestId);
  if (!watch || !watch.monitor_future || watch.watch_closed || watch.cancelled_ms !== null) return { state: 'ready' };
  const fresh = preview.episodeIds.filter(id => !preference.knownEpisodeIds.includes(id));
  if (!fresh.length) return { state: 'ready' };
  const known = db.prepare(`SELECT 1 FROM request_targets rt JOIN targets t ON t.id=rt.target_id
    WHERE rt.request_id=? AND t.episode_id=?`);
  if (fresh.some(id => !known.get(requestId,id))) return { state: 'held', reason: 'target_not_requested' };
  rememberLegacySelection(db,{candidate,preview});
  const saved = JSON.stringify(durableSelection({ candidate, preview }));
  if (saved.length > 1_000_000) return { state: 'held', reason: 'invalid_preferred_release' };
  let retryAtMs = null;
  for (const id of fresh) {
    db.prepare(`INSERT INTO preferred_release_waits(request_id,episode_id,first_seen_ms,deadline_ms,fallback_json)
      VALUES(?,?,?,?,?) ON CONFLICT(request_id,episode_id) DO NOTHING`)
      .run(requestId,id,nowMs,nowMs+PREFERRED_GROUP_WAIT_MS,saved);
    const row = db.prepare('SELECT deadline_ms,closed_ms,fallback_json FROM preferred_release_waits WHERE request_id=? AND episode_id=?').get(requestId,id);
    try {
      const prior=JSON.parse(row.fallback_json);
      const registered=p=>p.files?.length>0&&p.files.every(f=>p.correspondence?.files?.some(e=>e.name===f.name&&e.size===f.size&&['likely','previously_verified'].includes(e.state)));
      const tier=compareReleaseRecognitionTier(candidate,prior.candidate);
      const better=tier<0 || tier===0&&(registered(preview)&&!registered(prior.preview)||
        registered(preview)===registered(prior.preview)&&compareReleases(candidate,prior.candidate)<0);
      if(better)db.prepare('UPDATE preferred_release_waits SET fallback_json=? WHERE request_id=? AND episode_id=?').run(saved,requestId,id);
    }catch{/* The newly observed valid fallback can replace an unreadable old record. */
      db.prepare('UPDATE preferred_release_waits SET fallback_json=? WHERE request_id=? AND episode_id=?').run(saved,requestId,id);
    }
    if (row.closed_ms === null && row.deadline_ms > nowMs) retryAtMs = Math.min(retryAtMs ?? Infinity,row.deadline_ms);
  }
  return retryAtMs === null ? { state: 'ready' } : { state: 'held', reason: 'preferred_group_wait', retryAtMs };
}
export function getPreferredFallback(db, requestId, episodeIds, nowMs, includePending=false) {
  const rows = db.prepare(`SELECT episode_id,fallback_json FROM preferred_release_waits
    WHERE request_id=? AND closed_ms IS NULL AND (?=1 OR deadline_ms<=?)
    AND episode_id IN (${episodeIds.map(()=>'?').join(',')||'NULL'}) ORDER BY deadline_ms,episode_id LIMIT 50`).all(requestId,Number(includePending),nowMs,...episodeIds);
  let strongest=null;
  for (const row of rows) {
    if (!episodeIds.includes(row.episode_id)) continue;
    try { const saved=durableSelection(JSON.parse(row.fallback_json));
      const clean=JSON.stringify(saved);
      if(clean!==row.fallback_json)db.prepare('UPDATE preferred_release_waits SET fallback_json=? WHERE request_id=? AND episode_id=? AND fallback_json=?').run(clean,requestId,row.episode_id,row.fallback_json);
      if (includePending?saved.preview.episodeIds.some(id=>episodeIds.includes(id)):
          saved.preview.episodeIds.every(id=>episodeIds.includes(id))){
        if(!strongest||compareReleases(saved.candidate,strongest.candidate)<0)strongest=saved;
      }
    } catch { /* An unusable historical observation never authorizes a grab. */ }
  }
  return strongest;
}
export function closePreferredWaits(db, requestId, episodeIds, nowMs) {
  for (const id of episodeIds) db.prepare(`UPDATE preferred_release_waits SET closed_ms=?
    WHERE request_id=? AND episode_id=? AND closed_ms IS NULL AND first_seen_ms<=?`).run(nowMs,requestId,id,nowMs);
}
export function getPreferredWait(db, requestId, group, nowMs) {
  if (!group) return null;
  const row=db.prepare(`SELECT episode_id AS episodeId,deadline_ms AS deadlineMs FROM preferred_release_waits
    WHERE request_id=? AND closed_ms IS NULL AND deadline_ms>? ORDER BY deadline_ms LIMIT 1`).get(requestId,nowMs);
  return row ? {...row,group} : null;
}
export function preferredWaitDuration(db, requestId, fromMs, toMs) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='preferred_release_waits'").get()) return 0;
  const spans=db.prepare(`SELECT first_seen_ms AS start,MIN(deadline_ms,COALESCE(closed_ms,?)) AS end
    FROM preferred_release_waits WHERE request_id=? ORDER BY first_seen_ms`).all(toMs,requestId);
  let total=0,until=fromMs;
  for(const span of spans){const start=Math.max(fromMs,span.start,until),end=Math.min(toMs,span.end);
    if(end>start){total+=end-start;until=end;}}
  return total;
}
