import { durableControl, canonicalReleaseGuid, rememberLegacyControl } from './durable-release-candidate.mjs';
import { initializePreferredReleases, validReleasePreference } from './preferred-release.mjs';
// Private request-local intent, not an alternative download pipeline. Call
// reservationGate inside the acquisition transaction so a stale worker cannot
// race a newly saved manual choice.
export function initializeReleaseControl(db) {
  if (!db.prepare('PRAGMA table_info(requests)').all().some(c => c.name === 'release_control')) {
    db.exec('ALTER TABLE requests ADD COLUMN release_control TEXT');
  }
  initializePreferredReleases(db);
  // Idempotent in-place upgrade of saved identity, never candidate discovery.
  // CAS preserves a simultaneous selection write on another connection.
  for(const row of db.prepare(`SELECT id,release_control FROM requests WHERE release_control IS NOT NULL`).all()) {
    let parsed;try{parsed=JSON.parse(row.release_control);}catch{continue;}
    rememberLegacyControl(db,parsed);
    const clean=JSON.stringify(durableControl(parsed));
    db.prepare('UPDATE requests SET release_control=? WHERE id=? AND release_control=?').run(clean,row.id,row.release_control);
  }
}
export function sameReleaseFiles(left,right) {
  const normalize=files=>{
    if(!Array.isArray(files)||!files.length||files.some(f=>typeof f?.name!=='string'||
      !Number.isSafeInteger(f.size)||f.size<1||!Array.isArray(f.episodeIds)||!f.episodeIds.length))return null;
    if(new Set(files.map(f=>f.name)).size!==files.length)return null;
    return files.map(f=>({name:f.name,size:f.size,episodeIds:[...f.episodeIds].sort((a,b)=>a-b)}))
      .sort((a,b)=>a.name.localeCompare(b.name));
  };
  const a=normalize(left),b=normalize(right);
  return a!==null&&b!==null&&JSON.stringify(a)===JSON.stringify(b);
}
export function readReleaseControl(db, id, nowMs) {
  const raw = db.prepare('SELECT release_control FROM requests WHERE id=?').get(id)?.release_control;
  if (!raw) return {mode:'auto',phase:'consumed',revision:0};
  const parsed = JSON.parse(raw);
  rememberLegacyControl(db,parsed);
  const control = durableControl(parsed);
  const clean = JSON.stringify(control);
  if (clean !== raw) {
    db.prepare('UPDATE requests SET release_control=? WHERE id=? AND release_control=?').run(clean,id,raw);
    return readReleaseControl(db,id,nowMs);
  }
  if (control.mode === 'auto' && control.expiresMs <= nowMs &&
      ['proposal','selecting'].includes(control.phase)) {
    const next = {mode:'auto',phase:control.proposal ? 'chosen' : 'consumed',
      revision:control.revision+1,
      ...(control.preference!==undefined?{preference:control.preference}:{}),
      ...(control.proposal ? {selection:control.proposal.registered} : {})};
    db.prepare('UPDATE requests SET release_control=? WHERE id=? AND release_control=?')
      .run(JSON.stringify(next),id,raw);
    return readReleaseControl(db,id,nowMs);
  }
  return control;
}
export function updateReleaseControl(db,id,revision,next,nowMs) {
  if (!Number.isSafeInteger(id) || id<1 || !Number.isSafeInteger(revision) || revision<0 ||
      !Number.isSafeInteger(nowMs) || nowMs<0 || !['auto','manual'].includes(next?.mode) ||
      !['selecting','chosen','proposal','consumed'].includes(next?.phase) ||
      (next.preference!==undefined&&!validReleasePreference(next.preference)) ||
      (next.phase==='chosen' && !validSelection(next.selection)) ||
      (next.phase==='proposal' && (!validSelection(next.proposal?.registered) ||
        !validSelection(next.proposal?.better))) ||
      (['selecting','proposal'].includes(next.phase) && next.mode==='auto' &&
        (!Number.isSafeInteger(next.expiresMs) || next.expiresMs<=nowMs || next.expiresMs>nowMs+300_000))) {
    return {state:'held',reason:'invalid_release_selection'};
  }
  const current=readReleaseControl(db,id,nowMs);
  if (current.revision!==revision) return {state:'held',reason:'stale_release_selection'};
  const row=db.prepare('SELECT cancelled_ms,release_control FROM requests WHERE id=?').get(id);
  if (!row || row.cancelled_ms!==null) return {state:'held',reason:'request_missing'};
  // Do not alter a selection whose submission has already reserved its files.
  const selectedTargets=next.selection?.preview?.episodeIds??[];
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='acquisition_target_claims'").get() &&
      db.prepare(`SELECT c.episode_id,a.status FROM acquisition_target_claims c JOIN acquisition_attempts a ON a.id=c.attempt_id
        WHERE a.request_id=? AND c.active=1`).all(id).some(row=>
          row.status!=='torrent_observed'||selectedTargets.includes(row.episode_id))) {
    return {state:'held',reason:'release_already_processing'};
  }
  rememberLegacyControl(db,next);
  const value={...durableControl(next),...(next.preference===undefined&&current.preference!==undefined?{preference:current.preference}:{}),revision:revision+1};
  const changed=db.prepare('UPDATE requests SET release_control=? WHERE id=? AND release_control IS ?')
    .run(JSON.stringify(value),id,row.release_control).changes;
  return changed ? {state:'updated',control:value} : {state:'held',reason:'stale_release_selection'};
}
export function updateReleasePreference(db,id,revision,preference,nowMs) {
  if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(revision)||revision<0||
      !Number.isSafeInteger(nowMs)||nowMs<0||!validReleasePreference(preference))return {state:'held',reason:'invalid_release_preference'};
  const row=db.prepare('SELECT cancelled_ms,release_control FROM requests WHERE id=?').get(id);
  if(!row||row.cancelled_ms!==null)return {state:'held',reason:'request_missing'};
  const current=readReleaseControl(db,id,nowMs);
  if(current.revision!==revision)return {state:'held',reason:'stale_release_selection'};
  const control={...current,preference,revision:revision+1};
  db.prepare('UPDATE requests SET release_control=? WHERE id=?').run(JSON.stringify(control),id);
  if(preference===null)db.prepare('UPDATE preferred_release_waits SET closed_ms=? WHERE request_id=? AND closed_ms IS NULL AND first_seen_ms<=?').run(nowMs,id,nowMs);
  return {state:'updated',control};
}
function validSelection(s) {
  return typeof s?.candidate?.guid==='string' && s.candidate.guid.length>0 &&
    Number.isSafeInteger(s.candidate.indexerId) && s.candidate.indexerId>0 &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(s.preview?.torrentHash) &&
    Array.isArray(s.preview.episodeIds) && s.preview.episodeIds.length>0 &&
    Array.isArray(s.preview.files) && s.preview.files.length>0;
}
export function releaseReservationGate(db,id,candidate,episodeIds,nowMs,preparedHash,plannedFiles) {
  // Old diagnostic databases need no migration just to read their attempts.
  if (!db.prepare('PRAGMA table_info(requests)').all().some(c=>c.name==='release_control')) return null;
  const control=readReleaseControl(db,id,nowMs);
  if (['selecting','proposal'].includes(control.phase)) return 'release_selection_pending';
  if (control.phase!=='chosen') return null;
  const s=control.selection;
  if (s.candidate.indexerId!==candidate.indexerId || canonicalReleaseGuid(s.candidate.guid,s.candidate.indexerId)!==canonicalReleaseGuid(candidate.guid,candidate.indexerId) ||
      s.candidate.title!==candidate.title || s.candidate.size!==candidate.size ||
      episodeIds.some(id=>!s.preview.episodeIds.includes(id)) ||
      preparedHash?.toLowerCase()!==s.preview.torrentHash ||
      !sameReleaseFiles(plannedFiles,s.preview.files)) return 'release_choice_changed';
  return null;
}
