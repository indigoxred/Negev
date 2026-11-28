// Only ordered, physically witnessed Parts of one Plex Media combine; versions never do.
export function combinedMultipartProof({ target, files, provenParts }) {
  const groups = new Map();
  for (const part of provenParts) {
    if (!Number.isSafeInteger(part.mediaId) || part.mediaId < 1 || !Number.isSafeInteger(part.ratingKey) || part.ratingKey < 1 || !Number.isSafeInteger(part.partIndex) || part.partIndex < 0 || !Number.isSafeInteger(part.partCount) || part.partCount < 2 || part.partCount > 8) continue;
    const key = [part.libraryId, part.ratingKey, part.mediaId].join(':');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(part);
  }
  for (const parts of groups.values()) {
    parts.sort((a,b) => a.partIndex-b.partIndex);
    const count = parts[0].partCount;
    if (parts.length !== count || parts.some((p,i) => p.partCount !== count || p.partIndex !== i) || ['partId','fileId','storageKey'].some(key => new Set(parts.map(p=>p[key])).size !== count)) continue;
    let end = 0, valid = true;
    for (const part of parts) {
      const matches = files.filter(f => f.fileId === part.fileId && f.storageKey === part.storageKey && f.anidbId === target.anidbId);
      const signatures = new Set(matches.map(f => JSON.stringify(f.coverage)));
      const range = matches[0]?.coverage?.find(r=>r.episodeId === target.episodeId);
      if (signatures.size !== 1 || !range || range.start !== end || !Number.isFinite(range.end) || range.end <= end || range.end > 100) { valid = false; break; }
      end = range.end;
    }
    if (valid && end === 100) return { state:'available', fileId:parts[0].fileId, fileIds:parts.map(p=>p.fileId), multipart:true, proof:{...parts[0],parts} };
  }
  return null;
}

// Membership is meaningful only after the full observer proved availability.
// Retain the composite's ordering and exact physical witness for attribution.
export function includesProvenFile(result, fileId, storageKey) {
  if(result?.state!=='available')return false;
  if(result.multipart!==true)return result.fileId===fileId;
  const parts=result.proof?.parts;
  if(!Array.isArray(parts)||parts.length<2||parts.length>8)return false;
  const first=parts[0];
  if(parts.some((part,i)=>part.partIndex!==i||part.partCount!==parts.length||
      part.libraryId!==first.libraryId||part.ratingKey!==first.ratingKey||part.mediaId!==first.mediaId||
      !Number.isSafeInteger(part.fileId)||part.fileId<1||!Number.isSafeInteger(part.partId)||part.partId<1||
      typeof part.storageKey!=='string'||!part.storageKey))return false;
  if(['fileId','partId','storageKey'].some(key=>new Set(parts.map(part=>part[key])).size!==parts.length))return false;
  return parts.some(part=>part.fileId===fileId&&(storageKey===undefined||part.storageKey===storageKey));
}
