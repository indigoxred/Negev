import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { assessRelease } from './release-preference.mjs';
export const transientInspectionFailure = result => !result || !['held','preflight','inspection'].includes(result.state) || result.state==='preflight'&&(!Array.isArray(result.episodeIds)||!result.episodeIds.length||!Array.isArray(result.files)||!result.files.length) || result.state==='held' && ['provider_unavailable','torrent_preflight_unavailable','related_title_unavailable','shoko_settings_unavailable','metadata_reader_busy','detail_unavailable','candidate_changed','torrent_unavailable'].includes(result.reason);
const key=c=>createHash('sha256').update(JSON.stringify([c.indexerId,c.guid])).digest('hex');
// Only failed inspection hints are retained, never an authorization to submit.
// Three spaced checks or three elapsed minutes release the quality preference.
export function openQualityInspectionRetry(dbPath=':memory:') {
  const db=new DatabaseSync(dbPath,{timeout:5000});
  db.exec(`CREATE TABLE IF NOT EXISTS acquisition_quality_retry (
    request_id INTEGER NOT NULL, scope TEXT NOT NULL, candidate_key TEXT NOT NULL,
    quality INTEGER NOT NULL, targets TEXT NOT NULL, first_ms INTEGER NOT NULL,
    last_ms INTEGER NOT NULL, attempts INTEGER NOT NULL,
    PRIMARY KEY(request_id,candidate_key)) STRICT`);
  const scopeFor=r=>createHash('sha256').update(JSON.stringify([r.anidbId,r.kind,[...r.episodeIds].sort((a,b)=>a-b)])).digest('hex');
  const active=(r,ms)=>r.attempts<3&&ms-r.first_ms<180000;
  const rows=(request,ms)=>{
    const scope=scopeFor(request);
    db.prepare('DELETE FROM acquisition_quality_retry WHERE request_id=? AND (scope<>? OR last_ms<? OR first_ms>?)').run(request.id,scope,ms-900000,ms);
    return db.prepare('SELECT * FROM acquisition_quality_retry WHERE request_id=? ORDER BY first_ms,candidate_key LIMIT 50').all(request.id);
  };
  return {
    fail(request,candidate,ms) {
      rows(request,ms);const candidateKey=key(candidate);
      const old=db.prepare('SELECT * FROM acquisition_quality_retry WHERE request_id=? AND candidate_key=?').get(request.id,candidateKey);
      if(old&&ms-old.last_ms<60000)return;
      const targets=Number.isSafeInteger(candidate.targetEpisodeId)&&candidate.targetedEpisode===true?[candidate.targetEpisodeId]:request.episodeIds;
      db.prepare(`INSERT INTO acquisition_quality_retry VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(request_id,candidate_key) DO UPDATE SET last_ms=excluded.last_ms,attempts=acquisition_quality_retry.attempts+1`).run(request.id,scopeFor(request),candidateKey,assessRelease(candidate).quality,JSON.stringify(targets),ms,ms,1);
      db.prepare(`DELETE FROM acquisition_quality_retry WHERE request_id=? AND candidate_key NOT IN (SELECT candidate_key FROM acquisition_quality_retry WHERE request_id=? ORDER BY first_ms,candidate_key LIMIT 50)`).run(request.id,request.id);
    },
    resolve(request,candidate){db.prepare('DELETE FROM acquisition_quality_retry WHERE request_id=? AND candidate_key=?').run(request.id,key(candidate))},
    protects(request,candidate,episodeIds,ms){return rows(request,ms).some(r=>active(r,ms)&&r.quality>assessRelease(candidate).quality&&JSON.parse(r.targets).some(id=>episodeIds.includes(id)))},
    pending(request,ms){return rows(request,ms).some(r=>active(r,ms))},
    close(){db.close()},
  };
}
