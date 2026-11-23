const id=x=>Number.isSafeInteger(x)&&x>0;
export function compositeComponents(proof,revision,checkedMs) {
 const parts=proof.parts,sources=revision.sources;
 if(!Array.isArray(parts)||parts.length<2||parts.length>8||!Array.isArray(sources)||sources.length!==parts.length||new Set(sources.map(s=>s.fileId)).size!==parts.length) return null;
 if(parts[0].fileId!==proof.fileId||parts[0].partId!==proof.partId||parts[0].storageKey!==proof.storageKey||!id(parts[0].mediaId))return null;
 if(['fileId','partId','storageKey'].some(k=>new Set(parts.map(p=>p[k])).size!==parts.length))return null;
 let indexed;try{indexed=JSON.parse(revision.card.identitySignature)[1];}catch{return null;}
 if(!Array.isArray(indexed))return null;
 const media=indexed.filter(p=>p[7]===parts[0].mediaId);
 if(media.length!==parts.length)return null;
 const result=[];for(const [i,p]of parts.entries()) {
  const source=sources.find(s=>s.fileId===p.fileId);
  if(!id(p.fileId)||!id(p.partId)||p.libraryId!==proof.libraryId||p.ratingKey!==proof.ratingKey||p.mediaId!==parts[0].mediaId||p.partIndex!==i||p.partCount!==parts.length||!/^\d+:[1-9]\d*:[1-9]\d*$/.test(p.storageKey)||p.storageKey.length>128||typeof source?.updated!=='string'||!Number.isFinite(Date.parse(source.updated))||!Number.isSafeInteger(source.observedMs)||source.observedMs<0||source.observedMs>checkedMs)return null;
  if(!media.some(row=>row[0]===p.partId&&row[6]===p.storageKey&&row[8]===i&&row[9]===parts.length))return null;
  result.push({...p,sourceUpdated:source.updated,sourceObservedMs:source.observedMs,cardObservedMs:revision.card.observedMs,cardSignature:revision.card.identitySignature});
 }return result;
}
export function pruneCompositeProofs(db,anidbId,episodeId) {
 const scope='components_json IS NOT NULL AND (? IS NULL OR anidb_id=?) AND (? IS NULL OR episode_id=?)';
 const args=[anidbId,anidbId,episodeId,episodeId];
 const n=db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('shoko_inventory_files','shoko_inventory_pairs','plex_card_observations','plex_part_candidates')").get().n;
 if(n!==4){db.prepare('DELETE FROM file_availability_proofs WHERE '+scope).run(...args);return;}
 db.prepare(`DELETE FROM file_availability_proofs AS a WHERE ${scope} AND EXISTS(SELECT 1 FROM json_each(a.components_json) j WHERE NOT EXISTS(
 SELECT 1 FROM shoko_inventory_files f JOIN shoko_inventory_pairs e ON e.file_id=f.file_id
 JOIN plex_card_observations c ON c.library_id=a.library_id AND c.rating_key=a.rating_key
 JOIN plex_part_candidates p ON p.library_id=c.library_id AND p.rating_key=c.rating_key
 WHERE f.file_id=json_extract(j.value,'$.fileId') AND f.state='linked' AND f.updated=json_extract(j.value,'$.sourceUpdated') AND f.observed_ms>=json_extract(j.value,'$.sourceObservedMs')
 AND e.anidb_id=a.anidb_id AND e.episode_id=a.episode_id AND c.observed_ms>=json_extract(j.value,'$.cardObservedMs') AND c.identity_signature=json_extract(j.value,'$.cardSignature')
 AND p.part_id=json_extract(j.value,'$.partId') AND p.candidate_key=json_extract(j.value,'$.storageKey')))`).run(...args);
}
